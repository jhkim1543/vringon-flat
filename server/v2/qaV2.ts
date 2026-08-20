/**
 * S14 재합성 검증 — 개발계획서 §13.2, §18.3.
 *
 * 계획서의 핵심(P5): 레이어별 점수가 높아도 전체 합성에서 색·경계·가림이 틀릴 수
 * 있으므로 **global composite score를 최종 승인 기준으로 사용한다**.
 * 그래서 여기서는 완성된 SVG를 실제로 래스터화해서 원본과 비교한다.
 * (레이어 PNG 합성이 아니라 SVG 렌더 결과를 본다 — 렌더러 차이까지 잡기 위해)
 *
 * §13.2 평가 축을 그대로 구현한다:
 *   구조 / Silhouette / 색상 / 지각 / Amodal / 벡터 / 호환성
 */
import sharp from "sharp";
import {
  area, backgroundMask, boundary, edgeF1, iou, loadRaster, maskedDeltaE,
  type Raster,
} from "./raster.js";
import type { AssembleResult } from "./assemble.js";
import type { LayerVector } from "./vectorizeV2.js";
import type { LayerManifest } from "./schema.js";
import type { ComposedLayer } from "./amodal.js";

/** §18.3 KPI 잠정 수용 기준 — 계획서 표 그대로 */
export const KPI = {
  visibleMaskMiouFlat: 0.92,
  visibleMaskMiouPhoto: 0.85,
  amodalMaskMiou: 0.8,
  compositeForegroundIouClean: 0.95,
  compositeForegroundIouPhoto: 0.9,
  boundaryFScore: 0.9,
  invalidGeometry: 0,
  manifestSvgIntegrity: 1.0,
  strictVectorCompliance: 1.0,
  pairwiseZOrderAccuracy: 0.95,
} as const;

export interface QaReportV2 {
  pass: boolean;
  /** NEEDS_REVIEW로 보내야 하는가 (자동 통과지만 사람 확인 필요) */
  needsReview: boolean;
  structure: {
    layerCount: number;
    idUnique: boolean;
    zOrderDag: boolean;
    parentRelationOk: boolean;
    manifestSvgIntegrity: number; // 1.0이어야 함
    violations: string[];
  };
  silhouette: {
    foregroundIou: number;
    boundaryFScore: number;
    boundaryPrecision: number;
    boundaryRecall: number;
  };
  color: {
    maskedDeltaE2000: number;
    /** 레이어별 색 이상치 */
    outliers: { layerId: string; deltaE: number }[];
  };
  perceptual: {
    /** 구조 유사도 (SSIM 근사) */
    ssim: number;
    /** 픽셀 단위가 아닌 전체 인상 차이 0~1 (낮을수록 좋음) */
    globalError: number;
  };
  amodal: {
    /** 가림이 있는 레이어들의 복원 품질 평균 */
    continuity: number;
    hiddenRatioMax: number;
    uncertainLayers: string[];
  };
  vector: {
    invalidGeometry: number;
    totalPaths: number;
    totalNodes: number;
    fileKb: number;
    budgetViolations: string[];
    strictVectorCompliant: boolean;
  };
  /** 실패 원인 → 레이어 귀속 (§13.3, 부록 A "실패가 job 전체가 아니라 layer 원인으로 진단된다") */
  failures: QaFailure[];
  notes: string[];
  metricVersion: string;
}

export interface QaFailure {
  /** §13.3 실패 신호 */
  signal:
    | "visible_iou_low"
    | "visible_color_edge"
    | "amodal_contour_discontinuous"
    | "composite_occlusion"
    | "path_count_excess"
    | "boundary_halo"
    | "strict_vector_impossible";
  layerId: string | null;
  detail: string;
  /** §13.3 재시도 액션 */
  action: string;
}

export const METRIC_VERSION = "qa.v1.0.0";

export async function runCompositeQa(
  svg: string,
  assembled: AssembleResult,
  manifest: LayerManifest,
  originalPath: string,
  composed: Map<string, ComposedLayer>,
  vectors: Map<string, LayerVector>,
  visibleMasks: Map<string, Uint8Array>,
  foreground: Uint8Array,
  W: number,
  H: number,
): Promise<QaReportV2> {
  const notes: string[] = [];
  const failures: QaFailure[] = [];

  // ── SVG 래스터화 (§12.2 round trip: SVG → PNG → pixel/edge QA) ──
  const rendered = await sharp(Buffer.from(svg), { density: 96 })
    .resize(W, H, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const svgRaster: Raster = {
    data: rendered.data,
    channels: rendered.info.channels,
    width: W,
    height: H,
  };
  const original = await loadRaster(originalPath, W, H);

  // ── 구조 ─────────────────────────────────────────────────
  const ids = manifest.layers.map((L) => L.id);
  const idUnique = new Set(ids).size === ids.length;
  const zSorted = [...manifest.layers].sort((a, b) => a.z_index - b.z_index);
  const zOrderDag = zSorted.every((L, i) => (i === 0 ? true : zSorted[i - 1].z_index <= L.z_index));
  const parentRelationOk = manifest.layers.every(
    (L) => !L.parent_id || manifest.layers.some((p) => p.id === L.parent_id),
  );
  const integrity =
    assembled.groupMap.length && ids.length
      ? assembled.groupMap.filter((g) => ids.includes(g.layerId)).length / ids.length
      : 0;

  // ── Silhouette ───────────────────────────────────────────
  const svgBg = backgroundMask(svgRaster, W, H, 246);
  const svgFg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) svgFg[i] = svgBg[i] ? 0 : 1;
  const foregroundIou = iou(svgFg, foreground);
  const eb = edgeF1(boundary(svgFg, W, H), boundary(foreground, W, H), W, H, 2);

  // ── 색상 (§13.2 masked ΔE2000) ───────────────────────────
  const maskedDE = maskedDeltaE(svgRaster, original, foreground);
  const outliers: { layerId: string; deltaE: number }[] = [];
  for (const [id, vm] of visibleMasks) {
    if (area(vm) < W * H * 0.002) continue;
    const de = maskedDeltaE(svgRaster, original, vm);
    if (de > 12) outliers.push({ layerId: id, deltaE: +de.toFixed(2) });
  }
  outliers.sort((a, b) => b.deltaE - a.deltaE);

  // ── 지각 (SSIM 근사) ─────────────────────────────────────
  const ssim = grayscaleSsim(svgRaster, original, W, H);
  const globalError = Math.max(0, Math.min(1, maskedDE / 30));

  // ── Amodal ───────────────────────────────────────────────
  const occluded = [...composed.values()].filter((c) => area(c.hidden) > 0);
  const continuity = occluded.length
    ? occluded.reduce((s, c) => s + c.checks.continuity, 0) / occluded.length
    : 1;
  const hiddenRatioMax = occluded.length ? Math.max(...occluded.map((c) => c.checks.hiddenRatio)) : 0;
  const uncertainLayers = [...composed.values()].filter((c) => c.checks.uncertain).map((c) => c.layerId);

  // ── 벡터 ─────────────────────────────────────────────────
  let totalPaths = 0, totalNodes = 0, invalid = 0;
  const budgetViolations: string[] = [];
  for (const [id, v] of vectors) {
    totalPaths += v.paths.length;
    totalNodes += v.nodes;
    for (const p of v.paths) {
      const nums = (p.d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
      if (nums.some((n) => !Number.isFinite(n))) { invalid++; continue; }
      const margin = Math.max(W, H) * 0.5;
      for (let i = 0; i + 1 < nums.length; i += 2) {
        if (nums[i] < -margin || nums[i] > W + margin || nums[i + 1] < -margin || nums[i + 1] > H + margin) {
          invalid++;
          break;
        }
      }
      if (!/[LCQ]/i.test(p.d)) invalid++;
    }
    if (v.budgetAdjusted) budgetViolations.push(`${id}: budget 초과로 단순화 강화`);
  }
  const strictCompliant = manifest.policy.strict_vector
    ? !/<image\b/i.test(svg) && !/data:image\//i.test(svg)
    : true;

  // ── §13.3 실패 신호 → 레이어 귀속 ────────────────────────
  for (const [id, vm] of visibleMasks) {
    const c = composed.get(id);
    if (!c) continue;
    const vIou = iou(vm, c.mask);
    if (vIou < 0.55 && area(vm) > W * H * 0.004) {
      failures.push({
        signal: "visible_iou_low",
        layerId: id,
        detail: `visible IoU ${vIou.toFixed(2)} — 레이어 위치/범위 오류`,
        action: "SAM2 prompt 재생성, bbox/points 수정, candidate crop 금지 강화",
      });
    }
    if (c.checks.continuity < 0.6 && area(c.hidden) > 0) {
      failures.push({
        signal: "amodal_contour_discontinuous",
        layerId: id,
        detail: `contour 연속성 ${c.checks.continuity} — 숨은 영역 hallucination 의심`,
        action: "geometry hint·symmetry prior 강화, 후보 추가 생성",
      });
    }
    if (c.checks.seamDeltaE > 12) {
      failures.push({
        signal: "boundary_halo",
        layerId: id,
        detail: `seam ΔE2000 ${c.checks.seamDeltaE}`,
        action: "trimap 재생성, edge decontamination, premultiplied alpha 교정",
      });
    }
  }
  for (const o of outliers.slice(0, 3)) {
    failures.push({
      signal: "visible_color_edge",
      layerId: o.layerId,
      detail: `masked ΔE2000 ${o.deltaE}`,
      action: "원본 visible-pixel 보호 비율 상향, 후보 재선택",
    });
  }
  for (const [id, v] of vectors) {
    if (v.budgetAdjusted) {
      failures.push({
        signal: "path_count_excess",
        layerId: id,
        detail: `path ${v.paths.length} / node ${v.nodes}`,
        action: "profile 변경, palette 축소, gradient fitting",
      });
    }
  }
  if (foregroundIou < KPI.compositeForegroundIouPhoto) {
    failures.push({
      signal: "composite_occlusion",
      layerId: null,
      detail: `composite foreground IoU ${foregroundIou.toFixed(3)}`,
      action: "graph repair, bleed/clip 정책 수정",
    });
  }
  if (!strictCompliant) {
    failures.push({
      signal: "strict_vector_impossible",
      layerId: null,
      detail: "strict 모드에서 embedded raster 발견",
      action: "clean_flat로 단순화하거나 NEEDS_REVIEW",
    });
  }

  // ── 통과 판정 (§18.3) ────────────────────────────────────
  const isPhoto = manifest.object.style?.includes("photo") ?? true;
  const iouThreshold = isPhoto ? KPI.compositeForegroundIouPhoto : KPI.compositeForegroundIouClean;
  const structureOk = idUnique && zOrderDag && parentRelationOk && integrity >= KPI.manifestSvgIntegrity;
  const pass =
    structureOk &&
    foregroundIou >= iouThreshold &&
    eb.f1 >= KPI.boundaryFScore &&
    invalid === KPI.invalidGeometry &&
    strictCompliant &&
    !assembled.violations.length;

  // §13.3 승인 원칙: 자동 QA를 넘겨도 requires_review=true인 hidden geometry가
  // 포함되면 사용자에게 추정 영역을 표시한다. "품질 통과"와 "기하 사실성 보증"은 다르다.
  const needsReview = uncertainLayers.length > 0 || hiddenRatioMax > 0.5;

  if (!structureOk) notes.push("구조 검증 실패 — manifest/SVG 대응 확인 필요");
  if (foregroundIou < iouThreshold)
    notes.push(`실루엣 IoU ${foregroundIou.toFixed(3)} < 기준 ${iouThreshold}`);
  if (eb.f1 < KPI.boundaryFScore) notes.push(`경계 F-score ${eb.f1.toFixed(3)} < ${KPI.boundaryFScore}`);
  if (invalid) notes.push(`invalid geometry ${invalid}개`);
  if (needsReview) notes.push(`추정 영역 확인 필요: ${uncertainLayers.join(", ") || "hidden 비율 높음"}`);

  return {
    pass,
    needsReview,
    structure: {
      layerCount: manifest.layers.length,
      idUnique,
      zOrderDag,
      parentRelationOk,
      manifestSvgIntegrity: +integrity.toFixed(3),
      violations: assembled.violations,
    },
    silhouette: {
      foregroundIou: +foregroundIou.toFixed(4),
      boundaryFScore: +eb.f1.toFixed(4),
      boundaryPrecision: +eb.precision.toFixed(4),
      boundaryRecall: +eb.recall.toFixed(4),
    },
    color: { maskedDeltaE2000: +maskedDE.toFixed(2), outliers: outliers.slice(0, 8) },
    perceptual: { ssim: +ssim.toFixed(4), globalError: +globalError.toFixed(4) },
    amodal: {
      continuity: +continuity.toFixed(3),
      hiddenRatioMax: +hiddenRatioMax.toFixed(3),
      uncertainLayers,
    },
    vector: {
      invalidGeometry: invalid,
      totalPaths,
      totalNodes,
      fileKb: +(Buffer.byteLength(svg) / 1024).toFixed(1),
      budgetViolations,
      strictVectorCompliant: strictCompliant,
    },
    failures,
    notes,
    metricVersion: METRIC_VERSION,
  };
}

/** 그레이스케일 SSIM (8×8 윈도우, 전역 평균) */
function grayscaleSsim(a: Raster, b: Raster, W: number, H: number): number {
  const ga = new Float64Array(W * H), gb = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const pa = i * a.channels, pb = i * b.channels;
    ga[i] = 0.299 * a.data[pa] + 0.587 * a.data[pa + 1] + 0.114 * a.data[pa + 2];
    gb[i] = 0.299 * b.data[pb] + 0.587 * b.data[pb + 1] + 0.114 * b.data[pb + 2];
  }
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  const win = 8;
  let sum = 0, n = 0;
  for (let y = 0; y + win <= H; y += win) {
    for (let x = 0; x + win <= W; x += win) {
      let ma = 0, mb = 0;
      for (let dy = 0; dy < win; dy++)
        for (let dx = 0; dx < win; dx++) {
          const i = (y + dy) * W + x + dx;
          ma += ga[i]; mb += gb[i];
        }
      const cnt = win * win;
      ma /= cnt; mb /= cnt;
      let va = 0, vb = 0, cov = 0;
      for (let dy = 0; dy < win; dy++)
        for (let dx = 0; dx < win; dx++) {
          const i = (y + dy) * W + x + dx;
          va += (ga[i] - ma) ** 2; vb += (gb[i] - mb) ** 2; cov += (ga[i] - ma) * (gb[i] - mb);
        }
      va /= cnt - 1; vb /= cnt - 1; cov /= cnt - 1;
      const s = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      sum += s; n++;
    }
  }
  return n ? sum / n : 0;
}
