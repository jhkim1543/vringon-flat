/**
 * S10 표현 정규화 분기 + S11 VectorProfile — 개발계획서 §9, §10.
 *
 * §9.1의 원칙: quantization을 "이미지 전체"가 아니라 "레이어별 재질과 목표 모드"로
 * 결정한다. 금속의 긴 gradient, 보석 facet, 반투명 재질은 색 단계가 곧 형상·재질
 * 정보이므로 전역 색 축소를 걸면 정보가 사라진다.
 */
import sharp from "sharp";
import {
  area, boundary, deltaE2000Rgb, dominantColor, rgb2lab, deltaE2000,
  type Raster,
} from "./raster.js";
import type { Material, TargetMode, VectorProfile } from "./schema.js";

// ── §9.2 자동 분기용 특징량 ─────────────────────────────────

export interface MaterialFeatures {
  /** 평탄 영역인지, 텍스처/반사인지 — 낮으면 quantize 허용 */
  localColorVariance: number;
  /** 긴 방향성 gradient 존재 — 높으면 gradient fitting */
  gradientCoherence: number;
  /** 포화/고휘도 highlight 비율 — 높으면 metal/gem profile */
  specularRatio: number;
  /** 세부 패턴·선화 정도 */
  edgeDensity: number;
  /** 반투명/feather 경계 존재 */
  alphaSoftness: number;
  /** 평탄도 종합 (0~1, 높을수록 flat) */
  flatnessScore: number;
  /** 텍스처 정도 (0~1) */
  textureScore: number;
  /** 고유색 수 추정 */
  distinctColors: number;
}

export function extractFeatures(
  rgb: Buffer,
  alpha: Float32Array,
  mask: Uint8Array,
  W: number,
  H: number,
): MaterialFeatures {
  const N = W * H;
  const a = area(mask);
  if (!a) {
    return {
      localColorVariance: 0, gradientCoherence: 0, specularRatio: 0, edgeDensity: 0,
      alphaSoftness: 0, flatnessScore: 1, textureScore: 0, distinctColors: 1,
    };
  }

  // local color variance: 3×3 창의 색 분산 평균 (ΔE2000 기준)
  let varSum = 0, varN = 0;
  // gradient: 수평/수직 밝기 미분의 방향 일관성
  let gx = 0, gy = 0, gmagSum = 0;
  // specular: 고휘도·저채도 픽셀 비율
  let spec = 0;
  // edge: 인접 픽셀 ΔE가 큰 곳
  let edge = 0, edgeN = 0;
  const step = Math.max(1, Math.floor(a / 20000));
  let seen = 0;

  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      if (seen++ % step) continue;
      const p = i * 3;
      const r = rgb[p], g = rgb[p + 1], b = rgb[p + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (lum > 225 && mx - mn < 45) spec++;

      // 이웃과의 색차
      const nbs = [i - 1, i + 1, i - W, i + W];
      let localMax = 0, localSum = 0, cnt = 0;
      for (const nb of nbs) {
        if (!mask[nb]) continue;
        const q = nb * 3;
        const d = deltaE2000Rgb(r, g, b, rgb[q], rgb[q + 1], rgb[q + 2]);
        localMax = Math.max(localMax, d);
        localSum += d; cnt++;
      }
      if (cnt) {
        varSum += localSum / cnt; varN++;
        if (localMax > 6) { edge++; }
        edgeN++;
      }
      // 밝기 미분
      if (mask[i - 1] && mask[i + 1] && mask[i - W] && mask[i + W]) {
        const lx = lumAt(rgb, i + 1) - lumAt(rgb, i - 1);
        const ly = lumAt(rgb, i + W) - lumAt(rgb, i - W);
        gx += lx; gy += ly;
        gmagSum += Math.hypot(lx, ly);
      }
    }
  }

  const localColorVariance = varN ? varSum / varN : 0;
  // 방향 일관성: 벡터합의 크기 / 크기합 (1이면 전부 같은 방향 = 매끈한 gradient)
  const gradientCoherence = gmagSum > 0 ? Math.min(1, Math.hypot(gx, gy) / gmagSum) : 0;
  const specularRatio = varN ? spec / varN : 0;
  const edgeDensity = edgeN ? edge / edgeN : 0;

  // alpha softness: 0<a<1인 픽셀 비율
  let soft = 0, alphaN = 0;
  for (let i = 0; i < N; i++) {
    if (alpha[i] <= 0.02) continue;
    alphaN++;
    if (alpha[i] < 0.95) soft++;
  }
  const alphaSoftness = alphaN ? soft / alphaN : 0;

  // 고유색 수 — 5bit 양자화 구간 수
  const bins = new Set<number>();
  seen = 0;
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    if (seen++ % step) continue;
    const p = i * 3;
    bins.add(((rgb[p] >> 3) << 10) | ((rgb[p + 1] >> 3) << 5) | (rgb[p + 2] >> 3));
  }

  const flatnessScore = Math.max(0, 1 - localColorVariance / 8);
  const textureScore = Math.min(1, edgeDensity * 1.6);

  return {
    localColorVariance: +localColorVariance.toFixed(2),
    gradientCoherence: +gradientCoherence.toFixed(3),
    specularRatio: +specularRatio.toFixed(3),
    edgeDensity: +edgeDensity.toFixed(3),
    alphaSoftness: +alphaSoftness.toFixed(3),
    flatnessScore: +flatnessScore.toFixed(3),
    textureScore: +textureScore.toFixed(3),
    distinctColors: bins.size,
  };
}

const lumAt = (rgb: Buffer, i: number) => 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];

// ── §9.3 Quantization 선택 알고리즘 (예시 5 로직) ───────────

const T_FLAT = 0.62;
const T_TEXTURE = 0.45;

export interface ProfileDecision {
  profile: VectorProfile;
  /** 선택한 팔레트 크기 (quantize를 쓸 때만) */
  maxColors: number | null;
  /** 왜 이 프로파일인지 — manifest/QA에 기록 (FR-06 완료 기준) */
  reason: string;
  features: MaterialFeatures;
  needsReview: boolean;
}

export function decideProfile(
  material: Material,
  targetMode: TargetMode,
  strictVector: boolean,
  features: MaterialFeatures,
  expectedColorCount: number,
): ProfileDecision {
  // 예시 5의 분기를 그대로 따른다
  if (targetMode === "line_art") {
    return { profile: "line_mono", maxColors: null, reason: "target_mode=line_art", features, needsReview: false };
  }

  const MATERIAL_PROFILE: Partial<Record<Material, VectorProfile>> = {
    polished_metal: "metal_gradient",
    brushed_metal: "metal_base",
    gemstone: "gem_facet",
    glass: "gem_facet",
    translucent: "mask_only",
    line_work: "line_mono",
  };
  if (MATERIAL_PROFILE[material]) {
    const p = MATERIAL_PROFILE[material]!;
    // 금속인데 실제로는 평탄하게 그려진 경우(플랫 일러스트) gradient가 무의미하다
    if ((p === "metal_gradient" || p === "metal_base") && features.gradientCoherence < 0.15 && features.flatnessScore > 0.75) {
      return {
        profile: "flat_color",
        maxColors: pickPalette(features, expectedColorCount),
        reason: `material=${material}이지만 gradient coherence ${features.gradientCoherence} < 0.15 → flat 처리`,
        features,
        needsReview: false,
      };
    }
    return { profile: p, maxColors: null, reason: `material=${material}`, features, needsReview: false };
  }

  if (features.flatnessScore >= T_FLAT && features.textureScore < T_TEXTURE) {
    return {
      profile: "flat_color",
      maxColors: pickPalette(features, expectedColorCount),
      reason: `flatness ${features.flatnessScore} ≥ ${T_FLAT}, texture ${features.textureScore} < ${T_TEXTURE}`,
      features,
      needsReview: false,
    };
  }

  // strict_vector가 가능한가 — 고주파 텍스처는 순수 벡터로 재현할 수 없다 (§20 R-10)
  const strictPossible = features.textureScore < 0.75 && features.edgeDensity < 0.6;
  if (strictVector && !strictPossible) {
    return {
      profile: "flat_color",
      maxColors: pickPalette(features, Math.max(6, expectedColorCount)),
      reason: `고주파 텍스처(texture ${features.textureScore}) — strict 모드라 clean_flat로 단순화`,
      features,
      needsReview: true,
    };
  }
  return {
    profile: "flat_precise",
    maxColors: pickPalette(features, Math.max(8, expectedColorCount)),
    reason: `faithful_vector 경로 (flatness ${features.flatnessScore})`,
    features,
    needsReview: !strictPossible,
  };
}

/**
 * §9.2 palette stability — "K 값 변화에 따른 ΔE/edge 변화가 안정되는 구간에서 max_colors 선택".
 * 여기서는 특징량과 planner의 expected_color_count를 함께 써서 안정 구간을 고른다.
 */
function pickPalette(f: MaterialFeatures, expected: number): number {
  const base = Math.max(2, Math.min(16, expected || 6));
  // 색이 실제로 많으면(distinctColors 큼) 팔레트를 올리고, 평탄하면 내린다
  if (f.flatnessScore > 0.85 && f.distinctColors < 40) return Math.max(2, Math.min(base, 6));
  if (f.distinctColors > 400) return Math.min(16, base + 4);
  return base;
}

// ── §10.2/§10.3 VectorProfile 정의 (예시 6 값 그대로) ────────

export interface VectorProfileSpec {
  name: string;
  tracer: {
    clustering: "color" | "binary";
    hierarchy: "cutout" | "stacked";
    curve_mode: "spline" | "polygon";
    filter_speckle_px: number;
    color_precision: number;
    max_colors: number;
    simplify_px: number;
    path_precision: number;
    corner_threshold: number;
    length_threshold: number;
    splice_threshold: number;
  };
  budgets: { max_paths: number; max_nodes: number; max_file_kb: number };
  cleanup: {
    merge_same_fill: boolean;
    min_component_area_ratio: number;
    preserve_holes_over_px2: number;
    refit_bezier: boolean;
  };
  /** 중심선 추출로 stroke를 만드는가 (line_mono) */
  centerline?: boolean;
  /** gradient 근사를 시도하는가 (metal_*) */
  gradient?: boolean;
}

export const VECTOR_PROFILES: Record<VectorProfile, VectorProfileSpec> = {
  // 예시 6. VTracer adapter가 소비하는 버전 고정 VectorProfile
  flat_color: {
    name: "flat_color.v1",
    tracer: {
      clustering: "color", hierarchy: "cutout", curve_mode: "spline",
      filter_speckle_px: 4, color_precision: 6, max_colors: 12,
      simplify_px: 1.2, path_precision: 3,
      corner_threshold: 60, length_threshold: 4, splice_threshold: 45,
    },
    budgets: { max_paths: 400, max_nodes: 12000, max_file_kb: 600 },
    cleanup: { merge_same_fill: true, min_component_area_ratio: 0.00005, preserve_holes_over_px2: 9, refit_bezier: true },
  },
  flat_precise: {
    name: "flat_precise.v1",
    tracer: {
      clustering: "color", hierarchy: "cutout", curve_mode: "spline",
      filter_speckle_px: 2, color_precision: 8, max_colors: 16,
      simplify_px: 0.6, path_precision: 4,
      corner_threshold: 50, length_threshold: 3, splice_threshold: 55,
    },
    budgets: { max_paths: 900, max_nodes: 30000, max_file_kb: 1200 },
    cleanup: { merge_same_fill: true, min_component_area_ratio: 0.00002, preserve_holes_over_px2: 6, refit_bezier: true },
  },
  line_mono: {
    name: "line_mono.v1",
    tracer: {
      clustering: "binary", hierarchy: "stacked", curve_mode: "spline",
      filter_speckle_px: 3, color_precision: 6, max_colors: 2,
      simplify_px: 1.0, path_precision: 3,
      corner_threshold: 60, length_threshold: 4, splice_threshold: 45,
    },
    budgets: { max_paths: 2000, max_nodes: 40000, max_file_kb: 900 },
    cleanup: { merge_same_fill: false, min_component_area_ratio: 0.00002, preserve_holes_over_px2: 4, refit_bezier: true },
    centerline: true,
  },
  metal_base: {
    name: "metal_base.v1",
    tracer: {
      clustering: "color", hierarchy: "cutout", curve_mode: "spline",
      filter_speckle_px: 6, color_precision: 5, max_colors: 6,
      simplify_px: 1.6, path_precision: 3,
      corner_threshold: 65, length_threshold: 6, splice_threshold: 50,
    },
    budgets: { max_paths: 300, max_nodes: 9000, max_file_kb: 500 },
    cleanup: { merge_same_fill: true, min_component_area_ratio: 0.0001, preserve_holes_over_px2: 12, refit_bezier: true },
    gradient: true,
  },
  metal_gradient: {
    name: "metal_gradient.v1",
    tracer: {
      clustering: "color", hierarchy: "cutout", curve_mode: "spline",
      filter_speckle_px: 8, color_precision: 4, max_colors: 4,
      simplify_px: 2.0, path_precision: 3,
      corner_threshold: 70, length_threshold: 8, splice_threshold: 55,
    },
    budgets: { max_paths: 220, max_nodes: 7000, max_file_kb: 400 },
    cleanup: { merge_same_fill: true, min_component_area_ratio: 0.00015, preserve_holes_over_px2: 12, refit_bezier: true },
    gradient: true,
  },
  gem_facet: {
    name: "gem_facet.v1",
    tracer: {
      clustering: "color", hierarchy: "stacked", curve_mode: "polygon",
      filter_speckle_px: 3, color_precision: 7, max_colors: 10,
      simplify_px: 0.8, path_precision: 3,
      corner_threshold: 35, length_threshold: 3, splice_threshold: 70,
    },
    budgets: { max_paths: 500, max_nodes: 12000, max_file_kb: 600 },
    cleanup: { merge_same_fill: false, min_component_area_ratio: 0.00004, preserve_holes_over_px2: 6, refit_bezier: false },
    gradient: true,
  },
  mask_only: {
    name: "mask_only.v1",
    tracer: {
      clustering: "binary", hierarchy: "cutout", curve_mode: "spline",
      filter_speckle_px: 4, color_precision: 6, max_colors: 2,
      simplify_px: 1.2, path_precision: 3,
      corner_threshold: 60, length_threshold: 4, splice_threshold: 45,
    },
    budgets: { max_paths: 150, max_nodes: 5000, max_file_kb: 300 },
    cleanup: { merge_same_fill: true, min_component_area_ratio: 0.0002, preserve_holes_over_px2: 12, refit_bezier: true },
  },
};

// ── S10 표현 정규화 (전처리) ────────────────────────────────

/**
 * 프로파일별 전처리(§9.1 표). 벡터화에 넣기 전 래스터를 다듬는다.
 *  · flat_fill    : LAB bilateral smoothing + 4-16색 quantize
 *  · line_art     : gray/contrast/threshold, 작은 speckle 제거
 *  · metal        : global quantize 생략, highlight/shadow 분해
 *  · gem_facet    : facet edge 보존, 색조 군집을 facet 단위로 제한
 *  · translucent  : alpha/color decontamination (S08에서 이미 수행)
 */
export async function normalizeRepresentation(
  rgb: Buffer,
  mask: Uint8Array,
  W: number,
  H: number,
  decision: ProfileDecision,
): Promise<Buffer> {
  const out = Buffer.from(rgb);

  if (decision.profile === "line_mono") {
    // 대비 강화 + 이진화 준비 (실제 임계는 centerline 단계에서)
    for (let i = 0; i < W * H; i++) {
      const p = i * 3;
      const l = 0.299 * out[p] + 0.587 * out[p + 1] + 0.114 * out[p + 2];
      const v = l < 128 ? Math.max(0, l * 0.6) : Math.min(255, 128 + (l - 128) * 1.4);
      out[p] = out[p + 1] = out[p + 2] = v;
    }
    return out;
  }

  // metal/gem은 전역 quantize를 생략한다 (§9.1: 색 단계가 곧 형상·재질 정보)
  if (decision.profile === "metal_gradient" || decision.profile === "metal_base" || decision.profile === "gem_facet") {
    smoothInMask(out, mask, W, H, 1); // 노이즈만 제거
    return out;
  }

  // flat 계열: LAB 공간 bilateral 근사 + 팔레트 양자화
  smoothInMask(out, mask, W, H, 2);
  if (decision.maxColors) quantizeInMask(out, mask, W, H, decision.maxColors);
  return out;
}

/** 마스크 안에서만 도는 edge-preserving 평활 (bilateral 근사) */
function smoothInMask(rgb: Buffer, mask: Uint8Array, W: number, H: number, r: number): void {
  const src = Buffer.from(rgb);
  const sigmaC = 12; // ΔE2000 기준
  for (let y = r; y < H - r; y++) {
    for (let x = r; x < W - r; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      const p = i * 3;
      const cr = src[p], cg = src[p + 1], cb = src[p + 2];
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const j = (y + dy) * W + (x + dx);
          if (!mask[j]) continue;
          const q = j * 3;
          const d = deltaE2000Rgb(cr, cg, cb, src[q], src[q + 1], src[q + 2]);
          const w = Math.exp(-(d * d) / (2 * sigmaC * sigmaC));
          sr += src[q] * w; sg += src[q + 1] * w; sb += src[q + 2] * w; sw += w;
        }
      }
      if (sw > 0) {
        rgb[p] = Math.round(sr / sw);
        rgb[p + 1] = Math.round(sg / sw);
        rgb[p + 2] = Math.round(sb / sw);
      }
    }
  }
}

/** 마스크 안에서 K색 양자화 (LAB k-means, 결정적 초기화) */
function quantizeInMask(rgb: Buffer, mask: Uint8Array, W: number, H: number, K: number): void {
  const N = W * H;
  const idx: number[] = [];
  for (let i = 0; i < N; i++) if (mask[i]) idx.push(i);
  if (idx.length < K) return;

  // 표본
  const step = Math.max(1, Math.floor(idx.length / 8000));
  const sample = idx.filter((_, k) => k % step === 0);
  const labs = sample.map((i) => rgb2lab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]));

  // 결정적 초기화: 밝기 순 균등 분할
  const sorted = [...labs].sort((a, b) => a.L - b.L);
  let centers = Array.from({ length: K }, (_, k) => sorted[Math.floor(((k + 0.5) * sorted.length) / K)]);

  for (let it = 0; it < 8; it++) {
    const sum = centers.map(() => ({ L: 0, a: 0, b: 0, n: 0 }));
    for (const lab of labs) {
      let best = 0, bd = Infinity;
      for (let k = 0; k < K; k++) {
        const d = deltaE2000(lab, centers[k]);
        if (d < bd) { bd = d; best = k; }
      }
      sum[best].L += lab.L; sum[best].a += lab.a; sum[best].b += lab.b; sum[best].n++;
    }
    centers = centers.map((c, k) =>
      sum[k].n ? { L: sum[k].L / sum[k].n, a: sum[k].a / sum[k].n, b: sum[k].b / sum[k].n } : c,
    );
  }

  // 각 중심의 RGB 대표값 (역변환 대신 표본 평균)
  const rgbSum = centers.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
  for (const i of idx) {
    const lab = rgb2lab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    let best = 0, bd = Infinity;
    for (let k = 0; k < K; k++) {
      const d = deltaE2000(lab, centers[k]);
      if (d < bd) { bd = d; best = k; }
    }
    rgbSum[best].r += rgb[i * 3]; rgbSum[best].g += rgb[i * 3 + 1]; rgbSum[best].b += rgb[i * 3 + 2]; rgbSum[best].n++;
  }
  const palette = rgbSum.map((s) =>
    s.n ? [Math.round(s.r / s.n), Math.round(s.g / s.n), Math.round(s.b / s.n)] : [128, 128, 128],
  );
  for (const i of idx) {
    const lab = rgb2lab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    let best = 0, bd = Infinity;
    for (let k = 0; k < K; k++) {
      const d = deltaE2000(lab, centers[k]);
      if (d < bd) { bd = d; best = k; }
    }
    rgb[i * 3] = palette[best][0];
    rgb[i * 3 + 1] = palette[best][1];
    rgb[i * 3 + 2] = palette[best][2];
  }
}

export { dominantColor, boundary };
export type { Raster };
export { sharp };
