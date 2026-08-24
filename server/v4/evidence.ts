/**
 * 성분 단위 증거 수집 — V4 라우터가 판단에 쓰는 값들.
 *
 * V3의 `isStructural()`은 길이와 `length/width` 두 가지만 봤다. 주석에는 "폭이 안정적인 긴
 * 구조선"이라 써 놨지만 **폭의 안정성을 실제로 재지 않았다**. 그래서 굵기가 들쭉날쭉한 로고
 * 덩어리도, 교차점이 잔뜩 있는 끈 뭉치도 길기만 하면 stroke로 승격됐다.
 *
 * 여기서는 성분마다 다음을 재고, 라우터가 그걸 보고 표현을 **하나만** 고른다.
 *   면적 · 둘레 · bbox · 폭 평균/중앙/표준편차/변동계수
 *   골격 길이 · 끝점 수 · 분기점 수 · 분기 밀도
 *   닫힘 여부 · 구멍 수 · 채움률(면적/bbox)
 *   프리미티브 적합 잔차 (원·타원·직선)
 */
import sharp from "sharp";
import { skeletonize, crossingNumber } from "../vector/centerline.js";
import { labelComponents, type Component } from "../v3/label.js";
import { rescueDetails } from "../v3/detailRescue.js";
import { area, close, dilate, erode } from "../v2/raster.js";
import type { Pt } from "./types.js";

export interface ComponentEvidence {
  comp: Component;
  /** 잉크 픽셀 수 */
  area: number;
  bbox: [number, number, number, number];
  perimeter: number;
  /** 성분을 채운 bbox 대비 비율 — 낮으면 가늘고 길다 */
  fillRatio: number;

  /** 폭 통계 (px). 거리변환 × 2 */
  widthMean: number;
  widthMedian: number;
  widthStd: number;
  /** 변동계수 = std/mean. 0.35 이하면 굵기가 안정적이다 */
  widthCv: number;

  skeletonLength: number;
  endpoints: number;
  junctions: number;
  /** 골격 길이당 분기점 — 높으면 교차가 많아 centerline이 무너진다 */
  junctionDensity: number;
  /** 길이/굵기 */
  elongation: number;

  /** 성분이 감싼 구멍 수 */
  holes: number;
  /** 성분 윤곽을 리샘플한 점들 (프리미티브 적합용) */
  contour: Pt[];
}

export interface EvidenceField {
  width: number;
  height: number;
  supersample: number;
  sourceWidth: number;
  sourceHeight: number;
  /** 선만 남긴 잉크 마스크 */
  ink: Uint8Array;
  /** 닫힌 면 찾기용 (closing 적용) */
  inkFill: Uint8Array;
  /** 해프톤으로 판정한 영역 */
  texture: Uint8Array;
  /** 해프톤 삭제 직전에 구제한 것 — [스티치 대시 수, px] · [디테일(로고 등) 수, px] */
  rescuedStitch: [number, number];
  rescuedDetail: [number, number];
  /** 질감이 그림을 지배해 톤 치환을 포기했는가 */
  textureKept: boolean;
  /** 원본 픽셀 (색 샘플링용) */
  rgb: Buffer | Uint8Array;
  channels: number;
  /** 선/면을 가르는 굵기 기준 */
  lineWidthLimit: number;
  components: ComponentEvidence[];
}

export interface EvidenceOptions {
  inkThreshold: number;
  localContrast: number;
  workLong: number;
  textureMode: "auto" | "tone" | "keep";
  /** 이 면적 미만 성분은 잡티로 버린다 (작업 캔버스 기준) */
  minComponentPx: number;
}

export const DEFAULT_EVIDENCE_OPTIONS: EvidenceOptions = {
  inkThreshold: 170,
  localContrast: 22,
  workLong: 2200,
  textureMode: "auto",
  minComponentPx: 12,
};

/** 적분영상 박스 평균 — 국소 대비 임계용 */
function boxMean(gray: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const S = W + 1;
  const sum = new Float64Array(S * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += gray[y * W + x];
      sum[(y + 1) * S + (x + 1)] = sum[y * S + (x + 1)] + row;
    }
  }
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
      const t = sum[(y1 + 1) * S + (x1 + 1)] - sum[y0 * S + (x1 + 1)] - sum[(y1 + 1) * S + x0] + sum[y0 * S + x0];
      out[y * W + x] = (t / ((y1 - y0 + 1) * (x1 - x0 + 1))) | 0;
    }
  }
  return out;
}

/** 마스크 내부의 배경까지 거리 (2-pass chamfer) */
function distanceInside(mask: Uint8Array, W: number, H: number): Float32Array {
  const d = new Float32Array(W * H);
  const INF = 1e6;
  for (let i = 0; i < W * H; i++) d[i] = mask[i] ? INF : 0;
  const A = 1, B = 1.41421356;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + A);
      if (y > 0) v = Math.min(v, d[i - W] + A);
      if (x > 0 && y > 0) v = Math.min(v, d[i - W - 1] + B);
      if (x < W - 1 && y > 0) v = Math.min(v, d[i - W + 1] + B);
      d[i] = v;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (!mask[i]) continue;
      let v = d[i];
      if (x < W - 1) v = Math.min(v, d[i + 1] + A);
      if (y < H - 1) v = Math.min(v, d[i + W] + A);
      if (x < W - 1 && y < H - 1) v = Math.min(v, d[i + W + 1] + B);
      if (x > 0 && y < H - 1) v = Math.min(v, d[i + W - 1] + B);
      d[i] = v;
    }
  }
  return d;
}

/** 성분의 바깥 윤곽을 시계방향으로 따라가 최대 `cap`개로 리샘플 */
export function traceContour(c: Component, W: number, H: number, member: Uint8Array, cap = 240): Pt[] {
  // 가장 왼쪽 위 픽셀에서 시작해 Moore 이웃 추적
  let start = -1;
  for (let k = 0; k < c.pixels.length; k++) {
    const i = c.pixels[k];
    if (start < 0 || i < start) start = i;
  }
  if (start < 0) return [];
  const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const pts: Pt[] = [];
  let cur = start, dir = 0;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < W && y < H && member[y * W + x] ? 1 : 0);
  for (let step = 0; step < c.pixels.length * 4 + 16; step++) {
    const x = cur % W, y = (cur / W) | 0;
    pts.push({ x, y });
    let found = -1;
    for (let k = 0; k < 8; k++) {
      const nd = (dir + 6 + k) % 8;
      const nx = x + N8[nd][0], ny = y + N8[nd][1];
      if (at(nx, ny)) { found = ny * W + nx; dir = nd; break; }
    }
    if (found < 0) break;
    cur = found;
    if (cur === start && pts.length > 2) break;
  }
  if (pts.length <= cap) return pts;
  const out: Pt[] = [];
  const s = pts.length / cap;
  for (let k = 0; k < cap; k++) out.push(pts[Math.floor(k * s)]);
  return out;
}

/** 성분이 감싼 구멍 수 */
function countHoles(c: Component, W: number, H: number, member: Uint8Array): number {
  const { x0, y0, x1, y1 } = c;
  const bw = x1 - x0 + 3, bh = y1 - y0 + 3;
  const local = new Uint8Array(bw * bh);
  for (let k = 0; k < c.pixels.length; k++) {
    const i = c.pixels[k];
    const x = (i % W) - x0 + 1, y = ((i / W) | 0) - y0 + 1;
    local[y * bw + x] = 1;
  }
  // 테두리에서 flood fill → 도달 못한 빈칸이 구멍
  const seen = new Uint8Array(bw * bh);
  const q = new Int32Array(bw * bh);
  let head = 0, tail = 0;
  const push = (i: number) => { if (!seen[i] && !local[i]) { seen[i] = 1; q[tail++] = i; } };
  for (let x = 0; x < bw; x++) { push(x); push((bh - 1) * bw + x); }
  for (let y = 0; y < bh; y++) { push(y * bw); push(y * bw + bw - 1); }
  while (head < tail) {
    const i = q[head++], x = i % bw, y = (i / bw) | 0;
    if (x > 0) push(i - 1);
    if (x < bw - 1) push(i + 1);
    if (y > 0) push(i - bw);
    if (y < bh - 1) push(i + bw);
  }
  // 남은 빈칸 덩어리 수
  let holes = 0;
  const hs = new Uint8Array(bw * bh);
  for (let s = 0; s < bw * bh; s++) {
    if (local[s] || seen[s] || hs[s]) continue;
    holes++;
    let sp = 0;
    q[sp++] = s; hs[s] = 1;
    while (sp) {
      const i = q[--sp], x = i % bw, y = (i / bw) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < bw - 1 ? i + 1 : -1, y > 0 ? i - bw : -1, y < bh - 1 ? i + bw : -1];
      for (const m of nb) if (m >= 0 && !local[m] && !seen[m] && !hs[m]) { hs[m] = 1; q[sp++] = m; }
    }
  }
  void member;
  return holes;
}

export async function extractEvidence(
  pngPath: string,
  opts: Partial<EvidenceOptions> = {},
): Promise<EvidenceField> {
  const o = { ...DEFAULT_EVIDENCE_OPTIONS, ...opts };

  const meta = await sharp(pngPath).metadata();
  const srcW = meta.width!, srcH = meta.height!;
  const supersample = Math.max(1, Math.min(4, Math.round(o.workLong / Math.max(srcW, srcH))));
  const W = srcW * supersample, H = srcH * supersample, N = W * H;

  const { data, info } = await sharp(pngPath)
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .resize(W, H, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;

  // ── 잉크 마스크 (V3와 같은 규칙) ─────────────────────────
  const gray = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const p = i * ch;
    gray[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) | 0;
  }
  let ink = new Uint8Array(N);
  for (let i = 0; i < N; i++) ink[i] = gray[i] < o.inkThreshold ? 1 : 0;
  {
    const mean = boxMean(gray, W, H, Math.max(2, Math.round(Math.min(W, H) * 0.01)));
    let added = 0;
    for (let i = 0; i < N; i++) {
      if (ink[i] || gray[i] >= 236) continue;
      if (gray[i] < mean[i] - o.localContrast) { ink[i] = 1; added++; }
    }
    if (added > N * 0.25) for (let i = 0; i < N; i++) ink[i] = gray[i] < o.inkThreshold ? 1 : 0;
  }

  const lineWidthLimit = Math.max(2, Math.round(Math.min(W, H) * 0.012));
  {
    const core = erode(ink, W, H, lineWidthLimit);
    if (area(core) > N * 0.002) {
      const solid = dilate(core, W, H, lineWidthLimit);
      const thinned = new Uint8Array(N);
      for (let i = 0; i < N; i++) thinned[i] = ink[i] && !solid[i] ? 1 : 0;
      if (area(thinned) > N * 0.0008) ink = thinned;
    }
  }

  // ── 해프톤 → 톤 (V3와 같은 규칙) ─────────────────────────
  const texture = new Uint8Array(N);
  let textureKept = false;
  let rescuedStitch: [number, number] = [0, 0];
  let rescuedDetail: [number, number] = [0, 0];
  {
    const dot = Math.max(2, Math.round(Math.min(W, H) * 0.008));
    const speck = new Uint8Array(N);
    let speckN = 0;
    const specks: Component[] = [];
    for (const c of labelComponents(ink, W, H, 8).components) {
      const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
      if (w > dot * 3 || h > dot * 3 || c.area > dot * dot * 4) continue;
      specks.push(c);
      for (let k = 0; k < c.pixels.length; k++) { speck[c.pixels[k]] = 1; speckN++; }
    }
    if (speckN > N * 0.0004) {
      const cluster = close(dilate(speck, W, H, dot * 2), W, H, dot);
      const accepted = new Uint8Array(N);
      for (const c of labelComponents(cluster, W, H, 4).components) {
        if (c.area < N * 0.0015) continue;
        let dots = 0;
        for (let k = 0; k < c.pixels.length; k++) if (speck[c.pixels[k]]) dots++;
        if (dots < c.area * 0.05) continue;
        for (let k = 0; k < c.pixels.length; k++) { texture[c.pixels[k]] = 1; accepted[c.pixels[k]] = 1; }
      }
      let inkInTexture = 0;
      const inkNow = area(ink);
      for (let i = 0; i < N; i++) if (ink[i] && accepted[i]) inkInTexture++;
      const share = inkNow ? inkInTexture / inkNow : 0;
      const suppress = o.textureMode === "tone" ? true : o.textureMode === "keep" ? false : share < 0.75;
      if (suppress) {
        const doomed: Component[] = [];
        for (const c of specks) {
          let inside = 0;
          for (let k = 0; k < c.pixels.length; k++) if (accepted[c.pixels[k]]) inside++;
          if (inside >= c.pixels.length * 0.6) doomed.push(c);
        }
        // **삭제 직전의 마지막 심문.** 해프톤 클러스터에 삼켜진 성분 중 스티치 대시
        // (길쭉 + 장축 방향 사슬)와 로고 문자(크기·구멍)를 살린다. V4.1 실측:
        // 이 구제 없이 bag_1 스트랩 스티치와 ORBITEC 문자가 통째로 사라졌다.
        const r = rescueDetails(doomed, W, H);
        for (let i = 0; i < doomed.length; i++) {
          if (r.keep.has(i)) {
            // 살린 잉크는 질감 마스크에서도 뺀다 — QA 가 이 영역의 손실을 눈감으면 안 된다
            for (let k = 0; k < doomed[i].pixels.length; k++) texture[doomed[i].pixels[k]] = 0;
          } else {
            for (let k = 0; k < doomed[i].pixels.length; k++) ink[doomed[i].pixels[k]] = 0;
          }
        }
        rescuedStitch = [r.stitchCount, r.stitchPx];
        rescuedDetail = [r.detailCount, r.detailPx];
      } else {
        texture.fill(0);
        textureKept = true;
      }
    }
  }

  const inkFill = close(ink, W, H, Math.max(1, Math.round(supersample / 2)));

  // ── 성분별 증거 ──────────────────────────────────────────
  const dist = distanceInside(ink, W, H);
  const skel = skeletonize(ink, W, H);
  const lab = labelComponents(ink, W, H, 8, o.minComponentPx);
  const member = new Uint8Array(N);

  const components: ComponentEvidence[] = [];
  for (const c of lab.components) {
    for (let k = 0; k < c.pixels.length; k++) member[c.pixels[k]] = 1;

    // 폭 통계
    const ws: number[] = [];
    let sum = 0;
    for (let k = 0; k < c.pixels.length; k++) {
      const v = dist[c.pixels[k]] * 2;
      if (v > 0) { ws.push(v); sum += v; }
    }
    ws.sort((a, b) => a - b);
    const widthMean = ws.length ? sum / ws.length : 1;
    const widthMedian = ws.length ? ws[ws.length >> 1] : 1;
    let varSum = 0;
    for (const v of ws) varSum += (v - widthMean) ** 2;
    const widthStd = ws.length ? Math.sqrt(varSum / ws.length) : 0;

    // 골격
    let skelLen = 0, endpoints = 0, junctions = 0;
    for (let k = 0; k < c.pixels.length; k++) {
      const i = c.pixels[k];
      if (!skel[i]) continue;
      skelLen++;
      const cn = crossingNumber(skel, W, H, i % W, (i / W) | 0);
      if (cn === 1) endpoints++;
      else if (cn >= 3) junctions++;
    }

    // 둘레
    let perimeter = 0;
    for (let k = 0; k < c.pixels.length; k++) {
      const i = c.pixels[k], x = i % W, y = (i / W) | 0;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1
        || !member[i - 1] || !member[i + 1] || !member[i - W] || !member[i + W]) perimeter++;
    }

    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    components.push({
      comp: c,
      area: c.area,
      bbox: [c.x0, c.y0, c.x1, c.y1],
      perimeter,
      fillRatio: +(c.area / (bw * bh)).toFixed(4),
      widthMean: +widthMean.toFixed(2),
      widthMedian: +widthMedian.toFixed(2),
      widthStd: +widthStd.toFixed(2),
      widthCv: +(widthMean ? widthStd / widthMean : 0).toFixed(3),
      skeletonLength: skelLen,
      endpoints,
      junctions,
      junctionDensity: +(skelLen ? junctions / skelLen : 0).toFixed(4),
      elongation: +(widthMean ? skelLen / widthMean : 0).toFixed(2),
      holes: countHoles(c, W, H, member),
      contour: traceContour(c, W, H, member),
    });

    for (let k = 0; k < c.pixels.length; k++) member[c.pixels[k]] = 0;
  }

  return {
    width: W, height: H, supersample, sourceWidth: srcW, sourceHeight: srcH,
    ink, inkFill, texture, textureKept, rescuedStitch, rescuedDetail,
    rgb: data, channels: ch, lineWidthLimit,
    components,
  };
}
