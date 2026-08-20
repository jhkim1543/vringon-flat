/**
 * S09 후보 평가·선택 — 개발계획서 §13.1.
 *
 * 식 2를 그대로 구현한다:
 *
 *   S_layer =
 *       w_mask  * IoU(visible_mask, candidate_alpha)
 *     + w_edge  * EdgeF1(original_visible, candidate_visible)
 *     + w_color * (1 - normalized_DeltaE2000)
 *     + w_shape * ShapePriorScore(amodal_contour)
 *     + w_graph * OcclusionConsistency
 *     - w_hall  * HallucinationPenalty
 *     - w_comp  * VectorComplexityPenalty
 *
 * 그리고 §13.1의 지적대로 **개별 최고점만 고르면 전체 조합이 어긋날 수 있으므로**
 * 레이어별 top-K를 만든 뒤 beam search로 global composite score를 최적화한다.
 */
import {
  area, boundary, deltaE2000Rgb, dilate, edgeF1, iou, subtract, union,
  type Raster,
} from "./raster.js";
import type { ComposedLayer } from "./amodal.js";
import type { LayerManifest, ManifestLayer } from "./schema.js";

export interface ScoreWeights {
  mask: number;
  edge: number;
  color: number;
  shape: number;
  graph: number;
  hallucination: number;
  complexity: number;
}

/**
 * 기본 가중치. mask·edge가 가장 무겁다 — 원본 가시영역 충실도가 1순위이기 때문이다
 * (P3, §2.2 "원본 가시영역은 원본 픽셀/마스크를 최대한 보존한다").
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  mask: 0.30,
  edge: 0.22,
  color: 0.18,
  shape: 0.12,
  graph: 0.10,
  hallucination: 0.20,
  complexity: 0.08,
};

export interface LayerScore {
  total: number;
  mask: number;
  edge: number;
  color: number;
  shape: number;
  graph: number;
  hallucination: number;
  complexity: number;
}

/**
 * 한 후보(합성 완료본)의 점수.
 *
 * @param composed 식 1로 합성된 레이어
 * @param visible  S04 가시 마스크 (기준)
 * @param original 원본 캔버스
 * @param siblings 같은 조합에 들어갈 다른 레이어의 가시 마스크 — occlusion 일관성 검사용
 */
export function scoreLayer(
  layer: ManifestLayer,
  composed: ComposedLayer,
  visible: Uint8Array,
  original: Raster,
  W: number,
  H: number,
  manifest: LayerManifest,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): LayerScore {
  const N = W * H;

  // ── mask: 가시 마스크가 후보 알파 안에 얼마나 잘 들어가는가 ──
  // amodal은 visible보다 크므로 순수 IoU는 구조적으로 낮다. 그래서
  // containment(가시영역 보존율)와 IoU를 함께 본다.
  let inside = 0;
  for (let i = 0; i < N; i++) if (visible[i] && composed.mask[i]) inside++;
  const containment = area(visible) ? inside / area(visible) : 0;
  const maskScore = 0.7 * containment + 0.3 * iou(visible, composed.mask);

  // ── edge: 원본 가시 경계와 후보 가시 경계의 일치 ─────────
  const gtEdge = boundary(visible, W, H);
  const candVisible = new Uint8Array(N);
  for (let i = 0; i < N; i++) candVisible[i] = composed.mask[i] && visible[i] ? 1 : 0;
  const predEdge = boundary(candVisible, W, H);
  const edgeScore = edgeF1(predEdge, gtEdge, W, H, 2).f1;

  // ── color: 가시영역의 색 오차 (원본 대비) ────────────────
  // 식 1에서 visible은 원본을 그대로 쓰므로 여기서 재는 것은 사실상
  // hidden 영역이 visible의 재질과 이어지는지(seam)와 decontamination 부작용이다.
  let sum = 0, n = 0;
  const step = Math.max(1, Math.floor(area(visible) / 3000));
  let seen = 0;
  for (let i = 0; i < N; i++) {
    if (!visible[i]) continue;
    if (seen++ % step) continue;
    const p = i * original.channels, q = i * 3;
    sum += deltaE2000Rgb(
      original.data[p], original.data[p + 1], original.data[p + 2],
      composed.rgb[q], composed.rgb[q + 1], composed.rgb[q + 2],
    );
    n++;
  }
  const meanDE = n ? sum / n : 0;
  // 정규화: ΔE2000 20 이상이면 0점 (인지적으로 확연히 다른 색)
  const colorScore = Math.max(0, 1 - meanDE / 20);

  // ── shape: amodal contour의 형상 prior (§8.3) ────────────
  const c = composed.checks;
  const shapeScore =
    0.45 * c.continuity +
    0.25 * c.widthConsistency +
    0.15 * c.symmetry +
    0.15 * Math.max(0, 1 - c.seamDeltaE / 15);

  // ── graph: occlusion 일관성 ──────────────────────────────
  // manifest가 "이 레이어는 X에 가려진다"고 했으면, hidden 영역은 X의 가시영역과
  // 겹쳐야 한다. 엉뚱한 곳을 채웠으면 그래프와 어긋난 것이다.
  const graphScore = occlusionConsistency(layer, composed, manifest, W, H);

  // ── hallucination 페널티 ─────────────────────────────────
  // (a) 본체와 떨어진 조각, (b) 원본 실루엣 밖으로 크게 벗어남,
  // (c) hidden 비율이 비상식적으로 큼
  const hall = hallucinationPenalty(composed, visible, W, H);

  // ── vector complexity 페널티 ─────────────────────────────
  // 경계 길이/면적 비가 크면 벡터화 후 path·node가 폭증한다 (§13.1 VectorComplexityPenalty)
  const a = area(composed.mask);
  const per = area(boundary(composed.mask, W, H));
  const complexity = a ? Math.min(1, (per * per) / (a * 4 * Math.PI) / 12) : 1; // 원형도 역수 정규화

  const total =
    weights.mask * maskScore +
    weights.edge * edgeScore +
    weights.color * colorScore +
    weights.shape * shapeScore +
    weights.graph * graphScore -
    weights.hallucination * hall -
    weights.complexity * complexity;

  return {
    total: +total.toFixed(4),
    mask: +maskScore.toFixed(3),
    edge: +edgeScore.toFixed(3),
    color: +colorScore.toFixed(3),
    shape: +shapeScore.toFixed(3),
    graph: +graphScore.toFixed(3),
    hallucination: +hall.toFixed(3),
    complexity: +complexity.toFixed(3),
  };
}

function occlusionConsistency(
  layer: ManifestLayer,
  composed: ComposedLayer,
  manifest: LayerManifest,
  W: number,
  H: number,
): number {
  const hiddenA = area(composed.hidden);
  if (!hiddenA) return 1; // 가려진 게 없으면 일관성 위반도 없다
  if (!layer.occluded_by.length) {
    // 가려지는 게 없다고 했는데 hidden을 크게 만들었다면 그래프와 불일치
    return Math.max(0, 1 - hiddenA / Math.max(1, area(composed.mask)) / 0.3);
  }
  // hidden 영역이 occluder들의 영역 안에 있는가
  // (occluder의 가시 마스크는 여기서 접근 불가하므로 z가 더 큰 레이어의 bbox로 근사)
  const boxes = layer.occluded_by
    .map((id) => manifest.layers.find((L) => L.id === id))
    .filter(Boolean)
    .map((L) => (L as ManifestLayer).bbox_norm);
  if (!boxes.length) return 0.6;
  let inBox = 0;
  for (let i = 0; i < W * H; i++) {
    if (!composed.hidden[i]) continue;
    const x = (i % W) / W, y = ((i / W) | 0) / H;
    if (boxes.some(([x0, y0, x1, y1]) => x >= x0 - 0.03 && x <= x1 + 0.03 && y >= y0 - 0.03 && y <= y1 + 0.03))
      inBox++;
  }
  return inBox / hiddenA;
}

function hallucinationPenalty(composed: ComposedLayer, visible: Uint8Array, W: number, H: number): number {
  const N = W * H;
  const vis = area(visible), hid = area(composed.hidden);
  if (!vis) return 1;

  // (a) 본체에서 떨어진 hidden 조각 — composeLayer가 이미 제거하지만 잔량 확인
  const near = dilate(visible, W, H, Math.max(3, Math.round(Math.min(W, H) * 0.02)));
  let far = 0;
  for (let i = 0; i < N; i++) if (composed.hidden[i] && !near[i]) far++;
  const detached = hid ? far / hid : 0;

  // (b) hidden이 visible 대비 과도 — 계획서 §8.3 uncertain geometry
  const ratio = hid / (vis + hid);
  const excessive = Math.max(0, (ratio - 0.5) / 0.5);

  return Math.max(0, Math.min(1, 0.6 * detached + 0.4 * excessive));
}

// ── 전역 조합 최적화 (beam search) ──────────────────────────

export interface Choice {
  layerId: string;
  candidateIndex: number;
  score: LayerScore;
  composed: ComposedLayer;
}

export interface GlobalResult {
  chosen: Choice[];
  compositeScore: number;
  beamWidth: number;
  evaluated: number;
}

/**
 * §13.1: "레이어별 top-K를 만든 뒤 beam search 또는 coordinate descent로
 * global composite score를 최적화한다. 레이어가 8개이고 K=4이면 전수 조합은
 * 65,536개이므로, beam width 8-16과 문제 레이어 교체 방식으로 계산량을 제한한다."
 */
export function selectGlobal(
  perLayer: Map<string, Choice[]>,
  order: string[],
  W: number,
  H: number,
  foreground: Uint8Array,
  beamWidth = 12,
): GlobalResult {
  let evaluated = 0;
  type Beam = { picks: Choice[]; score: number };
  let beams: Beam[] = [{ picks: [], score: 0 }];

  for (const layerId of order) {
    const cands = (perLayer.get(layerId) ?? []).slice().sort((a, b) => b.score.total - a.score.total);
    if (!cands.length) continue;
    const next: Beam[] = [];
    for (const b of beams) {
      for (const c of cands) {
        const picks = [...b.picks, c];
        const s = compositeScore(picks, W, H, foreground);
        evaluated++;
        next.push({ picks, score: s });
      }
    }
    next.sort((x, y) => y.score - x.score);
    beams = next.slice(0, beamWidth);
  }

  const best = beams[0] ?? { picks: [], score: 0 };
  return {
    chosen: best.picks,
    compositeScore: +best.score.toFixed(4),
    beamWidth,
    evaluated,
  };
}

/**
 * 전역 합성 점수 — 개별 점수 평균 + 조합 품질(겹침·커버리지).
 * "레이어별 점수가 높아도 전체 합성에서 색·경계·가림이 틀릴 수 있으므로
 *  global composite score를 최종 승인 기준으로 사용한다"(P5).
 */
function compositeScore(picks: Choice[], W: number, H: number, foreground: Uint8Array): number {
  if (!picks.length) return 0;
  const meanLayer = picks.reduce((s, p) => s + p.score.total, 0) / picks.length;

  const N = W * H;
  const cover = new Uint8Array(N);
  for (const p of picks) for (let i = 0; i < N; i++) if (p.composed.mask[i]) cover[i] = 1;

  // 커버리지: 전경을 얼마나 덮는가
  let fgN = 0, covered = 0, spill = 0, bgN = 0;
  for (let i = 0; i < N; i++) {
    if (foreground[i]) { fgN++; if (cover[i]) covered++; }
    else { bgN++; if (cover[i]) spill++; }
  }
  const coverage = fgN ? covered / fgN : 0;
  const spillRatio = bgN ? spill / bgN : 0;

  // 겹침: 가시영역이 서로 심하게 겹치면 z-order가 잘못된 것
  let overlap = 0;
  const seen = new Uint8Array(N);
  for (const p of picks) {
    for (let i = 0; i < N; i++) {
      if (!p.composed.visible[i]) continue;
      if (seen[i]) overlap++;
      else seen[i] = 1;
    }
  }
  const overlapRatio = fgN ? overlap / fgN : 0;

  return 0.55 * meanLayer + 0.28 * coverage - 0.1 * spillRatio - 0.07 * overlapRatio;
}

export { union, subtract };
