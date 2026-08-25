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
import { complexity, renderStandalone } from "./export.js";
import type { GeometricPrimitive, PatternPrimitive, ScenePrimitive, StrokePrimitive, VectorScene } from "./types.js";

export interface FidelityGate {
  pass: boolean;
  f0: number;
  f1: number;
  f2: number;
  /** 해프톤 영역을 뺀 선 충실도 — 합격 판정 기준 */
  lineF1: number;
  lineF2: number;
  textureShare: number;
  inkRatio: number;
  chamfer: number;
  p95: number;
  detailRecall: number;
  /** 도면 / 벡터의 구멍 수 */
  holes: [number, number];
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
function inkSvg(scene: VectorScene): string {
  const { width: W, height: H } = scene.canvas;
  const prims = scene.primitives.filter((p) => {
    if (p.cls === "FACE_FILL" || p.cls === "TEXTURE_TONE") return false;
    if (p.cls === "GEOMETRIC_PRIMITIVE" && (p as GeometricPrimitive).paint === "fill") return false;
    if (p.cls === "REPEATING_PATTERN" && (p as PatternPrimitive).paint === "fill") return false;
    return true;
  });
  return renderStandalone(prims, W, H, "ink");
}

/** SVG 의 서브패스 통계 — 컴파운드 패스가 몇 개의 도형을 숨기고 있는가 */
function subpathStats(svg: string): { subpaths: number; maxInPath: number } {
  let total = 0, max = 0;
  // 경계 없이 d="…" 로 찾으면 data-shared="main_compartment_shell" 같은 값의 m 까지 센다.
  for (const m of svg.matchAll(new RegExp('(?:^|[\\s"])d="([^"]*)"', "g"))) {
    const n = (m[1].match(new RegExp("[Mm]", "g")) ?? []).length;
    total += n;
    if (n > max) max = n;
  }
  return { subpaths: total, maxInPath: max };
}

export async function runQa4(
  scene: VectorScene,
  refPng: string,
  svgs: { fidelity: string; editable: string; production: string },
  ctx: {
    texture?: Uint8Array;
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
  const { width: W, height: H } = scene.canvas;
  const th = ctx.thresholds ?? { f2: 0.95, detail: 0.85, anchorDensity: 12, precision: 0.7 };

  // ── 충실도 ───────────────────────────────────────────────
  const ref = await inkMask(refPng, W, H);
  const vec = await svgInkMask(inkSvg(scene), W, H);
  const fid = fidelity(ref, vec, [0, 1, 2]);
  const small = Math.max(6, Math.round(W * H * 0.00008));
  const detail = detailRecall(ref, vec, small, 2, ctx.texture);
  const topo = topology(ref, vec);

  let lineFid = fid;
  let textureShare = 0;
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
      lineFid = fidelity(cut(ref), cut(vec), [0, 1, 2]);
    }
  }

  const fNotes: string[] = [];
  if (lineFid.f.f2 < th.f2) fNotes.push(`선 일치 F@2px ${lineFid.f.f2} < ${th.f2}`);
  if (detail.recall < th.detail) fNotes.push(`작은 디테일 ${(detail.recall * 100).toFixed(0)}% — ${detail.total - detail.kept}개 소실`);
  if (Math.abs(lineFid.inkRatio - 1) > 0.25) fNotes.push(`선 굵기 ${lineFid.inkRatio}× (1.0 이 원본)`);
  // **불변식**: stroke 로 칠하는 프리미티브에 굵기가 없으면 화면에서 사라진다.
  // 실측으로 bag_3 70/70 · shoe_3 208/208 이 이렇게 출고돼 보이지 않았다.
  const invisible = scene.primitives.filter((p) =>
    (p.cls === "GEOMETRIC_PRIMITIVE" && (p as GeometricPrimitive).paint === "stroke" && (p as { width: number }).width <= 0)
    || ((p.cls === "STRUCTURAL_STROKE" || p.cls === "DASH_OR_STITCH") && (p as StrokePrimitive).width <= 0));
  if (invisible.length) fNotes.push(`굵기 0으로 보이지 않는 프리미티브 ${invisible.length}개 — 렌더링 결함`);

  const holes: [number, number] = [countHoles(ref), countHoles(vec)];
  if (holes[0] && Math.abs(holes[1] - holes[0]) / holes[0] > 0.15) {
    fNotes.push(`구멍 수 ${holes[0]} → ${holes[1]} (15% 이상 차이)`);
  }
  if (textureShare > 0.01) {
    fNotes.push(`해프톤이 도면 잉크의 ${(textureShare * 100).toFixed(0)}% — 전체 F@2px ${fid.f.f2}, 그 영역 뺀 선 충실도 ${lineFid.f.f2}`);
  }

  const fidelityGate: FidelityGate = {
    pass: lineFid.f.f2 >= th.f2 && detail.recall >= th.detail
      && Math.abs(lineFid.inkRatio - 1) <= 0.25 && invisible.length === 0,
    f0: fid.f.f0, f1: fid.f.f1, f2: fid.f.f2,
    lineF1: lineFid.f.f1, lineF2: lineFid.f.f2,
    textureShare: +textureShare.toFixed(4),
    inkRatio: lineFid.inkRatio, chamfer: lineFid.chamfer, p95: lineFid.p95,
    detailRecall: detail.recall,
    holes, majorComponents: [topo.refMajor, topo.vecMajor],
    notes: fNotes,
  };

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
  const shortRatio = subCount ? shortSubpaths / subCount : 0;
  if (shortRatio > 0.35) eNotes.push(`짧은 서브패스 ${(shortRatio * 100).toFixed(0)}% — 파편화 의심`);
  if (sub.maxInPath > 200) eNotes.push(`한 패스에 서브패스 ${sub.maxInPath}개 — Illustrator 에서 통째로 선택된다`);
  if (!prims.length) eNotes.push("기하 프리미티브로 승격된 성분 없음 — 잔차 임계 확인");

  const editabilityGate: EditabilityGate = {
    pass: anchorDensity <= th.anchorDensity && shortRatio <= 0.35 && sub.maxInPath <= 200,
    paths: cf.paths,
    subpaths: sub.subpaths,
    maxSubpathsInPath: sub.maxInPath,
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
    const kind: "area" | "thin" = thin ? "thin" : "area";

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
      const mm: Mask = { data: mask, width: W, height: H };
      const f = fidelity(mm, one, [tol]);
      bF1 = f.f[`f${tol}`] ?? 0;
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
  if (weightedMeanIou < 0.65) sNotes.push(`면적 가중 평균 IoU ${weightedMeanIou.toFixed(3)} < 0.65`);

  const semanticGate: SemanticGate = {
    pass:
      fit >= MASK_FIT_MIN &&
      failingMajorParts.length === 0 &&
      emptyVisibleParts.length === 0 &&
      misassigned.length === 0 &&
      weightedMeanIou >= 0.65,
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
