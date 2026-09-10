/**
 * 3-gate QA — 충실도 · 편집성 · 의미.
 *
 * V3는 PASS 하나로 모든 품질을 표현했다. 그래서 "원본과 똑같지만 패스가 3,583개"인 결과와
 * "패스는 적지만 디테일이 빠진" 결과를 같은 말로 부르게 됐다. 둘은 다른 실패다.
 *
 * V4는 세 관문을 **따로** 통과시킨다. 하나가 막혀도 나머지는 그대로 보고한다.
 */
import sharp from "sharp";
import { inkMask, svgInkMask, fidelity, detailRecall, topology, distanceTransform, type Mask } from "../v3/metrics.js";
import { dilate } from "../v2/raster.js";
import { samplePath, flattenPath } from "../v3/pathSample.js";
import { complexity, renderStandalone, isInkPrimitive } from "./export.js";
import { splitCompound } from "./compound.js";
import { skeletonize } from "../vector/centerline.js";
import type { GeometricPrimitive, PatternPrimitive, ScenePrimitive, StrokePrimitive, VectorScene } from "./types.js";

export interface FidelityGate {
  pass: boolean;
  f0: number;
  f1: number;
  f2: number;
  /** 해프톤 영역을 뺀 선 충실도 — 합격 판정 기준 */
  lineF1: number;
  lineF2: number;
  /** 배송본(얇은 마감 사다리 폭 그대로)의 선 F@2 — 채점본(lineF2)과 함께 보고한다 */
  shippedLineF2?: number;
  textureShare: number;
  inkRatio: number;
  chamfer: number;
  p95: number;
  detailRecall: number;
  /** 도면 / 벡터의 구멍 수 */
  holes: [number, number];
  /** 라인 모드 전용 — 골격 대 골격 F@3px */
  skeletonF3?: number;
  skeletonChamfer?: number;
  majorComponents: [number, number];
  notes: string[];
}

export interface EditabilityGate {
  pass: boolean;
  /** <path> 요소 수 */
  paths: number;
  /**
   * **실제 도형 수.** 하나의 path 요소 안에 M…Z 가 수백 개 들어갈 수 있다.
   * 요소 수만 세면 컴파운드 패스가 1개로 집계돼 편집성을 크게 과대평가한다.
   */
  subpaths: number;
  /** 한 패스가 가진 최대 서브패스 수 */
  maxSubpathsInPath: number;
  /**
   * **쪼갤 수 있는데 안 쪼갠** 최대 서브패스 수.
   *
   * 서브패스가 많다고 다 나쁜 게 아니다. 그물의 웹은 바깥 윤곽 하나에 셀 구멍 수백 개가
   * 뚫린 **진짜 한 덩이**라, 쪼개면 even-odd 가 깨져 구멍이 메워진다. 그건 컴파운드
   * 패스가 옳은 표현이다. 반대로 서로 무관한 도형이 한 패스에 뭉쳐 있으면 쪼개야 한다.
   * gate 는 실제로 쪼개 보고 남은 최대치를 본다 — 실측: 9종의 160 초과 패스 4개가
   * 전부 쪼갤 수 없는 한 덩이였다.
   */
  maxSplittableSubpaths: number;
  /** 요소 + 서브패스 + use 인스턴스 — Illustrator 에서 실제로 다루게 되는 객체 규모 */
  objectComplexity: number;
  anchors: number;
  uses: number;
  kb: number;
  /** 윤곽 100px 당 앵커 — 제품 복잡도로 정규화 */
  anchorDensity: number;
  /** 길이가 캔버스 최소변의 1% 미만인 **서브패스** 비율 */
  shortPathRatio: number;
  /** 프리미티브로 표현된 성분 수와 절감 앵커 */
  primitives: number;
  anchorsSavedByPrimitives: number;
  /** 패턴으로 압축된 패스 수 */
  pathsSavedByPatterns: number;
  /** fidelity 대비 editable 의 절감 */
  editableReduction: { paths: number; anchors: number; kb: number };
  notes: string[];
}

/**
 * 마스크 정합 하한. 이 아래면 잉크의 절반 이상이 마스크가 아니라 이웃 상속(BFS)으로
 * 주인을 얻었다는 뜻 — 배분이 추측이 된다. 0.7 은 안전 여유를 둔 값이고, 현재 9종은
 * 전부 0.716 이상이라 이 조건은 **지금 아무도 떨어뜨리지 않는다**. 등급이 아니라
 * 실패 모드를 잡기 위한 장치다.
 */
/**
 * 디테일 지표의 바닥(px). 파이프라인의 `minComponentPx`(12) 와 같은 값이어야 한다 —
 * 다르면 "버리기로 계약한 잡티"가 손실로 잡힌다.
 */
const DETAIL_MIN_PX = Number(process.env.V4_DETAIL_MIN ?? 12);

/**
 * 정밀도 판정의 "빈 종이" 기준. 이보다 어두우면 도면에 **무언가 그려져 있다**고 본다.
 * 215 는 실측으로 정했다 — 크로커다일 무늬가 그레이 176~207 에 있고, 순수 종이와
 * 안티에일리어싱 띠는 220 위에 있다.
 */
const SOFT_INK = Number(process.env.V4_SOFT_INK ?? 215);

const MASK_FIT_MIN = 0.7;

export interface SemanticGate {
  pass: boolean;
  /**
   * 파트별 실측. `kind` 는 면 파트(area)와 얇은 선 파트(thin)를 가른다 —
   * 끈·체인·각인을 면 IoU 로 재면 구조적으로 낮게 나와 비교가 안 된다.
   */
  perPart: {
    id: string; label: string; kind: "area" | "thin";
    paths: number; areaShare: number;
    precision: number; recall: number; iou: number; boundaryF1: number;
  }[];
  meanPrecision: number;
  /** 면적 가중 평균 IoU — 큰 파트가 통째로 빠지면 크게 떨어진다 */
  weightedMeanIou: number;
  /** 기준 미달인 주요 파트 */
  failingMajorParts: string[];
  /** 파트 마스크가 도면 잉크를 직접 덮은 비율 (0~1) */
  maskFit: number;
  misassigned: string[];
  emptyVisibleParts: string[];
  sharedOnlyParts: string[];
  /**
   * 계획에는 있지만 **도면에 사실상 없는** 파트 (마스크가 캔버스의 0.05% 미만).
   * 벡터화가 놓친 것이 아니라 GPT 파트 계획과 도면이 어긋난 것이다 — 판정 대상이
   * 아니라 보고 대상이다. 섞어 세면 "레이어가 빠졌다"로 잘못 읽힌다.
   */
  absentInSchematic: string[];
  sharedBoundaries: number;
  aspectRatio: number;
  /** 라우터가 확신하지 못한 성분 수 */
  lowConfidenceRoutes: number;
  notes: string[];
}

export interface QA4 {
  fidelity: FidelityGate;
  editability: EditabilityGate;
  semantic: SemanticGate;
  /** 세 관문의 조합 상태 */
  state: string;
}

/** 마스크가 감싼 구멍 수 — 배경 flood fill 로 도달 못한 빈칸 덩어리 */
function countHoles(m: Mask): number {
  const { data, width: W, height: H } = m;
  const N = W * H;
  const seen = new Uint8Array(N);
  const q = new Int32Array(N);
  let head = 0, tail = 0;
  const push = (i: number) => { if (!seen[i] && !data[i]) { seen[i] = 1; q[tail++] = i; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (head < tail) {
    const i = q[head++], x = i % W, y = (i / W) | 0;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (y > 0) push(i - W);
    if (y < H - 1) push(i + W);
  }
  let holes = 0;
  const hs = new Uint8Array(N);
  const minHole = Math.max(9, Math.round(N * 0.000004));
  for (let s = 0; s < N; s++) {
    if (data[s] || seen[s] || hs[s]) continue;
    let sp = 0, n = 0;
    q[sp++] = s; hs[s] = 1;
    while (sp) {
      const i = q[--sp], x = i % W, y = (i / W) | 0;
      n++;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
      for (const k of nb) if (k >= 0 && !data[k] && !seen[k] && !hs[k]) { hs[k] = 1; q[sp++] = k; }
    }
    if (n >= minHole) holes++;
  }
  return holes;
}

/**
 * 잉크로 볼 것만 남긴 SVG. 면(FACE_FILL)과 면에서 온 기하 프리미티브는 잉크가 아니다.
 *
 * **정본 렌더러로 다시 그린다.** 최종 SVG 문자열을 정규식으로 깎으면 패턴의 `<use>` 가
 * defs 없이 남아 아무것도 안 그려지고, 면 프리미티브도 걸러지지 않는다.
 */
export function inkSvg(scene: VectorScene): string {
  const { width: W, height: H } = scene.canvas;
  const prims = scene.primitives.filter(isInkPrimitive);
  return renderStandalone(prims, W, H, "ink");
}

/** SVG 의 서브패스 통계 — 컴파운드 패스가 몇 개의 도형을 숨기고 있는가 */
function subpathStats(svg: string): { subpaths: number; maxInPath: number; maxSplittable: number } {
  let total = 0, max = 0, maxSplit = 0;
  // 경계 없이 d="…" 로 찾으면 data-shared="main_compartment_shell" 같은 값의 m 까지 센다.
  for (const m of svg.matchAll(new RegExp('(?:^|[\\s"])d="([^"]*)"', "g"))) {
    const n = (m[1].match(new RegExp("[Mm]", "g")) ?? []).length;
    total += n;
    if (n > max) max = n;
    // 실제로 쪼개 본다. 조각이 하나로 나오면 **쪼갤 수 없는 한 덩이**다 —
    // 바깥 윤곽 하나에 구멍이 뚫린 그물의 웹이 그렇고, 그건 컴파운드 패스가 옳은 표현이다.
    // 그런 것을 세면 지표가 피할 수 없는 것을 벌한다. 둘 이상으로 쪼개지는데도 한 패스에
    // 남아 있다면 그것이 진짜 결함이다(export 가 이미 쪼개므로 정상이면 0 이어야 한다).
    if (n > 160 && splitCompound(m[1], 160).length > 1 && n > maxSplit) maxSplit = n;
    else if (n <= 160 && n > maxSplit) maxSplit = n;
  }
  return { subpaths: total, maxInPath: max, maxSplittable: maxSplit };
}

export async function runQa4(
  scene: VectorScene,
  refPng: string,
  svgs: { fidelity: string; editable: string; production: string },
  ctx: {
    texture?: Uint8Array;
    /**
     * 라인 모드 — 면이 없는 중심선 스트로크 장면. 파트 판정 기준이 달라진다:
     * 면 파트도 기하가 얇은 선뿐이라 **면적 IoU 가 원리적으로 무너진다**(실측 0.283).
     * 전 파트를 thin(경계 F1) 기준으로 판정하고 면적 가중 IoU 게이트는 끈다.
     */
    lineMode?: boolean;
    /**
     * 장면이 면을 만들지 않았다(얇은 마감 — 로고·글씨 빼고 전부 선). 잉크 채점은
     * 그대로 유효하지만(면은 원래 잉크가 아니다) 파트 판정의 면적 IoU 는 원리적으로
     * 무너지므로 lineMode 와 같은 thin(경계 F1) 기준으로 판정한다.
     */
    noFaces?: boolean;
    partMasks: { id: string; mask: Uint8Array }[];
    aspectRatio: number;
    thresholds?: { f2: number; detail: number; anchorDensity: number; precision: number };
    /**
     * 파트 마스크가 도면 잉크를 직접 덮은 비율. 낮으면 마스크가 도면 위 엉뚱한 자리에
     * 있다는 뜻이고, 그때 파트 배분은 추측이 된다.
     */
    maskFit?: number;
  },
): Promise<QA4> {
  // 얇은 마감(--thin)은 표현 폭이다. 채점은 누르기 전 폭(qaWidth)으로 다시 그려
  // "경로가 도면과 일치하나"만 묻는다 — 안 그러면 의도한 얇기가 "선 굵기 0.18×"
  // 같은 가짜 벌점이 된다(실측 th_shoe_1).
  // 배송본(사다리 폭 그대로)도 따로 잰다 — 채점본만 보고하면 실제로 내보내는 파일을
  // 재지 않은 것이다(외부 검토 지적). 두 값을 다 적는다.
  const sceneShipped = scene;
  if (scene.primitives.some((p) => (p as { qaWidth?: number }).qaWidth != null)) {
    scene = {
      ...scene,
      primitives: scene.primitives.map((p) => {
        const q = (p as { qaWidth?: number }).qaWidth;
        if (q == null) return p;
        // 패턴은 폭이 strokeWidth 에 있다 — 그쪽을 되돌린다
        return p.cls === "REPEATING_PATTERN" ? { ...p, strokeWidth: q } : { ...p, width: q };
      }),
    };
  }
  const { width: W, height: H } = scene.canvas;
  const partThin = !!(ctx.lineMode || ctx.noFaces);
  const th = ctx.thresholds ?? { f2: 0.95, detail: 0.85, anchorDensity: 12, precision: 0.7 };
  /**
   * 디테일 재현율을 **게이트로 쓸 수 있는 최소 표본**. 작은 성분이 셋뿐인 도면에서
   * 하나를 놓치면 67% 가 되어 통과/탈락이 표본 한 개로 갈린다 — 그건 품질이 아니라
   * 잡음이다(실측: jewelry_07 "2개 소실", jewelry_11 "1개 소실"로 탈락).
   * 표본이 이보다 적으면 수치는 그대로 보고하되 게이트 판정에서는 뺀다.
   */
  const DETAIL_MIN_N = Number(process.env.V4_DETAIL_MIN_N ?? 8);

  // ── 충실도 ───────────────────────────────────────────────
  const ref = await inkMask(refPng, W, H);
  // 정밀도 전용의 너그러운 기준선 — "여기 종이가 비어 있었나"를 묻는다. 도면이 질감을
  // 옅은 회색으로 그려 놓은 자리를 벡터가 옳게 잡아낸 것을 날조로 세지 않기 위해서다.
  const refSoft = await inkMask(refPng, W, H, SOFT_INK);
  const vec = await svgInkMask(inkSvg(scene), W, H);
  let softInk = 0;
  for (let i = 0; i < W * H; i++) if (refSoft.data[i]) softInk++;
  const fid = fidelity(ref, vec, [0, 1, 2], refSoft);
  const small = Math.max(6, Math.round(W * H * 0.00008));
  const detail = detailRecall(ref, vec, small, 2, ctx.texture, DETAIL_MIN_PX);
  const topo = topology(ref, vec);

  let lineFid = fid;
  let textureShare = 0;
  // 배송본 선 충실도 — 채점본과 장면이 같으면(얇은 마감 아님) 다시 그리지 않는다
  let shippedLineF2: number | undefined;
  const vecShipped = sceneShipped === scene ? vec : await svgInkMask(inkSvg(sceneShipped), W, H);
  if (ctx.texture) {
    let inTex = 0, tot = 0;
    for (let i = 0; i < W * H; i++) if (ref.data[i]) { tot++; if (ctx.texture[i]) inTex++; }
    textureShare = tot ? inTex / tot : 0;
    if (textureShare > 0.01) {
      const cut = (m: Mask): Mask => {
        const d = new Uint8Array(m.data.length);
        for (let i = 0; i < d.length; i++) d[i] = m.data[i] && !ctx.texture![i] ? 1 : 0;
        return { data: d, width: m.width, height: m.height };
      };
      lineFid = fidelity(cut(ref), cut(vec), [0, 1, 2], cut(refSoft));
      if (vecShipped !== vec) shippedLineF2 = fidelity(cut(ref), cut(vecShipped), [2], cut(refSoft)).f.f2;
    }
  }
  if (shippedLineF2 === undefined && vecShipped !== vec) shippedLineF2 = fidelity(ref, vecShipped, [2], refSoft).f.f2;

  // **라인 모드는 골격 대 골격으로 잰다.** 얇은 실선 마감은 의도적으로 도면보다
  // 잉크가 적다 — 질량 비교는 "선 굵기 0.19×" 같은 가짜 벌점을 만든다(실측 jewelry_1).
  // 이 모드의 질문은 "선의 **경로**가 도면의 선 경로와 일치하나"이므로, 양쪽을 1px
  // 골격으로 접고 3px 허용으로 비교한다(중심선 추정 오차 허용).
  let skelFid: ReturnType<typeof fidelity> | null = null;
  if (ctx.lineMode) {
    // **글리프 영역은 골격 비교에서 뺀다.** 각인 글자는 라인 모드에서도 면으로
    // 유지하는데, 면의 골격은 글자 모양의 뼈대라 도면 잉크의 뼈대와 다른 자리다 —
    // 잘 그린 글자가 오히려 벌점이 된다(실측 jewelry_1: 글자 복원 후 0.958 → 0.845).
    // 글자는 면 그대로 그린 것이므로 선 충실도의 질문 대상이 아니다.
    const glyphZone = new Uint8Array(W * H);
    for (const p of scene.primitives) {
      if (p.cls !== "OUTLINE_SHAPE" || !(p.route?.features as Record<string, unknown>)?.glyph) continue;
      const [gx0, gy0, gx1, gy1] = p.bbox;
      for (let y = Math.max(0, Math.floor(gy0)); y <= Math.min(H - 1, Math.ceil(gy1)); y++) {
        for (let x = Math.max(0, Math.floor(gx0)); x <= Math.min(W - 1, Math.ceil(gx1)); x++) {
          glyphZone[y * W + x] = 1;
        }
      }
    }
    const skOf = (m: Mask): Mask => {
      const d = new Uint8Array(m.data.length);
      for (let i = 0; i < d.length; i++) {
        d[i] = m.data[i] && !ctx.texture?.[i] && !glyphZone[i] ? 1 : 0;
      }
      return { data: skeletonize(d, m.width, m.height), width: m.width, height: m.height };
    };
    skelFid = fidelity(skOf(ref), skOf(vec), [0, 2, 3]);
  }

  const fNotes: string[] = [];
  if (skelFid) {
    if ((skelFid.f as Record<string, number>).f3 < 0.9) fNotes.push(`골격 일치 F@3px ${(skelFid.f as Record<string, number>).f3} < 0.90`);
  } else {
    if (lineFid.f.f2 < th.f2) fNotes.push(`선 일치 F@2px ${lineFid.f.f2} < ${th.f2}`);
  }
  const detailCounts = detail.total >= DETAIL_MIN_N;
  if (detail.recall < th.detail) {
    fNotes.push(
      `작은 디테일 ${(detail.recall * 100).toFixed(0)}% — ${detail.total} 중 ${detail.total - detail.kept}개 소실` +
      (detailCounts ? "" : ` (표본 ${DETAIL_MIN_N}개 미만이라 판정에서 제외)`),
    );
  }
  // 얇은 실선 마감은 굵기·구멍이 의도적으로 다르다 — 라인 모드에서는 묻지 않는다
  // 굵기 비교도 같은 잣대로. 옅은 회색 질감을 그린 몫은 "굵어진 것"이 아니다 —
  // 진한 기준선으로만 재면 질감이 있는 도면은 전부 1.3× 로 부풀어 보인다.
  const inkRatioSoft = softInk ? +(lineFid.vecInk / Math.max(1, softInk)).toFixed(3) : lineFid.inkRatio;
  const inkOff = Math.min(Math.abs(lineFid.inkRatio - 1), Math.abs(inkRatioSoft - 1));
  if (!ctx.lineMode && inkOff > 0.25) fNotes.push(`선 굵기 ${lineFid.inkRatio}× (1.0 이 원본, 옅은 회색까지 세면 ${inkRatioSoft}×)`);
  // **불변식**: stroke 로 칠하는 프리미티브에 굵기가 없으면 화면에서 사라진다.
  // 실측으로 bag_3 70/70 · shoe_3 208/208 이 이렇게 출고돼 보이지 않았다.
  const invisible = scene.primitives.filter((p) =>
    (p.cls === "GEOMETRIC_PRIMITIVE" && (p as GeometricPrimitive).paint === "stroke" && (p as { width: number }).width <= 0)
    || ((p.cls === "STRUCTURAL_STROKE" || p.cls === "DASH_OR_STITCH") && (p as StrokePrimitive).width <= 0));
  if (invisible.length) fNotes.push(`굵기 0으로 보이지 않는 프리미티브 ${invisible.length}개 — 렌더링 결함`);

  const holes: [number, number] = [countHoles(ref), countHoles(vec)];
  if (!ctx.lineMode && holes[0] && Math.abs(holes[1] - holes[0]) / holes[0] > 0.15) {
    fNotes.push(`구멍 수 ${holes[0]} → ${holes[1]} (15% 이상 차이)`);
  }
  if (textureShare > 0.01) {
    fNotes.push(`해프톤이 도면 잉크의 ${(textureShare * 100).toFixed(0)}% — 전체 F@2px ${fid.f.f2}, 그 영역 뺀 선 충실도 ${lineFid.f.f2}`);
  }

  const fidelityGate: FidelityGate = {
    pass: skelFid
      ? ((skelFid.f as Record<string, number>).f3 >= 0.9 && (!detailCounts || detail.recall >= th.detail) && invisible.length === 0)
      : (lineFid.f.f2 >= th.f2 && (!detailCounts || detail.recall >= th.detail)
        && inkOff <= 0.25 && invisible.length === 0),
    f0: fid.f.f0, f1: fid.f.f1, f2: fid.f.f2,
    lineF1: lineFid.f.f1, lineF2: lineFid.f.f2,
    ...(shippedLineF2 !== undefined ? { shippedLineF2 } : {}),
    textureShare: +textureShare.toFixed(4),
    inkRatio: lineFid.inkRatio, chamfer: lineFid.chamfer, p95: lineFid.p95,
    detailRecall: detail.recall,
    holes, majorComponents: [topo.refMajor, topo.vecMajor],
    ...(skelFid ? { skeletonF3: (skelFid.f as Record<string, number>).f3, skeletonChamfer: skelFid.chamfer } : {}),
    notes: fNotes,
  } as FidelityGate;

  // ── 편집성 ───────────────────────────────────────────────
  const cf = complexity(svgs.fidelity);
  const ce = complexity(svgs.editable);
  const sub = subpathStats(svgs.fidelity);

  // 길이는 **서브패스마다** 따로 잰다. 여러 서브패스의 점을 한 배열로 이어 붙이면
  // 서브패스 사이의 존재하지 않는 긴 도약이 길이에 더해져 앵커 밀도가 인위적으로 낮아진다.
  let contourLen = 0, shortSubpaths = 0, subCount = 0;
  const minLen = Math.min(W, H) * 0.01;
  for (const p of scene.primitives) {
    const d = (p as { d?: string }).d;
    if (!d) continue;
    for (const poly of flattenPath(d, 4)) {
      subCount++;
      let L = 0;
      for (let i = 1; i < poly.length; i++) L += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
      contourLen += L;
      if (L < minLen) shortSubpaths++;
    }
  }
  const prims = scene.primitives.filter((p) => p.cls === "GEOMETRIC_PRIMITIVE") as GeometricPrimitive[];
  const pats = scene.primitives.filter((p) => p.cls === "REPEATING_PATTERN") as PatternPrimitive[];
  const anchorDensity = contourLen ? (cf.anchors / contourLen) * 100 : 0;
  // use 인스턴스는 객체 하나씩으로 센다 — 2,600개를 "패스 1개"로 보면 안 된다
  const objectComplexity = cf.paths + sub.subpaths + cf.uses;

  const eNotes: string[] = [];
  if (anchorDensity > th.anchorDensity) eNotes.push(`앵커 밀도 ${anchorDensity.toFixed(1)}/100px > ${th.anchorDensity}`);

  // **절대 앵커 예산.** 밀도만 보면 "그림이 크니 앵커가 많아도 된다"가 되어, 2만 개짜리
  // 파일이 밀도 5.6 으로 통과한다. 디자이너가 여는 것은 밀도가 아니라 파일이다 —
  // 앵커 2만 개는 Illustrator 에서 줌·팬마다 버벅인다. 총량도 함께 본다.
  //
  // 값은 실무 규범이 아니라 **관측된 분포**에서 잡았다: 보통 제품 1,500~4,000,
  // 질감이 촘촘한 제품 1.8만~2.3만. 경고는 그 사이, 탈락은 위쪽 무리에 건다.
  const ANCHOR_WARN = Number(process.env.V4_ANCHOR_WARN ?? 8000);
  const ANCHOR_FAIL = Number(process.env.V4_ANCHOR_FAIL ?? 20000);
  if (cf.anchors > ANCHOR_FAIL) {
    eNotes.push(`앵커 ${cf.anchors.toLocaleString()}개 > ${ANCHOR_FAIL.toLocaleString()} — 편집용으로 못 쓴다`);
  } else if (cf.anchors > ANCHOR_WARN) {
    eNotes.push(`참고: 앵커 ${cf.anchors.toLocaleString()}개 (${ANCHOR_WARN.toLocaleString()} 초과) — 질감을 별도 레이어로 빼는 편이 낫다`);
  }
  const shortRatio = subCount ? shortSubpaths / subCount : 0;
  // **중심선 장면의 짧은 획은 파편이 아니라 내용이다.**
  //
  // 닫힌 윤곽은 선 하나를 안·바깥 두 겹으로 떠서 서브패스 하나가 길다. 중심선은 그
  // 절반 길이의 열린 획 하나다 — 같은 그림인데 길이 척도가 다르다. 윤곽 기준 문턱을
  // 그대로 들이대면 잘 만든 중심선 파일이 "파편화"로 벌받는다(실측 t_footwear_03:
  // 윤곽 1,943 앵커는 통과, 앵커를 39% 줄인 중심선 1,176 은 47% 로 탈락).
  //
  // **플래그가 아니라 장면을 보고 정한다.** 어떤 옵션으로 돌렸는지가 아니라, 실제로
  // 스트로크가 주인 장면인지가 판단 근거다.
  const inkPrims = scene.primitives.filter(isInkPrimitive);
  const strokeShare = inkPrims.length
    ? inkPrims.filter((p) => p.cls === "STRUCTURAL_STROKE" || p.cls === "DASH_OR_STITCH").length / inkPrims.length
    : 0;
  const shortMax = ctx.lineMode || strokeShare >= 0.5 ? 0.75 : 0.35;
  if (shortRatio > shortMax) eNotes.push(`짧은 서브패스 ${(shortRatio * 100).toFixed(0)}% — 파편화 의심`);
  if (sub.maxSplittable > 200) {
    eNotes.push(`한 패스에 쪼갤 수 있는 서브패스 ${sub.maxSplittable}개 — Illustrator 에서 통째로 선택된다`);
  } else if (sub.maxInPath > 200) {
    eNotes.push(
      `한 패스에 서브패스 ${sub.maxInPath}개 — 바깥 윤곽 하나에 구멍이 뚫린 진짜 한 덩이라 ` +
      `쪼갤 수 없다(쪼개면 구멍이 메워진다). 컴파운드 패스가 옳은 표현이다.`,
    );
  }
  if (!prims.length) eNotes.push("기하 프리미티브로 승격된 성분 없음 — 잔차 임계 확인");

  const editabilityGate: EditabilityGate = {
    pass: anchorDensity <= th.anchorDensity && shortRatio <= shortMax
      && sub.maxSplittable <= 200 && cf.anchors <= ANCHOR_FAIL,
    paths: cf.paths,
    subpaths: sub.subpaths,
    maxSubpathsInPath: sub.maxInPath,
    maxSplittableSubpaths: sub.maxSplittable,
    objectComplexity,
    anchors: cf.anchors, uses: cf.uses, kb: cf.kb,
    anchorDensity: +anchorDensity.toFixed(2),
    shortPathRatio: +shortRatio.toFixed(3),
    primitives: prims.length,
    anchorsSavedByPrimitives: prims.reduce((a, p) => a + p.anchorsSaved, 0),
    pathsSavedByPatterns: pats.reduce((a, p) => a + p.pathsSaved, 0),
    editableReduction: {
      paths: cf.paths ? +(1 - ce.paths / cf.paths).toFixed(3) : 0,
      anchors: cf.anchors ? +(1 - ce.anchors / cf.anchors).toFixed(3) : 0,
      kb: cf.kb ? +(1 - ce.kb / cf.kb).toFixed(3) : 0,
    },
    notes: eNotes,
  };

  // ── 의미 ─────────────────────────────────────────────────
  //
  // 예전 판정은 `meanPrecision >= 0.7 && emptyVisibleParts.length === 0` 뿐이었다.
  // 세 가지가 빠져 있었다.
  //   · **recall 과 IoU 를 안 봤다.** precision 은 "그린 것이 제자리에 있나"만 재므로,
  //     파트 영역의 3%만 덮어도 그 3%가 제자리면 1.0 이 된다(실측: bag_1 front_flap
  //     IoU 0.045 인데 통과).
  //   · **패스가 0인 파트는 평균에서 빠졌다.** 큰 파트가 통째로 사라져도 남은 작은 파트의
  //     precision 이 좋으면 점수가 올라갔다.
  //   · **correspondence.confident 를 안 봤다.** shoe_2 는 대응 실패인데도 PASS 였다.
  //
  // 그리고 면 파트와 얇은 선 파트를 같은 IoU 로 재면 안 된다 — 끈·체인·각인은 면적이
  // 거의 없어 IoU 가 구조적으로 낮다. 얇은 파트는 경계 F1 으로 잰다.
  const maskById = new Map(ctx.partMasks.map((m) => [m.id, m.mask]));
  const sharedWith = new Set<string>();
  for (const p of scene.primitives) for (const id of p.shared ?? []) sharedWith.add(id);

  const perPart: SemanticGate["perPart"] = [];
  const emptyVisibleParts: string[] = [];
  const sharedOnlyParts: string[] = [];
  const absentInSchematic: string[] = [];
  const canvasArea = W * H;

  for (const part of scene.parts) {
    const mask = maskById.get(part.id);
    const maskArea = mask ? mask.reduce((a, v) => a + v, 0) : 0;
    const areaShare = +(maskArea / canvasArea).toFixed(4);

    // 파트가 면인가 선인가 — 마스크의 두께로 판정한다.
    // 마스크 면적 대비 둘레가 크면 얇은 것이다.
    let thin = false;
    if (mask && maskArea > 0) {
      let per = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (!mask[i]) continue;
          if (!mask[i - 1] || !mask[i + 1] || !mask[i - W] || !mask[i + W]) per++;
        }
      }
      // 두께 ≈ 2·면적/둘레. 캔버스 최소변의 2% 미만이면 얇다.
      thin = per > 0 && (2 * maskArea) / per < Math.min(W, H) * 0.02;
    }
    const kind: "area" | "thin" = partThin ? "thin" : thin ? "thin" : "area";

    const mine = scene.primitives.filter((p) => p.partId === part.id);
    // 패턴은 인스턴스 단위로 파트가 다를 수 있다 — 이 파트의 인스턴스만 남긴 사본을 쓴다
    const mineExpanded: ScenePrimitive[] = [];
    for (const p of scene.primitives) {
      if (p.cls === "REPEATING_PATTERN") {
        const pat = p as PatternPrimitive;
        const inst = pat.instances.filter((i) => (i.partId ?? pat.partId) === part.id);
        if (inst.length) mineExpanded.push({ ...pat, instances: inst } as ScenePrimitive);
        continue;
      }
      if (p.partId === part.id) mineExpanded.push(p);
    }

    if (!mineExpanded.length) {
      const buried = (part.occludedBy?.length ?? 0) >= 2;
      // 마스크 자체가 없다시피 하면 도면에 그 파트가 없는 것이다
      if (areaShare < 0.0005) absentInSchematic.push(part.id);
      else if (sharedWith.has(part.id) || buried) sharedOnlyParts.push(part.id);
      else emptyVisibleParts.push(part.id);
      perPart.push({
        id: part.id, label: part.label, kind, paths: 0, areaShare,
        precision: 0, recall: 0, iou: 0, boundaryF1: 0,
      });
      continue;
    }
    if (!mask) {
      perPart.push({
        id: part.id, label: part.label, kind, paths: mine.length, areaShare,
        precision: -1, recall: -1, iou: -1, boundaryF1: -1,
      });
      continue;
    }

    // **정본 렌더러**로 그린다. QA 가 자기 렌더 코드를 따로 가지면 패턴·면 프리미티브를
    // 놓친다(실제로 그랬다).
    const one = await svgInkMask(renderStandalone(mineExpanded, W, H, "ink"), W, H, 200);

    // 허용오차는 파트 종류에 따라 다르다. 면은 거의 두지 않고, 얇은 선만 넉넉히 준다 —
    // 캔버스 1%(2000px 캔버스에서 20px)를 면에 주면 이웃 파트의 선까지 들어와
    // precision 이 과대평가된다.
    const tol = kind === "thin"
      ? Math.max(2, Math.round(Math.min(W, H) * 0.006))
      : Math.max(1, Math.round(Math.min(W, H) * 0.001));
    const grown = dilate(mask, W, H, tol);

    let inter = 0, drawn = 0, maskN = 0, union = 0;
    for (let i = 0; i < W * H; i++) {
      const d = one.data[i], m = grown[i];
      if (d) drawn++;
      if (m) maskN++;
      if (d && m) inter++;
      if (d || m) union++;
    }

    // 얇은 파트는 경계 F1 로 — 면적 IoU 는 구조적으로 낮다
    let bF1 = -1;
    if (kind === "thin") {
      // 라인 모드 — **골격 대 골격**, 단 기준은 마스크 영역이 아니라 **마스크 안의
      // 실제 잉크**다. 채워진 영역을 기준으로 하면 중심선이 밴드의 20%만 덮어 전 파트가
      // 떨어지고(실측 jewelry_3: 8/8), 영역의 골격(밴드 중앙 등뼈)을 기준으로 하면
      // 도면이 실제로 그린 선(밴드 양쪽 가장자리)과 다른 자리라 recall 이 0.1 이 된다.
      // 질문은 "이 파트의 그려진 선들을 우리가 그렸나"다.
      let mmData: Uint8Array;
      if (partThin) {
        const partInk = new Uint8Array(W * H);
        // **동심 파트는 자기 잉크만 본다.** 스톤 마스크는 원반 전체라, 반사를 지우고
        // 나면 그 안에 남은 잉크가 대부분 **베젤 테두리 선**이다 — 소유권은 베젤이
        // 가져가는데 기준에는 남아 스톤이 "다 놓쳤다"로 벌점을 받는다(실측 jewelry_3
        // middle_gemstone: 잉크 54,779px 중 41,557px 이 이웃 소유, bF1 0.137).
        // 다른 파트가 실제로 그린 자리는 기준에서 뺀다 — 그건 그 파트의 몫이다.
        // 기준에서 뺄 것 두 가지:
        //  ① 다른 파트가 소유한 자리 — 동심 파트(스톤 안의 베젤 테)에서 필수
        //  ② **장면 전체가 안 그린 잉크** — 반사 제거 뒤 남은 얼룩 가장자리가 여기
        //     해당한다. 제외 마스크(removedMask)는 지운 픽셀만 담아서 그 **가장자리**를
        //     못 덮는데, 기준에는 남아 스톤이 통째로 벌점을 받는다(실측 jewelry_3
        //     middle_gemstone: 기준 골격 3,591 대부분이 반사 잔재, bF1 0.16).
        //     장면이 어디에도 안 그린 잉크는 이 파트의 책임이 아니다.
        const otherDrawn = new Uint8Array(W * H);
        for (const other of scene.parts) {
          if (other.id === part.id) continue;
          const om = ctx.partMasks?.find((pm) => pm.id === other.id)?.mask;
          if (!om) continue;
          for (let i = 0; i < W * H; i++) if (om[i] && !mask[i]) otherDrawn[i] = 1;
        }
        const sceneCov = dilate(vec.data, W, H, 3);
        for (let i = 0; i < W * H; i++) if (!sceneCov[i]) otherDrawn[i] = 1;
        // 의도적 제거(보석 반사·해프톤)는 기준에서 뺀다 — 안 그리기로 한 것을
        // "안 그렸다"고 벌하면 안 된다(실측 jewelry_3 스톤: 기준이 반사 골격이라 rec 0.04)
        for (let i = 0; i < W * H; i++) {
          if (ref.data[i] && grown[i] && !ctx.texture?.[i] && !otherDrawn[i]) partInk[i] = 1;
        }
        mmData = skeletonize(partInk, W, H);
      } else {
        mmData = mask;
      }
      const mm: Mask = { data: mmData, width: W, height: H };
      const oneCmp: Mask = partThin
        ? { data: skeletonize(one.data, W, H), width: W, height: H }
        : one;
      const f = fidelity(mm, oneCmp, [tol]);
      bF1 = f.f[`f${tol}`] ?? 0;
      if (process.env.V4_SEM_DEBUG === "1") {
        let refSk = 0, mySk = 0, mArea = 0, inkIn = 0, inkInEx = 0;
        for (let i = 0; i < W * H; i++) {
          refSk += mm.data[i]; mySk += oneCmp.data[i]; mArea += mask[i];
          if (ref.data[i] && grown[i]) { inkIn++; if (ctx.texture?.[i]) inkInEx++; }
        }
        console.log(`    [sem] ${part.id}: 마스크 ${mArea}px · 잉크 ${inkIn}(제외대상 ${inkInEx}) · 기준골격 ${refSk} · 내골격 ${mySk} · bF1 ${bF1}`);
        if (process.env.V4_SEM_DUMP === part.id) {
          const buf = Buffer.alloc(W * H * 3, 255);
          for (let i = 0; i < W * H; i++) {
            const p3 = i * 3;
            if (mm.data[i]) { buf[p3] = 224; buf[p3 + 1] = 52; buf[p3 + 2] = 44; }
            else if (oneCmp.data[i]) { buf[p3] = 47; buf[p3 + 1] = 111; buf[p3 + 2] = 208; }
            else if (mask[i]) { buf[p3] = 235; buf[p3 + 1] = 235; buf[p3 + 2] = 235; }
          }
          await sharp(buf, { raw: { width: W, height: H, channels: 3 } })
            .resize({ width: 1100 }).png().toFile(`outputs/v4/_verify/sem_${part.id}.png`);
        }
      }
    }

    perPart.push({
      id: part.id, label: part.label, kind, paths: mineExpanded.length, areaShare,
      precision: drawn ? +(inter / drawn).toFixed(4) : 0,
      recall: maskN ? +(inter / maskN).toFixed(4) : 0,
      iou: union ? +(inter / union).toFixed(4) : 0,
      boundaryF1: bF1 >= 0 ? +bF1.toFixed(4) : -1,
    });
  }

  const sNotesPre: string[] = [];
  const measured = perPart.filter((p) => p.precision >= 0);
  const meanPrecision = measured.length
    ? measured.reduce((s, p) => s + p.precision, 0) / measured.length
    : 1;
  // **면적으로 가중한다.** 큰 파트가 통째로 빠지면 크게 떨어져야 한다.
  const wSum = measured.reduce((s, p) => s + p.areaShare, 0);
  const weightedMeanIou = wSum
    ? measured.reduce((s, p) => s + p.iou * p.areaShare, 0) / wSum
    : 0;

  // **마스크가 없다시피 한 파트에 precision 을 적용하면 안 된다.** 기준이 조각뿐이라
  // 제대로 그린 기하도 전부 "밖"으로 세어진다 — 실측: bag_1 top_handle 마스크가
  // 캔버스의 0.03% 일 때 precision 0.118 이었다(그린 것은 옳은 손잡이였다).
  // **얇은 파트를 면 precision 으로 재면 안 된다.** 끈·체인·각인은 면적이 거의 없어
  // 기준 마스크가 조각뿐이고, 제대로 그린 기하도 "밖"으로 세어진다. 바로 위
  // failingMajorParts 는 이미 얇은 파트를 경계 F1 로 재고 있다 — 같은 규칙을 쓴다.
  // (실측: bag_3 inner_pouch 가 마스크 0.20% 인데 precision 0.275 로 의심 처리됐다.)
  const suspect = (p: SemanticGate["perPart"][number]) =>
    p.kind === "thin" ? p.boundaryF1 >= 0 && p.boundaryF1 < 0.5 : p.precision < 0.5;
  const misassigned = measured
    .filter((p) => p.paths > 0 && p.areaShare >= 0.002 && suspect(p))
    .map((p) => p.id);
  const unjudgeable = measured
    .filter((p) => p.paths > 0 && p.areaShare < 0.002 && suspect(p))
    .map((p) => p.id);
  if (unjudgeable.length) {
    sNotesPre.push(`마스크가 너무 작아 판정 보류 ${unjudgeable.length}개: ${unjudgeable.join(", ")} (캔버스의 0.2% 미만)`);
  }

  // 주요 파트 = 캔버스의 2% 이상을 차지하는 것. 이것들은 반드시 자기 기하를 가져야 한다.
  const MAJOR = 0.02;
  const failingMajorParts: string[] = [];
  for (const p of perPart) {
    if (p.areaShare < MAJOR) continue;
    if (sharedOnlyParts.includes(p.id)) continue;
    if (p.precision < 0) continue;
    const ok = p.kind === "thin"
      ? p.boundaryF1 >= 0.80
      : p.paths > 0 && p.recall >= 0.55 && p.iou >= 0.45;
    if (!ok) failingMajorParts.push(p.id);
  }

  const sNotes: string[] = [...sNotesPre];
  if (failingMajorParts.length) {
    sNotes.push(`기준 미달 주요 파트 ${failingMajorParts.length}개: ${failingMajorParts.join(", ")} (면 recall≥0.55·IoU≥0.45 / 선 F1≥0.80)`);
  }
  if (misassigned.length) sNotes.push(`배분이 의심되는 레이어 ${misassigned.length}개: ${misassigned.join(", ")}`);
  if (emptyVisibleParts.length) sNotes.push(`패스가 없는 파트 ${emptyVisibleParts.length}개: ${emptyVisibleParts.join(", ")}`);
  if (sharedOnlyParts.length) sNotes.push(`공유 경계로만 그려진 파트 ${sharedOnlyParts.length}개: ${sharedOnlyParts.join(", ")}`);
  if (absentInSchematic.length) sNotes.push(`도면에 없는 파트 ${absentInSchematic.length}개: ${absentInSchematic.join(", ")} (GPT 계획↔도면 불일치 — 벡터화 문제가 아니다)`);
  // **주체탐지 플래그는 배분 품질을 예측하지 못한다.** 그것은 "사진·도면에서 배경과
  // 전경이 분리됐는가"를 볼 뿐인데, V4.3 부터 파트 경계는 도면의 닫힌 면에 스냅되므로
  // 배경 분리 여부가 배분을 결정하지 않는다. 실측이 그것을 뒤집는다 — 주체탐지가
  // 실패로 표시한 shoe_2·shoe_3 의 마스크 정합이 9종 중 **가장 높다**(0.964·0.982).
  // 그래서 gate 는 대신 마스크 정합을 본다. 주체탐지 결과는 참고로 남긴다.
  const fit = ctx.maskFit ?? 1;
  if (fit < MASK_FIT_MIN) {
    sNotes.push(`마스크 정합 ${fit.toFixed(3)} < ${MASK_FIT_MIN} — 파트 마스크가 도면 위에 제대로 놓이지 않았다`);
  }
  if (!scene.correspondence.confident) {
    sNotes.push(`참고: 사진·도면 주체탐지가 배경을 분리하지 못함 (마스크 정합 ${fit.toFixed(3)} 로 판정)`);
  }
  if (ctx.aspectRatio > 1.02) sNotes.push(`사진↔도면 종횡비 불일치 ${((ctx.aspectRatio - 1) * 100).toFixed(1)}%`);
  if (scene.provenance.lowConfidence) sNotes.push(`라우터가 확신하지 못한 성분 ${scene.provenance.lowConfidence}개`);
  if (!partThin && weightedMeanIou < 0.65) sNotes.push(`면적 가중 평균 IoU ${weightedMeanIou.toFixed(3)} < 0.65`);

  const semanticGate: SemanticGate = {
    pass:
      fit >= MASK_FIT_MIN &&
      failingMajorParts.length === 0 &&
      emptyVisibleParts.length === 0 &&
      misassigned.length === 0 &&
      (partThin || weightedMeanIou >= 0.65),
    perPart,
    meanPrecision: +meanPrecision.toFixed(4),
    weightedMeanIou: +weightedMeanIou.toFixed(4),
    failingMajorParts,
    maskFit: +fit.toFixed(4),
    misassigned,
    emptyVisibleParts,
    sharedOnlyParts,
    absentInSchematic,
    sharedBoundaries: scene.sharedBoundaries.length,
    aspectRatio: +ctx.aspectRatio.toFixed(3),
    lowConfidenceRoutes: scene.provenance.lowConfidence,
    notes: sNotes,
  };

  applyCleanupReview(scene,editabilityGate);
  const flags = [
    fidelityGate.pass ? "FIDELITY_PASS" : "FIDELITY_REVIEW",
    editabilityGate.pass ? "EDITABILITY_PASS" : "EDITABILITY_REVIEW",
    semanticGate.pass ? "SEMANTIC_PASS" : "SEMANTIC_REVIEW",
  ];
  void distanceTransform;
  void sharp;
  void samplePath;
  return { fidelity: fidelityGate, editability: editabilityGate, semantic: semanticGate, state: flags.join(" / ") };
}

/** A high raster score must not hide a known failed text/border separation. */
/**
 * 정리 단계가 남긴 **검토 후보**를 편집성 게이트에 적는다.
 *
 * v7.9 원안은 후보가 하나라도 있으면 게이트를 떨어뜨렸다("알려진 문제를 PASS 로 숨기지
 * 않는다"). 의도는 옳지만 **후보는 확정 결함이 아니다** — v7.9 리포트 자신이 그렇게 적었다.
 * 실측으로 확인했다: 후보를 도면 위에 찍어 보니
 *   · bag_2 14곳 전부가 잠금장치와 장미 장식 — 진짜로 작은 고리가 있는 형상 (선 F@2 0.9950)
 *   · jewelry_1 6곳은 커프 본체의 큰 윤곽과 끝단
 * 즉 이 표본에서 오탐률이 사실상 100% 다. 깨끗한 결과에서 항상 떨어지는 게이트는 정보를
 * 나르지 않고, 사람이 게이트를 무시하게 만든다.
 *
 * 그래서 **후보는 적되 게이트를 가르지 않는다.** 노트로 남으니 숨기는 것이 아니다.
 * 실제로 손실이 측정된 글자 분리(core_loss > 0)만 게이트를 떨어뜨린다 — 그건 결함이다.
 * `V4_REVIEW_BLOCKS_GATE=1` 로 원안(후보가 게이트를 가름)으로 되돌릴 수 있다.
 */
export function applyCleanupReview(scene:VectorScene,gate:Pick<EditabilityGate,"pass"|"notes">):void {
  const deferred=scene.provenance.cleanup?.glyphReview??[];
  const lines=scene.provenance.cleanup?.lineReview??[];
  const strict=process.env.V4_REVIEW_BLOCKS_GATE==="1";
  const lost=deferred.filter(x=>{
    const m=/core_loss:\s*([0-9.]+)/.exec(x.reason??"");
    return !m||Number(m[1])>0;                       // 손실을 못 재면 보수적으로 결함 취급
  });
  if(deferred.length){
    if(strict||lost.length)gate.pass=false;
    gate.notes.push(`글자·외곽 자동 분리 ${deferred.length}곳 보류`
      +(lost.length?` (실제 손실 ${lost.length}곳)`:" (측정된 손실 없음)")
      +` — ${deferred.map(x=>x.id+": "+x.reason).join(", ")}`);
  }
  if(lines.length){
    if(strict)gate.pass=false;
    gate.notes.push(`선 연결 구조 검토 후보 ${lines.length}곳 (확정 결함이 아니다 — 사람이 확인할 자리)`
      +` — ${lines.slice(0,12).map(x=>x.id+": "+x.reason).join(", ")}`);
  }
}
