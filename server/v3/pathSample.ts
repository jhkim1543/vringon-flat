/**
 * SVG path 를 **곡선 위의 점**으로 샘플링한다.
 *
 * 기존 `assignStroke()`는 `d` 문자열의 숫자를 정규식으로 훑어 좌표쌍으로 썼다. 큐빅 베지어의
 * `C x1 y1 x2 y2 x y` 에서 (x1,y1)·(x2,y2)는 **제어점**이라 곡선 위에 있지 않다. 곡률이 큰 곳에서
 * 제어점은 곡선에서 한참 떨어지므로, 그 좌표로 파트 마스크 겹침을 재면 엉뚱한 파트에 배정된다.
 *
 * 여기서는 명령을 실제로 해석해 arc-length 에 가깝게 균등 샘플링한다. 라이브러리 없이
 * 베지어를 직접 평가하며, 상대 좌표·생략된 명령(`M` 뒤 연속 좌표는 `L`)·`Z` 를 모두 처리한다.
 */

export interface Pt { x: number; y: number }

const CMD = new RegExp("[MmLlHhVvCcSsQqTtAaZz]", "g");
const NUM = new RegExp("-?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?", "g");

function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}
function quad(p0: Pt, p1: Pt, p2: Pt, t: number): Pt {
  const u = 1 - t, a = u * u, b = 2 * u * t, c = t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x, y: a * p0.y + b * p1.y + c * p2.y };
}
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * path 를 폴리라인들로 평탄화한다. `step` 은 목표 표본 간격(px) — 곡선은 길이에 비례해
 * 잘게 나눈다.
 */
export function flattenPath(d: string, step = 2): Pt[][] {
  const tokens = d.match(new RegExp(`${CMD.source}|${NUM.source}`, "g")) ?? [];
  const out: Pt[][] = [];
  let poly: Pt[] = [];
  let cur: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  let prevCtrl: Pt | null = null;
  let cmd = "";
  let i = 0;

  const num = () => Number(tokens[i++]);
  const flush = () => { if (poly.length > 1) out.push(poly); poly = []; };
  const emit = (p: Pt) => { poly.push(p); cur = p; };
  const curveTo = (f: (t: number) => Pt, roughLen: number) => {
    const n = Math.max(2, Math.min(64, Math.ceil(roughLen / step)));
    for (let k = 1; k <= n; k++) poly.push(f(k / n));
    cur = poly[poly.length - 1];
  };

  while (i < tokens.length) {
    const t = tokens[i];
    if (new RegExp(`^${CMD.source}$`).test(t)) { cmd = t; i++; }
    else if (!cmd) { i++; continue; }
    // 같은 명령이 반복되는 경우(좌표만 이어짐)는 cmd 를 유지한 채 계속 읽는다
    const rel = cmd === cmd.toLowerCase();
    const base = rel ? cur : { x: 0, y: 0 };

    switch (cmd.toUpperCase()) {
      case "M": {
        flush();
        const p = { x: base.x + num(), y: base.y + num() };
        start = p; cur = p; poly = [p]; prevCtrl = null;
        cmd = rel ? "l" : "L"; // M 뒤 연속 좌표는 lineto
        break;
      }
      case "L": { emit({ x: base.x + num(), y: base.y + num() }); prevCtrl = null; break; }
      case "H": { emit({ x: base.x + num(), y: cur.y }); prevCtrl = null; break; }
      case "V": { emit({ x: cur.x, y: base.y + num() }); prevCtrl = null; break; }
      case "C": {
        const p0 = cur;
        const p1 = { x: base.x + num(), y: base.y + num() };
        const p2 = { x: base.x + num(), y: base.y + num() };
        const p3 = { x: base.x + num(), y: base.y + num() };
        curveTo((tt) => cubic(p0, p1, p2, p3, tt), dist(p0, p1) + dist(p1, p2) + dist(p2, p3));
        prevCtrl = p2;
        break;
      }
      case "S": {
        const p0 = cur;
        const p1: Pt = prevCtrl ? { x: 2 * p0.x - prevCtrl.x, y: 2 * p0.y - prevCtrl.y } : p0;
        const p2: Pt = { x: base.x + num(), y: base.y + num() };
        const p3: Pt = { x: base.x + num(), y: base.y + num() };
        curveTo((tt) => cubic(p0, p1, p2, p3, tt), dist(p0, p1) + dist(p1, p2) + dist(p2, p3));
        prevCtrl = p2;
        break;
      }
      case "Q": {
        const p0 = cur;
        const p1 = { x: base.x + num(), y: base.y + num() };
        const p2 = { x: base.x + num(), y: base.y + num() };
        curveTo((tt) => quad(p0, p1, p2, tt), dist(p0, p1) + dist(p1, p2));
        prevCtrl = p1;
        break;
      }
      case "T": {
        const p0 = cur;
        const p1: Pt = prevCtrl ? { x: 2 * p0.x - prevCtrl.x, y: 2 * p0.y - prevCtrl.y } : p0;
        const p2: Pt = { x: base.x + num(), y: base.y + num() };
        curveTo((tt) => quad(p0, p1, p2, tt), dist(p0, p1) + dist(p1, p2));
        prevCtrl = p1;
        break;
      }
      case "A": {
        // 호는 도면 벡터에 거의 없다. 끝점까지 직선으로 근사한다(7개 인자 소비).
        num(); num(); num(); num(); num();
        emit({ x: base.x + num(), y: base.y + num() });
        prevCtrl = null;
        break;
      }
      case "Z": {
        if (poly.length) { poly.push({ ...start }); cur = { ...start }; }
        flush();
        prevCtrl = null;
        break;
      }
      default: i++; break;
    }
  }
  flush();
  return out;
}

/** 평탄화한 점들을 하나의 배열로 (파트 배정용) */
export function samplePath(d: string, step = 2, cap = 600): Pt[] {
  const polys = flattenPath(d, step);
  const all: Pt[] = [];
  for (const p of polys) all.push(...p);
  if (all.length <= cap) return all;
  const out: Pt[] = [];
  const s = all.length / cap;
  for (let k = 0; k < cap; k++) out.push(all[Math.floor(k * s)]);
  return out;
}

/**
 * 곡선 위 표본으로 파트를 정한다.
 *
 * 겹침이 가장 큰 파트를 고르면 **면적이 가장 넓은 베이스 파트가 전부 가져간다** — 몸통 마스크가
 * 거의 모든 선을 덮기 때문이다. 선은 파트 **경계**에 놓이므로, 충분히 겹치는 파트들 중
 * **가장 앞(z가 큰) 파트**를 주인으로 본다. parts 는 z 오름차순으로 들어온다.
 *
 * 1·2위가 비슷하면 두 파트가 공유하는 경계선이므로 `shared` 로 표시해 호출부가 별도 레이어로
 * 뺄 수 있게 한다. 한 파트에 강제 귀속시키면 그 파트를 끄는 순간 이웃 파트의 외곽선이 사라진다.
 */
export function assignByCurve(
  d: string,
  parts: { id: string; mask: Uint8Array }[],
  W: number,
  H: number,
  opts: { radius?: number; sharedRatio?: number } = {},
): { partId: string | undefined; shared: string[]; samples: number } {
  const radius = opts.radius ?? 2;
  const sharedRatio = opts.sharedRatio ?? 0.75;
  if (!parts.length) return { partId: undefined, shared: [], samples: 0 };

  const pts = samplePath(d, 2);
  const score = new Map<string, number>();
  for (const p of pts) {
    const x0 = Math.round(p.x), y0 = Math.round(p.y);
    for (let dy = -radius; dy <= radius; dy++) {
      const y = y0 + dy;
      if (y < 0 || y >= H) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = x0 + dx;
        if (x < 0 || x >= W) continue;
        const idx = y * W + x;
        for (const part of parts) if (part.mask[idx]) score.set(part.id, (score.get(part.id) ?? 0) + 1);
      }
    }
  }

  let best = 0;
  for (const n of score.values()) if (n > best) best = n;
  if (!best) return { partId: parts[parts.length - 1]?.id, shared: [], samples: pts.length };

  const threshold = best * 0.35;
  let owner: string | undefined;
  for (let i = parts.length - 1; i >= 0; i--) {
    const n = score.get(parts[i].id) ?? 0;
    if (n >= threshold) { owner = parts[i].id; break; }
  }
  owner ??= parts[0]?.id;

  const shared = [...score.entries()]
    .filter(([id, n]) => id !== owner && n >= best * sharedRatio)
    .map(([id]) => id);

  return { partId: owner, shared, samples: pts.length };
}
