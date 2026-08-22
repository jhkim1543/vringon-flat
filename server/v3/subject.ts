/**
 * 배경·피사체 검출 — 도면과 사진 모두에 쓰는 공용 계약.
 *
 * 기존 `fgBBox()`는 루미넌스 `< 245`를 전경으로 봤다. 도면 배경은 순백이 아니라
 * **RGB 235 근처의 옅은 회색**이라 캔버스 전체가 전경이 됐다 — 9개 샘플 중 5개에서
 * bbox가 이미지 전체로 오판됐다(shoe_1·2·3, bag_1, bag_2, 실측 lumBoxFrac 1.000).
 *
 * 여기서는 임계를 고정하지 않는다:
 *   1. 테두리 픽셀의 중앙값으로 **배경색을 추정**한다.
 *   2. 그 색과 가까우면서 **캔버스 테두리에 연결된** 영역만 배경으로 본다.
 *      (제품 안쪽의 흰 면은 테두리에 닿지 않으므로 전경으로 남는다)
 *   3. 남은 것에서 작은 얼룩을 걷어내고 bbox를 잡는다.
 *
 * 배경이 전경과 구분되지 않으면 `confident:false`로 알린다. 호출부는 그때 정합을
 * 시도하지 말아야 한다 — 잘못된 bbox로 맞추면 형상이 통째로 밀린다.
 */
import sharp from "sharp";

export interface SubjectBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Subject {
  box: SubjectBox;
  /** 추정한 배경색 (RGB) */
  background: [number, number, number];
  /** 전경 마스크 (1 = 피사체) */
  mask: Uint8Array;
  width: number;
  height: number;
  /** bbox가 캔버스에서 차지하는 넓이 비율 */
  fill: number;
  /**
   * 배경 검출이 믿을 만한가. bbox가 캔버스의 대부분을 덮으면 배경을 못 찾은 것이다.
   * 이 값이 false면 bbox 기반 정합을 하면 안 된다.
   */
  confident: boolean;
}

export interface SubjectOptions {
  /** 배경색과의 채널당 허용 오차 */
  tolerance: number;
  /** 이 비율 이상을 덮으면 검출 실패로 본다 */
  maxFill: number;
  /** 이 픽셀 수 미만의 전경 얼룩은 bbox에서 뺀다 */
  minBlobPx: number;
}

export const DEFAULT_SUBJECT_OPTIONS: SubjectOptions = {
  tolerance: 14,
  maxFill: 0.95,
  minBlobPx: 12,
};

/** 테두리 한 줄에서 채널별 중앙값 — 소수의 이상치(제품이 가장자리에 닿는 경우)에 견딘다 */
function borderMedian(data: Buffer | Uint8Array, W: number, H: number, ch: number): [number, number, number] {
  const acc: number[][] = [[], [], []];
  const take = (i: number) => {
    const p = i * ch;
    acc[0].push(data[p]); acc[1].push(data[p + 1]); acc[2].push(data[p + 2]);
  };
  for (let x = 0; x < W; x++) { take(x); take((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { take(y * W); take(y * W + W - 1); }
  return acc.map((a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; }) as [number, number, number];
}

export async function detectSubject(
  src: string | Buffer,
  opts: Partial<SubjectOptions> = {},
): Promise<Subject> {
  const o = { ...DEFAULT_SUBJECT_OPTIONS, ...opts };
  const { data, info } = await sharp(src)
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, N = W * H, ch = info.channels;
  const bg = borderMedian(data, W, H, ch);

  // 테두리에서 시작해 배경색과 가까운 곳으로만 번진다
  const isBg = (i: number) => {
    const p = i * ch;
    return Math.abs(data[p] - bg[0]) <= o.tolerance
      && Math.abs(data[p + 1] - bg[1]) <= o.tolerance
      && Math.abs(data[p + 2] - bg[2]) <= o.tolerance;
  };
  const outside = new Uint8Array(N);
  const q = new Int32Array(N);
  let head = 0, tail = 0;
  const push = (i: number) => { if (!outside[i] && isBg(i)) { outside[i] = 1; q[tail++] = i; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (head < tail) {
    const c = q[head++], x = c % W, y = (c / W) | 0;
    if (x > 0) push(c - 1);
    if (x < W - 1) push(c + 1);
    if (y > 0) push(c - W);
    if (y < H - 1) push(c + W);
  }

  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask[i] = outside[i] ? 0 : 1;

  // 배경 안에 떠 있는 작은 얼룩(JPEG 잡티·워터마크)은 bbox를 부풀리므로 뺀다
  const keep = new Uint8Array(N);
  {
    const seen = new Uint8Array(N);
    const stack = new Int32Array(N);
    for (let s = 0; s < N; s++) {
      if (!mask[s] || seen[s]) continue;
      let sp = 0, n = 0;
      stack[sp++] = s; seen[s] = 1;
      const members: number[] = [];
      while (sp) {
        const c = stack[--sp];
        members.push(c); n++;
        const x = c % W, y = (c / W) | 0;
        const nb = [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, y > 0 ? c - W : -1, y < H - 1 ? c + W : -1];
        for (const m of nb) if (m >= 0 && mask[m] && !seen[m]) { seen[m] = 1; stack[sp++] = m; }
      }
      if (n >= o.minBlobPx) for (const m of members) keep[m] = 1;
    }
  }

  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!keep[y * W + x]) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const box: SubjectBox = x1 < 0
    ? { x: 0, y: 0, w: W, h: H }
    : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  const fill = (box.w * box.h) / N;

  return { box, background: bg, mask: keep, width: W, height: H, fill, confident: fill < o.maxFill };
}

/**
 * 두 피사체 사이의 **등방** 상사변환 (확대·이동만, 회전 없음).
 *
 * 기존 `alignToBox()`는 `fit:"fill"`로 x·y를 다른 배율로 늘렸다. 생성 도면은 사진을
 * 다시 그린 것이라 종횡비가 애초에 다르고(bag_1 실측 21%), 이를 억지로 맞추면 손잡이
 * 곡률·스트랩 폭·버클 위치가 전부 바뀐다. 등방으로 제한하고, 남은 종횡비 차이는
 * `aspectRatio`로 보고해 QA가 판단하게 한다.
 */
export function similarityFit(from: SubjectBox, to: SubjectBox): {
  scale: number;
  tx: number;
  ty: number;
  /** 등방으로 맞춘 뒤에도 남는 x/y 종횡비 불일치 (1에 가까울수록 좋다) */
  aspectRatio: number;
} {
  const sx = to.w / from.w, sy = to.h / from.h;
  // 넓이를 보존하는 기하평균이 한쪽 축만 과하게 늘리지 않는다
  const scale = Math.sqrt(sx * sy);
  const fcx = from.x + from.w / 2, fcy = from.y + from.h / 2;
  const tcx = to.x + to.w / 2, tcy = to.y + to.h / 2;
  return {
    scale,
    tx: tcx - fcx * scale,
    ty: tcy - fcy * scale,
    aspectRatio: Math.max(sx, sy) / Math.min(sx, sy),
  };
}

/** 마스크를 등방 변환으로 다른 캔버스에 옮긴다 (nearest — 마스크는 보간하면 안 된다) */
export function warpMask(
  mask: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  t: { scale: number; tx: number; ty: number },
): Uint8Array {
  const out = new Uint8Array(dstW * dstH);
  const inv = 1 / t.scale;
  for (let y = 0; y < dstH; y++) {
    const sy = Math.round((y - t.ty) * inv);
    if (sy < 0 || sy >= srcH) continue;
    for (let x = 0; x < dstW; x++) {
      const sx = Math.round((x - t.tx) * inv);
      if (sx < 0 || sx >= srcW) continue;
      if (mask[sy * srcW + sx]) out[y * dstW + x] = 1;
    }
  }
  return out;
}
