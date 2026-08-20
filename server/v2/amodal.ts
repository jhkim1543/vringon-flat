/**
 * S07 Amodal 복원 + S08 Alpha 정제 — 개발계획서 §5.2, §8.3, §8.4.
 *
 * 핵심 합성 규칙(식 1)을 그대로 구현한다:
 *
 *   M_hidden_i = clamp(M_amodal_i - dilate(M_visible_i, seam_margin), 0, 1)
 *   RGB_i      = I_original * M_visible_i + G_i * M_hidden_i
 *   Alpha_i    = union(M_visible_i, M_hidden_i)
 *   L_i        = edge_harmonize(RGB_i, Alpha_i, seam_band)
 *
 * 원칙(P3, §2.2 중요 보완): 원본에서 보이던 픽셀은 생성 모델이 임의로 바꾸지 못한다.
 * 생성 결과는 **가려진 영역**과 경계 보정에만 쓴다. 그래서 visible pixel은 원본을
 * 그대로 쓰고 hidden pixel만 G_i에서 가져온다.
 */
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import {
  area, boundary, close, components, deltaE2000Rgb, dilate, distanceTo, erode,
  loadRaster, maskToRgbaPng, subtract, union, type Raster,
} from "./raster.js";
import type { ManifestLayer } from "./schema.js";

export interface ComposedLayer {
  layerId: string;
  /** 최종 알파 (0~1 연속) — matting 결과 */
  alpha: Float32Array;
  /** 이진 알파 (벡터화·QA용) */
  mask: Uint8Array;
  /** 원본 가시 영역 */
  visible: Uint8Array;
  /** 생성으로 채운 숨은 영역 */
  hidden: Uint8Array;
  /** RGB 합성 결과 (원본 visible + 생성 hidden) */
  rgb: Buffer; // W*H*3
  /** §8.3 복원 규칙 검증 결과 */
  checks: AmodalChecks;
}

export interface AmodalChecks {
  /** 가려진 contour의 tangent 연속성 — 곡률 급변 페널티 (0~1, 높을수록 매끄러움) */
  continuity: number;
  /** 대칭 오차 (해당 카테고리에서만 의미) */
  symmetry: number;
  /** 밴드/스트랩 폭 일관성 — visible 대비 hidden 폭 변화 */
  widthConsistency: number;
  /** seam ΔE2000 — visible/hidden 경계의 색 불연속 */
  seamDeltaE: number;
  /** hidden 영역 비율 */
  hiddenRatio: number;
  /** 복원 근거가 약해 사람이 봐야 하는가 (§8.3 uncertain geometry) */
  uncertain: boolean;
}

export interface ComposeOptions {
  /** 원본 가시 픽셀을 보호할 여유 폭 (px) */
  seamMargin: number;
  /** 색 조화 밴드 폭 (px) */
  seamBand: number;
  /** trimap 밴드 (§8.4: 3-10px) */
  trimapBand: number;
  /** 대칭 prior를 적용할 카테고리인가 */
  symmetryPrior: boolean;
}

export const DEFAULT_COMPOSE: ComposeOptions = {
  seamMargin: 2,
  seamBand: 6,
  trimapBand: 4,
  symmetryPrior: false,
};

/**
 * 식 1 실행 — 한 레이어의 최종 RGBA를 만든다.
 *
 * @param original  원본 캔버스 (I_original)
 * @param visible   S04의 가시 마스크 (M_visible)
 * @param generated 후보의 amodal RGBA (G_i, alpha 포함). null이면 visible만으로 구성
 */
export async function composeLayer(
  layer: ManifestLayer,
  original: Raster,
  visible: Uint8Array,
  generated: { raster: Raster; alpha: Uint8Array } | null,
  W: number,
  H: number,
  opts: ComposeOptions = DEFAULT_COMPOSE,
): Promise<ComposedLayer> {
  const N = W * H;

  // ── M_amodal: 생성 알파 ∪ visible (생성이 visible을 빠뜨려도 잃지 않게) ──
  const amodal = generated ? union(generated.alpha, visible) : visible.slice();

  // ── M_hidden = clamp(M_amodal - dilate(M_visible, seam_margin), 0, 1) ──
  const protectedVisible = dilate(visible, W, H, opts.seamMargin);
  let hidden = subtract(amodal, protectedVisible);

  // hidden 정리: 본체와 떨어진 조각은 hallucination이다 (§8.3 uncertain geometry,
  // negative prompt의 "disconnected fragments"와 같은 판단)
  {
    const merged = union(hidden, visible);
    const comps = components(merged, W, H, 1);
    const keep = new Uint8Array(N);
    for (const c of comps) {
      let touchesVisible = false;
      for (let i = 0; i < N && !touchesVisible; i++) if (c.mask[i] && visible[i]) touchesVisible = true;
      if (touchesVisible) for (let i = 0; i < N; i++) if (c.mask[i]) keep[i] = 1;
    }
    hidden = subtract(intersectMask(hidden, keep), visible);
    // 아주 작은 파편 제거
    hidden = openSmall(hidden, W, H, Math.max(4, Math.round(Math.min(W, H) * 0.004)));
  }

  // ── Alpha_i = union(M_visible, M_hidden) ─────────────────
  const binAlpha = union(visible, hidden);

  // ── RGB_i = I_original * M_visible + G_i * M_hidden ──────
  const rgb = Buffer.alloc(N * 3);
  for (let i = 0; i < N; i++) {
    const p3 = i * 3;
    if (visible[i]) {
      const p = i * original.channels;
      rgb[p3] = original.data[p];
      rgb[p3 + 1] = original.data[p + 1];
      rgb[p3 + 2] = original.data[p + 2];
    } else if (hidden[i] && generated) {
      const p = i * generated.raster.channels;
      rgb[p3] = generated.raster.data[p];
      rgb[p3 + 1] = generated.raster.data[p + 1];
      rgb[p3 + 2] = generated.raster.data[p + 2];
    }
  }

  // ── L_i = edge_harmonize(...) — seam band 색 전이 ────────
  const seamDeltaE = edgeHarmonize(rgb, visible, hidden, W, H, opts.seamBand);

  // ── S08 alpha matting ────────────────────────────────────
  const alpha = matteAlpha(rgb, binAlpha, original, W, H, opts.trimapBand);
  decontaminateColor(rgb, alpha, binAlpha, original, W, H);

  const checks = runAmodalChecks(layer, visible, hidden, rgb, W, H, seamDeltaE, opts);

  return { layerId: layer.id, alpha, mask: binAlpha, visible, hidden, rgb, checks };
}

function intersectMask(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] && b[i] ? 1 : 0;
  return out;
}

/** r px 미만의 얇은 파편 제거 (열림) */
function openSmall(m: Uint8Array, W: number, H: number, minArea: number): Uint8Array {
  const out = new Uint8Array(m.length);
  for (const c of components(m, W, H, minArea)) for (let i = 0; i < m.length; i++) if (c.mask[i]) out[i] = 1;
  return out;
}

/**
 * §5.2 edge_harmonize — visible/hidden 경계에서 색이 튀지 않게 좁은 밴드에서만
 * 색을 이어 준다. Poisson blending의 1차 근사: 경계에서 hidden 쪽으로 갈수록
 * visible 평균색과의 차이를 지수적으로 줄인다.
 *
 * 반환값은 보정 **전** seam ΔE2000 (품질 지표로 기록).
 */
function edgeHarmonize(
  rgb: Buffer,
  visible: Uint8Array,
  hidden: Uint8Array,
  W: number,
  H: number,
  band: number,
): number {
  const N = W * H;
  if (!area(hidden)) return 0;

  // seam: visible 경계에 인접한 hidden 픽셀
  const vEdge = boundary(visible, W, H);
  const dV = distanceTo(vEdge, W, H);

  // seam 양쪽 평균색
  let vr = 0, vg = 0, vb = 0, vn = 0, hr = 0, hg = 0, hb = 0, hn = 0;
  for (let i = 0; i < N; i++) {
    if (dV[i] > band) continue;
    const p = i * 3;
    if (visible[i]) { vr += rgb[p]; vg += rgb[p + 1]; vb += rgb[p + 2]; vn++; }
    else if (hidden[i]) { hr += rgb[p]; hg += rgb[p + 1]; hb += rgb[p + 2]; hn++; }
  }
  if (!vn || !hn) return 0;
  vr /= vn; vg /= vn; vb /= vn;
  hr /= hn; hg /= hn; hb /= hn;
  const seamDeltaE = deltaE2000Rgb(vr, vg, vb, hr, hg, hb);

  // hidden 전체에 offset을 걸되 seam에서 멀어질수록 감쇠 — 생성 영역의
  // 재질 표현은 유지하면서 이음매만 맞춘다 (§8.3 material continuity)
  const dr = vr - hr, dg = vg - hg, db = vb - hb;
  const falloff = Math.max(band * 3, 12);
  for (let i = 0; i < N; i++) {
    if (!hidden[i]) continue;
    const w = Math.exp(-dV[i] / falloff);
    const p = i * 3;
    rgb[p] = clamp255(rgb[p] + dr * w);
    rgb[p + 1] = clamp255(rgb[p + 1] + dg * w);
    rgb[p + 2] = clamp255(rgb[p + 2] + db * w);
  }
  return seamDeltaE;
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * §8.4 alpha matting — binary mask에서 trimap band를 만들고 미지 영역의 알파를 추정한다.
 *
 * 고해상도 matting 모델이 없는 환경에서도 경계가 계단이 되지 않도록,
 * 미지 밴드에서 **color line 모델**의 1차 근사를 쓴다: 각 픽셀의 색이
 * 전경 대표색 F와 배경 대표색 B를 잇는 선분 위 어디에 있는지로 알파를 정한다.
 *   alpha = clamp(<I-B, F-B> / |F-B|^2, 0, 1)
 * F/B는 밴드 바깥의 확실한 전경/배경에서 국소적으로 추정한다.
 */
function matteAlpha(
  rgb: Buffer,
  bin: Uint8Array,
  original: Raster,
  W: number,
  H: number,
  band: number,
): Float32Array {
  const N = W * H;
  const alpha = new Float32Array(N);
  const sure = erode(bin, W, H, band);
  const outer = dilate(bin, W, H, band);
  for (let i = 0; i < N; i++) alpha[i] = sure[i] ? 1 : 0;

  // 전경/배경 대표색 (밴드 밖)
  const F = meanOf(rgb, sure, N);
  const bgMask = new Uint8Array(N);
  for (let i = 0; i < N; i++) bgMask[i] = outer[i] ? 0 : 1;
  const B = meanOfRaster(original, bgMask);

  const dF = F[0] - B[0], dG = F[1] - B[1], dB = F[2] - B[2];
  const denom = dF * dF + dG * dG + dB * dB;
  for (let i = 0; i < N; i++) {
    if (sure[i] || !outer[i]) continue;
    const p = i * original.channels;
    if (denom < 1) {
      // 전경/배경 색이 거의 같으면 색으로 못 가른다 → 거리 기반 페더
      alpha[i] = bin[i] ? 1 : 0;
      continue;
    }
    const t =
      ((original.data[p] - B[0]) * dF +
        (original.data[p + 1] - B[1]) * dG +
        (original.data[p + 2] - B[2]) * dB) /
      denom;
    // 이진 마스크가 주는 사전값과 섞어 과도한 흔들림을 막는다
    const prior = bin[i] ? 0.75 : 0.25;
    alpha[i] = Math.max(0, Math.min(1, 0.6 * Math.max(0, Math.min(1, t)) + 0.4 * prior));
  }
  return alpha;
}

/**
 * §8.4 color decontamination — 반투명 경계에서 배경색이 섞여 들어온 성분을 뺀다.
 * premultiplied 규칙을 전 모듈에서 통일하기 위해, 여기서는 straight alpha로
 * 저장하되 색은 배경 성분을 제거한 값으로 맞춘다: F = (I - (1-a)B) / a
 */
function decontaminateColor(
  rgb: Buffer,
  alpha: Float32Array,
  bin: Uint8Array,
  original: Raster,
  W: number,
  H: number,
): void {
  const N = W * H;
  const outer = dilate(bin, W, H, 6);
  const bgMask = new Uint8Array(N);
  for (let i = 0; i < N; i++) bgMask[i] = outer[i] ? 0 : 1;
  const B = meanOfRaster(original, bgMask);
  for (let i = 0; i < N; i++) {
    const a = alpha[i];
    if (a <= 0.02 || a >= 0.98) continue;
    const p = i * 3;
    for (let k = 0; k < 3; k++) {
      const I = rgb[p + k];
      rgb[p + k] = clamp255((I - (1 - a) * B[k]) / a);
    }
  }
}

function meanOf(rgb: Buffer, mask: Uint8Array, N: number): [number, number, number] {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const p = i * 3;
    r += rgb[p]; g += rgb[p + 1]; b += rgb[p + 2]; n++;
  }
  return n ? [r / n, g / n, b / n] : [128, 128, 128];
}

function meanOfRaster(r: Raster, mask: Uint8Array): [number, number, number] {
  let R = 0, G = 0, B = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const p = i * r.channels;
    R += r.data[p]; G += r.data[p + 1]; B += r.data[p + 2]; n++;
  }
  return n ? [R / n, G / n, B / n] : [255, 255, 255];
}

/** §8.3 복원 규칙 검증 */
function runAmodalChecks(
  layer: ManifestLayer,
  visible: Uint8Array,
  hidden: Uint8Array,
  rgb: Buffer,
  W: number,
  H: number,
  seamDeltaE: number,
  opts: ComposeOptions,
): AmodalChecks {
  const N = W * H;
  const hiddenA = area(hidden), visibleA = area(visible);
  const hiddenRatio = visibleA ? hiddenA / (visibleA + hiddenA) : 0;

  // Smooth continuation — 합쳐진 형상 외곽의 곡률 급변 비율.
  // 경계를 따라가며 방향 변화가 큰 지점의 비율이 낮을수록 매끄럽다.
  const full = union(visible, hidden);
  const continuity = contourSmoothness(full, W, H);

  // Symmetry prior — 링·보석처럼 대칭성이 높은 카테고리에서만 의미 있다
  let symmetry = 1;
  if (opts.symmetryPrior && hiddenA) {
    symmetry = verticalSymmetry(full, W, H);
  }

  // Constant-width prior — 밴드/스트랩의 폭 변화
  let widthConsistency = 1;
  if (hiddenA > 0) {
    const wv = ribbonWidth(visible, W, H);
    const wh = ribbonWidth(hidden, W, H);
    if (wv > 0 && wh > 0) widthConsistency = Math.max(0, 1 - Math.abs(wh - wv) / Math.max(wv, wh));
  }

  const uncertain =
    layer.requires_review ||
    hiddenRatio > 0.55 || // 절반 넘게 추정이면 근거가 약하다
    continuity < 0.6 ||
    seamDeltaE > 12;

  void rgb; void N;
  return {
    continuity: +continuity.toFixed(3),
    symmetry: +symmetry.toFixed(3),
    widthConsistency: +widthConsistency.toFixed(3),
    seamDeltaE: +seamDeltaE.toFixed(2),
    hiddenRatio: +hiddenRatio.toFixed(3),
    uncertain,
  };
}

/** 외곽 경계의 매끄러움 0~1 — 방향 변화가 급한 픽셀 비율의 역 */
function contourSmoothness(m: Uint8Array, W: number, H: number): number {
  const b = boundary(m, W, H);
  const pts: number[] = [];
  for (let i = 0; i < b.length; i++) if (b[i]) pts.push(i);
  if (pts.length < 24) return 1;
  // 표본 간 국소 곡률: 이웃 경계 픽셀 개수로 근사 (톱니가 심하면 이웃이 적다)
  let rough = 0;
  const step = Math.max(1, Math.floor(pts.length / 2000));
  let n = 0;
  for (let k = 0; k < pts.length; k += step) {
    const i = pts[k];
    const x = i % W, y = (i / W) | 0;
    let cnt = 0;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (b[ny * W + nx]) cnt++;
      }
    // 매끄러운 곡선이면 5×5 창에 경계 픽셀이 ~5개, 톱니·가시면 더 많거나 적다
    if (cnt < 3 || cnt > 11) rough++;
    n++;
  }
  return n ? Math.max(0, 1 - rough / n) : 1;
}

/** 좌우 대칭도 0~1 */
function verticalSymmetry(m: Uint8Array, W: number, H: number): number {
  let sx = 0, n = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) { sx += i % W; n++; }
  if (!n) return 1;
  const axis = Math.round(sx / n);
  let match = 0, total = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!m[i]) continue;
      total++;
      const mx = 2 * axis - x;
      if (mx >= 0 && mx < W && m[y * W + mx]) match++;
    }
  }
  return total ? match / total : 1;
}

/** 리본 근사 폭 = 2·면적/둘레 */
function ribbonWidth(m: Uint8Array, W: number, H: number): number {
  const a = area(m);
  if (!a) return 0;
  const p = area(boundary(m, W, H));
  return (2 * a) / Math.max(1, p);
}

/** 합성 결과를 RGBA PNG로 저장 (layers/{id}.png — 계획서 산출물) */
export async function writeLayerPng(
  c: ComposedLayer,
  W: number,
  H: number,
  dest: string,
): Promise<void> {
  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const a = Math.round(Math.max(0, Math.min(1, c.alpha[i])) * 255);
    if (!a) continue;
    out[i * 4] = c.rgb[i * 3];
    out[i * 4 + 1] = c.rgb[i * 3 + 1];
    out[i * 4 + 2] = c.rgb[i * 3 + 2];
    out[i * 4 + 3] = a;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toFile(dest);
}

export { loadRaster, maskToRgbaPng, close, erode };
