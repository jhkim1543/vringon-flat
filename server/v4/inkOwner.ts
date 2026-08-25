/**
 * 잉크 픽셀의 파트 주인 지도.
 *
 * **레이어가 안 나뉘던 진짜 이유가 여기 있었다.** 지금까지 잉크 기하는 마스크 전체를 한 번에
 * 추적한 뒤 `assignByCurve` 로 **패스 통째** 다수결 배정했다. 제품 선화는 외곽·시임·끈·로고가
 * 서로 닿아 하나의 거대한 성분이 되므로, 그 성분에서 나온 컴파운드 패스 하나가 통째로 한
 * 파트에 들어갔다 — 실측: 9종 64파트 중 **빈 파트 14개(22%)**, **자기 선이 없는 파트 23개**,
 * 한 파트가 최대 **93%** 를 독점(jewelry_1 ring_body).
 *
 * 픽셀은 이미 나뉘어 있다(파트 마스크). 그러니 **추적 전에** 잉크를 파트별로 쪼개면 된다.
 * 그러면 어떤 패스도 파트 경계를 넘지 않는다 — 배정이 아니라 **분할**이다.
 *
 * 경계 픽셀은 **맨 앞 파트**가 갖는다. 디자이너의 직관과 같다 — 플랩의 가장자리 선은
 * 플랩 것이다. 이웃 파트도 그 선을 함께 쓴다는 사실은 `shared` 로 남긴다(잉크를 복제하지
 * 않는다 — 복제하면 한 파트를 켤 때마다 같은 선이 두 번 그려진다).
 */

export interface OwnerMap {
  /** 픽셀마다 파트 인덱스, 주인이 없으면 -1 */
  owner: Int16Array;
  /** 파트 마스크 어디에도 없어 이웃에서 물려받은 잉크 픽셀 수 */
  inherited: number;
  /** 끝내 주인을 못 찾은 잉크 픽셀 수 */
  unowned: number;
}

/**
 * 잉크 픽셀마다 주인을 정한다.
 *
 * 1. 파트 마스크를 z 오름차순으로 덮어쓴다 → 겹치는 자리는 맨 앞 파트가 갖는다.
 * 2. 어느 마스크에도 안 든 잉크는 **잉크를 따라** 가장 가까운 주인에게서 물려받는다.
 *    유클리드 거리로 하면 선이 마스크 밖으로 삐져나간 곳에서 엉뚱한 파트가 잡힌다 —
 *    잉크 연결을 따라 퍼뜨려야 그 선이 실제로 이어진 파트로 간다.
 */
export function buildOwnerMap(
  ink: Uint8Array,
  parts: { id: string; mask: Uint8Array }[],
  W: number,
  H: number,
): OwnerMap {
  const N = W * H;
  const owner = new Int16Array(N).fill(-1);
  for (let pi = 0; pi < parts.length; pi++) {
    const m = parts[pi].mask;
    for (let i = 0; i < N; i++) if (m[i]) owner[i] = pi;
  }

  // 잉크를 따라 BFS — 주인이 있는 잉크에서 시작해 없는 잉크로 퍼진다
  const queue = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (ink[i] && owner[i] >= 0) queue[qt++] = i;

  let inherited = 0;
  while (qh < qt) {
    const i = queue[qh++];
    const o = owner[i];
    const x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= W) continue;
        const j = ny * W + nx;
        if (!ink[j] || owner[j] >= 0) continue;
        owner[j] = o;
        inherited++;
        queue[qt++] = j;
      }
    }
  }

  let unowned = 0;
  for (let i = 0; i < N; i++) if (ink[i] && owner[i] < 0) unowned++;
  return { owner, inherited, unowned };
}

/**
 * 마스크를 주인별로 쪼갠다. 반환은 파트 인덱스 → 마스크(그 파트 몫만 1).
 * 주인이 없는 픽셀은 `rest` 로 모은다 — 버리지 않는다, 버리면 도면에서 사라진다.
 */
export function splitByOwner(
  mask: Uint8Array,
  owner: Int16Array,
  partCount: number,
  W: number,
  H: number,
): { byPart: Map<number, Uint8Array>; rest: Uint8Array; restN: number } {
  const N = W * H;
  const byPart = new Map<number, Uint8Array>();
  const rest = new Uint8Array(N);
  let restN = 0;
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const o = owner[i];
    if (o < 0 || o >= partCount) { rest[i] = 1; restN++; continue; }
    let m = byPart.get(o);
    if (!m) { m = new Uint8Array(N); byPart.set(o, m); }
    m[i] = 1;
  }
  return { byPart, rest, restN };
}

/**
 * 이 마스크가 어느 다른 파트의 마스크와 실질적으로 맞닿는가 — 공유 경계 기록용.
 * 잉크를 복제하지 않고 "이 선은 저 파트와도 관계있다"만 남긴다.
 */
export function neighborsOf(
  mask: Uint8Array,
  parts: { id: string; mask: Uint8Array }[],
  self: number,
  W: number,
  H: number,
  minShare = 0.08,
): string[] {
  const N = W * H;
  let own = 0;
  for (let i = 0; i < N; i++) if (mask[i]) own++;
  if (!own) return [];
  const out: string[] = [];
  for (let pi = 0; pi < parts.length; pi++) {
    if (pi === self) continue;
    const m = parts[pi].mask;
    let touch = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!mask[i]) continue;
        if (m[i - 1] || m[i + 1] || m[i - W] || m[i + W]) { touch++; break; }
      }
    }
    if (touch >= own * minShare) out.push(parts[pi].id);
  }
  return out;
}

/**
 * 면 컴파운드 패스에서 **아주 작은 구멍을 메운다.**
 *
 * 비즈·메시 도면의 배경 면은 알 하나마다 구멍이 뚫려 컴파운드 패스 하나에 서브패스가
 * 수천 개가 된다(실측: bag_2 `f8` 이 2,739개). Illustrator 에서 그 패스는 통째로만
 * 선택되므로 사실상 편집이 불가능하다.
 *
 * 그런데 그 구멍은 **보이지 않는다.** 알 자체는 그 위에 따로 그려지고(패턴·프리미티브),
 * 구멍 아래에 있는 것은 흰 배경뿐이다. 바깥 윤곽 대비 극히 작은 구멍만 메우므로
 * 형상은 그대로다 — 지우는 것이 아니라 **덮이는 것을 안 그리는 것**이다.
 */
export function fillTinyHoles(d: string, ratio = 0.001): { d: string; dropped: number } {
  const parts = d.split(/(?=[Mm])/).filter((p) => p.trim());
  if (parts.length < 3) return { d, dropped: 0 };

  const NUM = new RegExp("-?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?", "g");
  const areaOf = (sp: string): number => {
    const n = (sp.match(NUM) ?? []).map(Number);
    if (n.length < 6) return 0;
    // 좌표쌍으로 훑어 신발끈 공식 — 곡선 제어점이 섞여도 크기 비교에는 충분하다
    let a = 0;
    for (let i = 0; i + 3 < n.length; i += 2) {
      a += n[i] * n[i + 3] - n[i + 2] * n[i + 1];
    }
    return Math.abs(a) / 2;
  };

  const areas = parts.map(areaOf);
  const max = Math.max(...areas);
  if (!max) return { d, dropped: 0 };
  const cut = max * ratio;

  const kept: string[] = [];
  let dropped = 0;
  for (let i = 0; i < parts.length; i++) {
    if (areas[i] < cut) { dropped++; continue; }
    kept.push(parts[i]);
  }
  return dropped ? { d: kept.join(""), dropped } : { d, dropped: 0 };
}
