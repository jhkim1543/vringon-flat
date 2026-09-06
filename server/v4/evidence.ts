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
import { flattenGemInteriors, type GemFlattenResult } from "./gemFlatten.js";
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
  /**
   * **필터를 하나도 거치지 않은** 진한 잉크(그레이 < 150). 연속성 불변식의 기준이다 —
   * 분류기 연쇄(헤일로→고아→잡티·해프톤)가 진한 선 토막을 먹는 사고가 실측으로 있었고,
   * 어떤 분류기가 먹었든 "이만큼 어두웠던 픽셀은 최종 산출물이 덮어야 한다"로 지킨다.
   */
  inkStrict: Uint8Array;
  /** 닫힌 면 찾기용 (closing 적용) */
  inkFill: Uint8Array;
  /**
   * 선 굵기보다 두꺼워 **검게 채운 면**으로 판정한 잉크. `ink` 에서는 빠져 있고,
   * 장면 조립이 짙은 FACE_FILL 로 내보낸다. 비어 있을 수 있다.
   */
  solidFill: Uint8Array;
  /** 해프톤으로 판정한 영역 */
  texture: Uint8Array;
  /** 해프톤 삭제 직전에 구제한 것 — [스티치 대시 수, px] · [디테일(로고 등) 수, px] */
  rescuedStitch: [number, number];
  rescuedDetail: [number, number];
  /** 보석 안쪽 반사 제거 결과 */
  gemFlatten?: GemFlattenResult;
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
  /**
   * 안쪽 반사·그림자를 지울 파트 마스크 (보석). 주얼리 도면은 스톤 안에 사진의 하늘
   * 반사를 그대로 남기는데, 그것은 조명의 산물이지 제품의 형상이 아니다.
   */
  gemParts?: { id: string; mask: Uint8Array }[];
}

/** 질감이 이 비율 이상을 차지하면 "질감이 곧 제품"이라 보고 톤 치환을 포기한다 */
const TEXTURE_DOMINATE = Number(process.env.V4_TEXTURE_DOMINATE ?? 0.75);

/**
 * 0.62 로 낮추면 bag_2 의 비즈 2,602개가 살아나고 F@0 도 0.724 → 0.749 로 오르지만,
 * 게이트는 OOX → XXX 로 떨어진다(선F@2 0.937 · 디테일 회수 80% · 구멍 수 15% 차이).
 * 비즈를 벡터로 충실히 옮기는 것 자체가 어려워서다. **표현 결정**이지 버그가 아니다 —
 * 제품별로 `--texture keep` 으로 켤 수 있게 두고, 기본은 게이트를 지키는 쪽으로 둔다.
 */

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
  const inkStrict = new Uint8Array(N);
  {
    const t = Math.min(150, o.inkThreshold);
    for (let i = 0; i < N; i++) inkStrict[i] = gray[i] < t ? 1 : 0;
  }
  {
    // 국소 대비 구제 — 단 **헤일로는 걸러낸다** (V5.0).
    //
    // 이 구제의 목적은 전역 임계가 통째로 놓친 **희미한 선**이다. 그런데 어두운 잉크
    // 주변의 안티에일리어스 헤일로(회색 ~200)도 "주변 평균보다 어둡다"에 걸려 같이
    // 들어와, 모든 획이 사방 1px 씩 살찐다. 굵은 선에서는 티가 안 나지만 3px 대시
    // 수천 개인 도면에서는 잉크가 1.6배가 된다(실측 bag_2: 패턴 초과 잉크 +46%p).
    //
    // 그래서 후보를 성분으로 묶어, **기존 잉크의 1px 이웃 안에만 있는 성분**(순수
    // 헤일로 고리)은 버린다. 잉크 밖으로 몸통이 이어지는 성분(희미한 선의 연속)은
    // 고리 픽셀까지 통째로 살린다 — 끊으면 추적기가 못 잇는다.
    const mean = boxMean(gray, W, H, Math.max(2, Math.round(Math.min(W, H) * 0.01)));
    const cand = new Uint8Array(N);
    let added = 0;
    for (let i = 0; i < N; i++) {
      if (ink[i] || gray[i] >= 236) continue;
      if (gray[i] < mean[i] - o.localContrast) { cand[i] = 1; added++; }
    }
    const HALO = process.env.V4_HALO !== "0"; // A/B 용 — 0 이면 예전처럼 전부 편입
    if (added && added <= N * 0.25 && !HALO) {
      for (let i = 0; i < N; i++) if (cand[i]) ink[i] = 1;
    } else if (added && added <= N * 0.25) {
      const ring = dilate(ink, W, H, 1);
      for (const c of labelComponents(cand, W, H, 8).components) {
        let outside = 0;
        for (let k = 0; k < c.pixels.length; k++) if (!ring[c.pixels[k]]) outside++;
        // 몸통의 1/4 이상이 잉크 이웃 밖에 있어야 "새 선"이다 — 아니면 헤일로다.
        // (접촉 성분 수로 "다리"를 살리는 규칙도 시도했으나, 대시 밭에서는 인접 대시
        // 두 개에 걸친 헤일로 띠가 전부 다리로 오인돼 bag_2 잉크가 1.29×로 되살쪘다.
        // 끊김은 여기서 지키지 않는다 — 장면 조립 끝의 연속성 구조가 지킨다.)
        if (outside >= Math.max(3, c.pixels.length * 0.25)) {
          for (let k = 0; k < c.pixels.length; k++) ink[c.pixels[k]] = 1;
        }
      }
    }
  }

  // ── 보석 안쪽 반사·그림자 제거 ────────────────────────────
  //
  // **solid 분리보다 먼저** 돈다. 큰 반사 덩어리는 solid 분리가 "면 후보"로 빼돌리는
  // 대상과 정확히 겹친다 — 뒤에 돌면 잉크에서 이미 사라져 지울 것이 없고, 그 덩어리는
  // 어두운 면으로 출고되면서 선-QA 에는 "없는 것"으로 잡힌다(실측 jewelry_3: 2,043px
  // 덩어리들이 세 겹 가드를 다 통과한 채 남았다 — 애초에 잉크에 없었기 때문이다).
  // 경계는 건드리지 않는다 — 침식 안쪽만 본다.
  let gemFlatten: GemFlattenResult | undefined;
  if (o.gemParts?.length) {
    gemFlatten = flattenGemInteriors(ink, o.gemParts, W, H);
  }

  const lineWidthLimit = Math.max(2, Math.round(Math.min(W, H) * 0.012));
  // ── 선보다 두꺼운 덩어리 = **검게 채운 면** ─────────────────
  //
  // 선 굵기보다 두꺼운 잉크는 선이 아니라 면이다(검은 갑피·체커보드의 검은 칸·로고 판).
  // 이걸 잉크에서 빼는 것까지는 옳다 — 선 피팅에 넘기면 면의 윤곽을 선으로 오인한다.
  //
  // **다만 빼고 버리면 안 된다.** 원래 이 자리에서 solid 는 지역 변수로 사라졌고, 그래서
  // 도면의 검은 면이 최종 산출물에서 통째로 증발했다(실측 t_footwear_02: 검은 갑피와
  // 체커보드가 전부 흰 바탕으로 나와 선 F@2 0.823 · 잉크비 0.74). 면으로 내보내라고
  // 갈라 놓은 것이니, 갈라낸 것을 장면 조립까지 들고 간다.
  const solidFill = new Uint8Array(N);
  {
    const core = erode(ink, W, H, lineWidthLimit);
    if (area(core) > N * 0.002) {
      const solid = dilate(core, W, H, lineWidthLimit);
      const thinned = new Uint8Array(N);
      for (let i = 0; i < N; i++) thinned[i] = ink[i] && !solid[i] ? 1 : 0;
      if (area(thinned) > N * 0.0008) {
        for (let i = 0; i < N; i++) if (ink[i] && solid[i]) solidFill[i] = 1;
        ink = thinned;
      }
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
      // 0.75 → **0.62**. 이 문턱은 "질감이 그림을 지배하나"를 묻는 것인데, V5.0 헤일로
      // 필터가 계산 기반을 옮겼다 — 3px 비즈는 사방 1px 을 깎이면 면적의 절반을 잃고
      // 10px 획은 5분의 1만 잃으므로, 같은 도면의 share 가 필터 후 내려간다.
      // 실측 bag_2(비즈 2,602개가 제품의 정체인 가방): 필터 끄면 0.75 통과, 켜면 0.68
      // 로 떨어져 비즈가 통째로 회색 톤이 됐다. 0.62 는 그 사이를 여유 있게 가른다.
      const suppress = o.textureMode === "tone" ? true : o.textureMode === "keep" ? false : share < TEXTURE_DOMINATE;
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
    ink, inkStrict, inkFill, solidFill, texture, textureKept, rescuedStitch, rescuedDetail, gemFlatten,
    rgb: data, channels: ch, lineWidthLimit,
    components,
  };
}
