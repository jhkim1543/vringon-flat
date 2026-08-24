/**
 * 성분 → 표현 라우터. **한 성분에는 한 표현만.**
 *
 * V3의 `isStructural()`은 길이와 `length/width` 두 개만 봤다. 주석에는 "폭이 안정적인"이라
 * 써 놨지만 폭의 안정성을 재지 않았고, 교차점도 보지 않았다. 그래서 굵기가 들쭉날쭉한 로고
 * 덩어리나 교차가 잔뜩인 끈 뭉치도 길기만 하면 stroke로 승격됐다 — centerline이 가장 못하는
 * 두 경우다.
 *
 * 여기서는 성분마다 아래를 보고 **하나만** 고른다. 왜 그렇게 골랐는지도 함께 남긴다 —
 * 결과만 보고 원인을 되짚을 수 없으면 다음 사람이 같은 실수를 반복한다.
 */
import type { PrimitiveClass, RouteReason } from "./types.js";
import type { ComponentEvidence } from "./evidence.js";
import type { FitResult } from "./primitives.js";

export interface RouteContext {
  /** 작업 캔버스 */
  width: number;
  height: number;
  /** 선/면을 가르는 굵기 기준 */
  lineWidthLimit: number;
  /** 이 성분이 속한 패턴 군집 (있으면) */
  inPattern: boolean;
  /** 이 성분이 속한 점선 사슬 (있으면) */
  inDash: boolean;
  /** 프리미티브 적합 결과 (있으면) */
  fit: FitResult | null;
}

export interface RouteThresholds {
  /** 이 길이(캔버스 최소변 비율) 이상이어야 구조선 후보 */
  minStrokeLenRatio: number;
  /** 길이/굵기가 이보다 커야 구조선 */
  minElongation: number;
  /** 폭 변동계수가 이보다 작아야 구조선 */
  maxWidthCv: number;
  /** 골격 길이당 분기점이 이보다 많으면 centerline이 무너진다 */
  maxJunctionDensity: number;
  /** 프리미티브 승격 잔차 (캔버스 최소변 비율) */
  primitiveToleranceRatio: number;
}

export const DEFAULT_THRESHOLDS: RouteThresholds = {
  minStrokeLenRatio: 0.03,
  minElongation: 8,
  // 0.35 는 V3 주석이 주장만 하고 재지 않던 값이다. 여기서 실제로 쓴다.
  maxWidthCv: 0.35,
  maxJunctionDensity: 0.02,
  // 캔버스 최소변 대비. 0.004 는 헐거웠다 — 2118px 캔버스에서 8.5px 라 어지간한 곡선이
  // 전부 타원으로 승격됐다. 0.0025 로 조이고, primitives.ts 가 rms 도 함께 본다.
  primitiveToleranceRatio: 0.0025,
};

export function routeComponent(
  ev: ComponentEvidence,
  ctx: RouteContext,
  th: RouteThresholds = DEFAULT_THRESHOLDS,
): RouteReason {
  const minSide = Math.min(ctx.width, ctx.height);
  const features: Record<string, number | boolean> = {
    area: ev.area,
    skeletonLength: ev.skeletonLength,
    widthMedian: ev.widthMedian,
    widthCv: ev.widthCv,
    elongation: ev.elongation,
    junctions: ev.junctions,
    junctionDensity: ev.junctionDensity,
    endpoints: ev.endpoints,
    holes: ev.holes,
    fillRatio: ev.fillRatio,
    inPattern: ctx.inPattern,
    inDash: ctx.inDash,
    fitKind: ctx.fit ? 1 : 0,
    fitMax: ctx.fit?.max ?? -1,
  };

  const pick = (chosen: PrimitiveClass, why: string, confidence: number): RouteReason =>
    ({ chosen, features, why, confidence: +confidence.toFixed(3) });

  // 1) 점선 사슬 — 모티프 반복보다 carrier + dasharray 가 낫다 (패스 하나, 간격도 값 하나)
  if (ctx.inDash) return pick("DASH_OR_STITCH", "일정 간격으로 늘어선 작은 성분 — 점선 스티치", 0.85);

  // 2) 반복 모티프
  if (ctx.inPattern) return pick("REPEATING_PATTERN", "같은 모양이 여러 번 반복 — 모티프 하나로 압축", 0.8);

  // 3) 기하 프리미티브. 잔차로만 판단한다 — "링이니까 원"은 하지 않는다.
  if (ctx.fit) {
    const tol = minSide * th.primitiveToleranceRatio;
    const margin = 1 - ctx.fit.max / Math.max(tol, 1e-6);
    return pick(
      "GEOMETRIC_PRIMITIVE",
      `${ctx.fit.kind} 적합 잔차 max ${ctx.fit.max}px (허용 ${tol.toFixed(1)}px) — 앵커 ${ctx.fit.anchors}개로 표현`,
      Math.max(0.5, Math.min(0.98, 0.5 + margin / 2)),
    );
  }

  // 4) 구조선. 네 조건을 **모두** 만족해야 한다.
  const longEnough = ev.skeletonLength >= minSide * th.minStrokeLenRatio;
  const slender = ev.elongation >= th.minElongation;
  const steadyWidth = ev.widthCv <= th.maxWidthCv;
  const cleanJunctions = ev.junctionDensity <= th.maxJunctionDensity;
  const notSolid = ev.widthMedian <= ctx.lineWidthLimit * 1.5;

  if (longEnough && slender && steadyWidth && cleanJunctions && notSolid) {
    // 여유가 클수록 확신이 크다
    const m = Math.min(
      ev.elongation / th.minElongation,
      th.maxWidthCv / Math.max(ev.widthCv, 1e-3),
      th.maxJunctionDensity / Math.max(ev.junctionDensity, 1e-4),
    );
    return pick(
      "STRUCTURAL_STROKE",
      `길이 ${ev.skeletonLength}px · 길이/굵기 ${ev.elongation} · 폭 변동 ${ev.widthCv} · 분기밀도 ${ev.junctionDensity}`,
      Math.max(0.55, Math.min(0.97, 0.55 + Math.log2(Math.max(1, m)) / 6)),
    );
  }

  // 5) 나머지는 outline. 왜 구조선이 못 됐는지 남긴다.
  const fail: string[] = [];
  if (!longEnough) fail.push(`짧음(${ev.skeletonLength} < ${Math.round(minSide * th.minStrokeLenRatio)})`);
  if (!slender) fail.push(`뭉툭함(길이/굵기 ${ev.elongation} < ${th.minElongation})`);
  if (!steadyWidth) fail.push(`폭이 들쭉날쭉(${ev.widthCv} > ${th.maxWidthCv})`);
  if (!cleanJunctions) fail.push(`교차 많음(${ev.junctionDensity} > ${th.maxJunctionDensity})`);
  if (!notSolid) fail.push(`선이 아니라 면(굵기 ${ev.widthMedian})`);
  // 조건을 아슬아슬하게 놓친 것은 확신이 낮다 — QA가 검토로 올린다
  const nearMiss = fail.length === 1;
  return pick("OUTLINE_SHAPE", `구조선 조건 미달: ${fail.join(", ")}`, nearMiss ? 0.55 : 0.85);
}
