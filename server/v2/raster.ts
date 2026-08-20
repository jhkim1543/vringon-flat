/**
 * 래스터 공용 유틸 — 마스크 연산·형태학·색차·경계 지표.
 *
 * 계획서가 요구하는 지표(§13.1, §13.2, §18.3)를 여기 한 곳에 모은다.
 *  · IoU / mIoU            — visible·amodal·composite foreground
 *  · Edge F1 (chamfer 허용) — boundary F-score
 *  · ΔE2000                — 색 오차 (RGB 유클리드가 아니다)
 *  · morphology            — dilate/erode/open/close, trimap
 *
 * 전부 Uint8Array 이진 마스크(0/1)와 RGB Buffer를 다룬다.
 */
import sharp from "sharp";

export interface Raster {
  data: Buffer; // RGB or RGBA raw
  channels: number;
  width: number;
  height: number;
}

export async function loadRaster(src: string | Buffer, w?: number, h?: number): Promise<Raster> {
  let p = sharp(src).ensureAlpha();
  if (w && h) p = p.resize(w, h, { fit: "fill" });
  const { data, info } = await p.raw().toBuffer({ resolveWithObject: true });
  return { data, channels: info.channels, width: info.width, height: info.height };
}

/** RGBA PNG의 알파 → 이진 마스크 */
export async function alphaMask(src: string | Buffer, w: number, h: number, thr = 100): Promise<Uint8Array> {
  const r = await loadRaster(src, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = r.data[i * r.channels + 3] > thr ? 1 : 0;
  return out;
}

/** 흰 배경 위 도형 PNG → 이진 마스크 (밝기 기준) */
export async function inkMaskOf(src: string | Buffer, w: number, h: number, thr = 245): Promise<Uint8Array> {
  const { data, info } = await sharp(src)
    .flatten({ background: "#ffffff" })
    .resize(w, h, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = data[i * info.channels] < thr ? 1 : 0;
  return out;
}

// ── 집합 연산 ───────────────────────────────────────────────
export const area = (m: Uint8Array): number => {
  let n = 0;
  for (let i = 0; i < m.length; i++) n += m[i];
  return n;
};

export function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x && y) inter++;
    if (x || y) uni++;
  }
  return uni ? inter / uni : 0;
}

export function union(...ms: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(ms[0].length);
  for (const m of ms) for (let i = 0; i < out.length; i++) if (m[i]) out[i] = 1;
  return out;
}

export function intersect(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] && b[i] ? 1 : 0;
  return out;
}

/** a - b (clamp 0) */
export function subtract(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] && !b[i] ? 1 : 0;
  return out;
}

// ── 형태학 ─────────────────────────────────────────────────
/** 체비쇼프 거리 기반 팽창 (정사각 구조요소, 분리형) */
export function dilate(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
  if (r <= 0) return m.slice();
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r) && !v; k++) v = m[y * W + k];
      tmp[y * W + x] = v;
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let v = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r) && !v; k++) v = tmp[k * W + x];
      out[y * W + x] = v;
    }
  }
  return out;
}

export function erode(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
  if (r <= 0) return m.slice();
  const inv = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) inv[i] = m[i] ? 0 : 1;
  const d = dilate(inv, W, H, r);
  const out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = d[i] ? 0 : 1;
  return out;
}

export const open = (m: Uint8Array, W: number, H: number, r = 1) => dilate(erode(m, W, H, r), W, H, r);
export const close = (m: Uint8Array, W: number, H: number, r = 1) => erode(dilate(m, W, H, r), W, H, r);

/** 마스크 경계 픽셀 (4-이웃 중 하나라도 밖이면 경계) */
export function boundary(m: Uint8Array, W: number, H: number): Uint8Array {
  const out = new Uint8Array(m.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!m[i]) continue;
      if (
        x === 0 || y === 0 || x === W - 1 || y === H - 1 ||
        !m[i - 1] || !m[i + 1] || !m[i - W] || !m[i + W]
      ) out[i] = 1;
    }
  }
  return out;
}

/** §8.4 trimap — 확실한 전경 / 확실한 배경 / 미지 밴드 (0/128/255) */
export function trimap(m: Uint8Array, W: number, H: number, band: number): Uint8Array {
  const inner = erode(m, W, H, band);
  const outer = dilate(m, W, H, band);
  const out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = inner[i] ? 255 : outer[i] ? 128 : 0;
  return out;
}

/** 연결요소 — minArea 미만은 버린다 */
export function components(
  m: Uint8Array,
  W: number,
  H: number,
  minArea = 1,
): { mask: Uint8Array; area: number; cx: number; cy: number; bbox: [number, number, number, number] }[] {
  const seen = new Uint8Array(W * H);
  const q = new Int32Array(W * H);
  const out: ReturnType<typeof components> = [];
  for (let s = 0; s < W * H; s++) {
    if (!m[s] || seen[s]) continue;
    let head = 0, tail = 0;
    q[tail++] = s; seen[s] = 1;
    const comp = new Uint8Array(W * H);
    let a = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    while (head < tail) {
      const p = q[head++];
      comp[p] = 1; a++;
      const x = p % W, y = (p / W) | 0;
      sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && m[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; q[tail++] = p - 1; }
      if (x < W - 1 && m[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; q[tail++] = p + 1; }
      if (y > 0 && m[p - W] && !seen[p - W]) { seen[p - W] = 1; q[tail++] = p - W; }
      if (y < H - 1 && m[p + W] && !seen[p + W]) { seen[p + W] = 1; q[tail++] = p + W; }
    }
    if (a >= minArea) out.push({ mask: comp, area: a, cx: sx / a / W, cy: sy / a / H, bbox: [x0, y0, x1, y1] });
  }
  return out.sort((p, r) => r.area - p.area);
}

// ── 거리변환 (chamfer 근사) ─────────────────────────────────
/** 2-pass chamfer distance transform — m이 1인 곳까지의 거리 */
export function distanceTo(m: Uint8Array, W: number, H: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = m[i] ? 0 : INF;
  const D1 = 1, D2 = Math.SQRT2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + D1);
      if (y > 0) v = Math.min(v, d[i - W] + D1);
      if (x > 0 && y > 0) v = Math.min(v, d[i - W - 1] + D2);
      if (x < W - 1 && y > 0) v = Math.min(v, d[i - W + 1] + D2);
      d[i] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      let v = d[i];
      if (x < W - 1) v = Math.min(v, d[i + 1] + D1);
      if (y < H - 1) v = Math.min(v, d[i + W] + D1);
      if (x < W - 1 && y < H - 1) v = Math.min(v, d[i + W + 1] + D2);
      if (x > 0 && y < H - 1) v = Math.min(v, d[i + W - 1] + D2);
      d[i] = v;
    }
  }
  return d;
}

/**
 * Edge F1 — 두 경계가 tolerance px 안에서 얼마나 일치하는가 (§13.1 EdgeF1, §18.3 Boundary F-score).
 * precision = pred 경계 중 gt 근처 비율, recall = gt 경계 중 pred 근처 비율.
 */
export function edgeF1(
  predEdge: Uint8Array,
  gtEdge: Uint8Array,
  W: number,
  H: number,
  tolerance = 2,
): { f1: number; precision: number; recall: number } {
  const dGt = distanceTo(gtEdge, W, H);
  const dPred = distanceTo(predEdge, W, H);
  let tp = 0, np = 0, tr = 0, ng = 0;
  for (let i = 0; i < W * H; i++) {
    if (predEdge[i]) { np++; if (dGt[i] <= tolerance) tp++; }
    if (gtEdge[i]) { ng++; if (dPred[i] <= tolerance) tr++; }
  }
  const precision = np ? tp / np : 0;
  const recall = ng ? tr / ng : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { f1, precision, recall };
}

// ── 색 ─────────────────────────────────────────────────────
export interface Lab { L: number; a: number; b: number }

export function rgb2lab(r: number, g: number, b: number): Lab {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = f(r), G = f(g), B = f(b);
  // sRGB → XYZ (D65)
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const Z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const t = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const fx = t(X), fy = t(Y), fz = t(Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/**
 * CIEDE2000 색차. 계획서가 요구하는 색 지표(§13.1 DeltaE2000, §13.2 masked ΔE2000).
 * RGB 유클리드 거리는 인지 균일하지 않아 금속/보석 판정에서 특히 어긋난다.
 */
export function deltaE2000(c1: Lab, c2: Lab): number {
  const { L: L1, a: a1, b: b1 } = c1;
  const { L: L2, a: a2, b: b2 } = c2;
  const kL = 1, kC = 1, kH = 1;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (x: number, y: number) => {
    if (x === 0 && y === 0) return 0;
    const d = (Math.atan2(y, x) * 180) / Math.PI;
    return d >= 0 ? d : d + 360;
  };
  const h1p = h(a1p, b1), h2p = h(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbarp += h1p + h2p < 360 ? 360 : -360;
    hbarp /= 2;
  }
  const T =
    1 -
    0.17 * Math.cos(((hbarp - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * hbarp * Math.PI) / 180) +
    0.32 * Math.cos(((3 * hbarp + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * hbarp - 63) * Math.PI) / 180);
  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin((2 * dTheta * Math.PI) / 180) * Rc;
  return Math.sqrt(
    Math.pow(dLp / (kL * Sl), 2) +
      Math.pow(dCp / (kC * Sc), 2) +
      Math.pow(dHp / (kH * Sh), 2) +
      Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh)),
  );
}

export function deltaE2000Rgb(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return deltaE2000(rgb2lab(r1, g1, b1), rgb2lab(r2, g2, b2));
}

/** 마스크 영역의 평균 ΔE2000 — 두 래스터 비교 */
export function maskedDeltaE(a: Raster, b: Raster, mask: Uint8Array): number {
  let sum = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const pa = i * a.channels, pb = i * b.channels;
    sum += deltaE2000Rgb(a.data[pa], a.data[pa + 1], a.data[pa + 2], b.data[pb], b.data[pb + 1], b.data[pb + 2]);
    n++;
  }
  return n ? sum / n : 0;
}

/** 마스크 영역의 대표색 — 4bit 양자화 최빈 구간의 평균 (윤곽선 픽셀에 끌려가지 않게) */
export function dominantColor(r: Raster, mask: Uint8Array, skipDark = true): [number, number, number] {
  const bins = new Map<number, number>();
  let total = 0, dark = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const p = i * r.channels;
    if (r.channels === 4 && r.data[p + 3] < 100) continue;
    const R = r.data[p], G = r.data[p + 1], B = r.data[p + 2];
    total++;
    if (R < 30 && G < 30 && B < 30) dark++;
    bins.set(((R >> 4) << 8) | ((G >> 4) << 4) | (B >> 4), (bins.get(((R >> 4) << 8) | ((G >> 4) << 4) | (B >> 4)) ?? 0) + 1);
  }
  if (!bins.size) return [128, 128, 128];
  const dropDark = skipDark && dark < total * 0.5;
  const isDarkBin = (k: number) => (k >> 8) <= 1 && ((k >> 4) & 15) <= 1 && (k & 15) <= 1;
  let best = -1, bestN = 0;
  for (const [k, n] of bins) {
    if (dropDark && isDarkBin(k)) continue;
    if (n > bestN) { bestN = n; best = k; }
  }
  if (best < 0) for (const [k, n] of bins) if (n > bestN) { bestN = n; best = k; }
  let R = 0, G = 0, B = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const p = i * r.channels;
    if (r.channels === 4 && r.data[p + 3] < 100) continue;
    const k = ((r.data[p] >> 4) << 8) | ((r.data[p + 1] >> 4) << 4) | (r.data[p + 2] >> 4);
    if (k !== best) continue;
    R += r.data[p]; G += r.data[p + 1]; B += r.data[p + 2]; n++;
  }
  return n ? [Math.round(R / n), Math.round(G / n), Math.round(B / n)] : [128, 128, 128];
}

export const toHex = (c: [number, number, number]): string =>
  "#" + c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");

/** 이진 마스크 → 흰 배경 위 색면 PNG */
export async function maskToPng(
  mask: Uint8Array,
  W: number,
  H: number,
  hex: string,
  dest: string,
): Promise<void> {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const rgb = Buffer.alloc(W * H * 3, 255);
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
  }
  await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toFile(dest);
}

/** 이진 마스크 + 원본 색 → 투명 RGBA PNG (layers/{id}.png 산출물) */
export async function maskToRgbaPng(
  mask: Uint8Array,
  src: Raster,
  W: number,
  H: number,
  dest: string,
  alphaSoft?: Float32Array,
): Promise<void> {
  const out = Buffer.alloc(W * H * 4, 0);
  for (let i = 0; i < W * H; i++) {
    const a = alphaSoft ? Math.round(Math.max(0, Math.min(1, alphaSoft[i])) * 255) : mask[i] ? 255 : 0;
    if (!a) continue;
    const p = i * src.channels;
    out[i * 4] = src.data[p];
    out[i * 4 + 1] = src.data[p + 1];
    out[i * 4 + 2] = src.data[p + 2];
    out[i * 4 + 3] = a;
  }
  await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toFile(dest);
}

/** 배경(테두리 연결 밝은 영역) 마스크 — 흰 제품 파트를 배경으로 오인하지 않게 연결성으로 판정 */
export function backgroundMask(r: Raster, W: number, H: number, lightThr = 238): Uint8Array {
  const bg = new Uint8Array(W * H);
  const light = (i: number) => {
    const p = i * r.channels;
    if (r.channels === 4 && r.data[p + 3] < 20) return true; // 투명도 배경
    return r.data[p] > lightThr && r.data[p + 1] > lightThr && r.data[p + 2] > lightThr;
  };
  const q = new Int32Array(W * H);
  let head = 0, tail = 0;
  const push = (i: number) => {
    if (bg[i] || !light(i)) return;
    bg[i] = 1; q[tail++] = i;
  };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (head < tail) {
    const c = q[head++];
    const x = c % W, y = (c / W) | 0;
    if (x > 0) push(c - 1);
    if (x < W - 1) push(c + 1);
    if (y > 0) push(c - W);
    if (y < H - 1) push(c + W);
  }
  return bg;
}
