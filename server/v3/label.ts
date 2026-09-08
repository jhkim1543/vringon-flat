/**
 * 메모리 안전한 연결성분 라벨링.
 *
 * `v2/raster.ts`의 `components()`는 성분마다 `Uint8Array(W*H)` 마스크를 만든다. 캔버스가
 * 작을 때는 괜찮았지만 벡터 작업 해상도를 2~4배로 올리면(2800×2196 = 6.1M px) 성분 200개에
 * 1.2GB가 필요해 그대로 죽는다.
 *
 * 여기서는 라벨 배열 하나(Int32Array)와 성분별 **픽셀 인덱스 목록**만 들고 있는다.
 * 전체 메모리는 성분 수와 무관하게 O(N)이다.
 */

export interface Component {
  label: number;
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 이 성분에 속한 픽셀 인덱스 */
  pixels: Int32Array;
}

export interface Labeling {
  /** 0 = 배경, 1..count = 성분 번호 */
  labels: Int32Array;
  components: Component[];
  width: number;
  height: number;
}

let scratchStack = new Int32Array(0);
let scratchBuf = new Int32Array(0);

/** 4-이웃(기본) 또는 8-이웃 라벨링 */
export function labelComponents(
  mask: Uint8Array,
  W: number,
  H: number,
  connectivity: 4 | 8 = 4,
  minArea = 1,
): Labeling {
  const N = W * H;
  const labels = new Int32Array(N);
  // **작업 버퍼는 재사용한다.** 호출마다 N 크기 배열 둘을 새로 잡으면 2048² 캔버스에서
  // 호출당 32MB — 이 함수는 파이프라인에서 수십 번 불린다(프로파일: 전체 CPU 의 37%).
  if (scratchStack.length < N) { scratchStack = new Int32Array(N); scratchBuf = new Int32Array(N); }
  const stack = scratchStack, buf = scratchBuf;
  const components: Component[] = [];
  let next = 0;
  const eight = connectivity === 8;

  for (let s = 0; s < N; s++) {
    if (!mask[s] || labels[s]) continue;
    next++;
    let sp = 0, n = 0;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    stack[sp++] = s;
    labels[s] = next;
    while (sp) {
      const c = stack[--sp];
      buf[n++] = c;
      const x = c % W, y = (c / W) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      // 이웃 넣기는 인라인 — 픽셀마다 화살표 함수를 만들면 esbuild 의 __name 래퍼까지 얹혀
      // 픽셀당 함수 생성이 된다(프로파일 실측: 이 함수가 CPU 145초 중 54초). 순서는 그대로.
      let m: number;
      if (x > 0) { m = c - 1; if (mask[m] && !labels[m]) { labels[m] = next; stack[sp++] = m; } }
      if (x < W - 1) { m = c + 1; if (mask[m] && !labels[m]) { labels[m] = next; stack[sp++] = m; } }
      if (y > 0) { m = c - W; if (mask[m] && !labels[m]) { labels[m] = next; stack[sp++] = m; } }
      if (y < H - 1) { m = c + W; if (mask[m] && !labels[m]) { labels[m] = next; stack[sp++] = m; } }
      if (eight) {
        if (x > 0 && y > 0) { m = c - W - 1; if (mask[m] && !labels[m]) { labels[m] = next; stack[sp++] = m; } }
        if (x < W - 1 && y > 0) { m = c - W + 1; if (mask[m] && !labels[m]) { labels[m] = next; stack[sp++] = m; } }
        if (x > 0 && y < H - 1) { m = c + W - 1; if (mask[m] && !labels[m]) { labels[m] = next; stack[sp++] = m; } }
        if (x < W - 1 && y < H - 1) { m = c + W + 1; if (mask[m] && !labels[m]) { labels[m] = next; stack[sp++] = m; } }
      }
    }
    if (n < minArea) {
      // 너무 작으면 라벨을 되돌린다 — 번호가 비지 않도록 next도 되돌린다
      for (let k = 0; k < n; k++) labels[buf[k]] = 0;
      next--;
      continue;
    }
    components.push({ label: next, area: n, x0, y0, x1, y1, pixels: buf.slice(0, n) });
  }

  return { labels, components, width: W, height: H };
}

/** 성분 픽셀만 1인 임시 마스크를 채운다 (버퍼 재사용 — 호출 후 clearMask로 되돌릴 것) */
export function fillMask(target: Uint8Array, c: Component, value = 1): void {
  for (let k = 0; k < c.pixels.length; k++) target[c.pixels[k]] = value;
}

export function clearMask(target: Uint8Array, c: Component): void {
  for (let k = 0; k < c.pixels.length; k++) target[c.pixels[k]] = 0;
}
