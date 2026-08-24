/**
 * 도면 → 벡터. V3의 핵심.
 *
 * VRINGON schematic 워커의 출력은 **흰 배경 + 명확한 검은 라인**(+ 컬러 모드면 평면 색면)이다.
 * 사진처럼 그라데이션·질감이 없으므로, 색면을 클러스터링하는 대신 **라인을 기준으로**
 * 벡터를 만들 수 있다. 도면의 선이 곧 파트 경계이고, 면과 선이 같은 이진 마스크에서 나오므로
 * 경계가 정확히 맞물린다(헤어라인 갭·이중선 없음).
 *
 * ── 표현 방식은 하나가 아니다 ────────────────────────────────────────────────
 * 선을 벡터로 옮기는 방법은 두 갈래이고, 서로 다른 것을 잘한다.
 *
 *   centerline  선의 중심을 따라 열린 패스 하나 + stroke-width.
 *               Illustrator에서 굵기·곡선을 바로 만질 수 있다. 대신 교차점·가변 굵기·
 *               작은 디테일에서 무너진다.
 *   outline     검은 잉크의 **외곽**을 채워진 컴파운드 패스로 뜬다.
 *               원본과 거의 구분이 안 될 만큼 충실하다. 대신 선 하나가 리본 하나라
 *               굵기 조절이 자유롭지 않다.
 *
 * 같은 도면을 raw 해상도에서 두 방식으로 떠서 **원본 대비 양방향 F1**과 **작은 디테일
 * 보존율**을 재 봤다(정합 왜곡을 제거한 조건):
 *
 *   shoe_1   centerline  F@2px 0.869 · 작은 디테일 보존 0.045
 *            outline     F@2px 0.992 · 작은 디테일 보존 0.908
 *            outline 2x  F@2px 0.9998 · 작은 디테일 보존 0.982
 *   bag_1    centerline  F@2px 0.961 · 0.485
 *            outline 2x  F@2px 0.994 · 0.792
 *
 * centerline이 스티치·지퍼 이빨·로고 문자를 통째로 잃는다는 것이 수치로 드러난다
 * (shoe_1에서 작은 성분의 95.5%가 사라졌다). 그래서 기본은 **hybrid**다 —
 * 굵기가 안정적인 긴 구조선만 centerline으로 올리고, 나머지는 outline으로 남긴다.
 *
 * ── 작업 해상도 ──────────────────────────────────────────────────────────────
 * 추적 전에 도면을 2~4배로 키운다. 확대 자체가 정보를 만들지는 않지만, 이진화 경계가
 * 부드러워져 tracer가 **더 적은 패스로 더 정확한 곡선**을 낸다(bag_1: 302패스 F 0.968 →
 * 279패스 F 0.994). 좌표계는 이 확대된 캔버스 그대로 두고 viewBox로 표현한다.
 */
import path from "node:path";
import fsp from "node:fs/promises";
import sharp from "sharp";
import { vectorize, ColorMode, Hierarchical, PathSimplifyMode } from "@neplex/vectorizer";
import { centerlineTrace } from "../vector/centerline.js";
import { optimizePathData } from "../vector/optimize.js";
import { assignByCurve, samplePath } from "./pathSample.js";
import { labelComponents, type Component } from "./label.js";
import { area, close, deltaE2000Rgb, dilate, erode, toHex } from "../v2/raster.js";

export type LineMode = "hybrid" | "outline" | "centerline";

export interface LineVectorOptions {
  /** 잉크 판정 임계 (0~255). 흰/회 배경 도면은 150~190이 적당 */
  inkThreshold: number;
  /**
   * 국소 대비 임계. 주변 평균보다 이만큼 어두우면 밝기와 무관하게 선으로 본다.
   * 컬러로 그려진 도면(금색 테 등)에서 선을 놓치지 않게 한다.
   */
  localContrast: number;
  /**
   * 해프톤을 톤 면으로 치환할지. 자동(auto)은 **질감이 그림을 지배하면 그대로 둔다** —
   * 잉크의 대부분이 질감인데 톤으로 바꾸면 제품의 정체성이 사라진다
   * (실측: 비즈 메시 가방은 잉크의 68%가 메시라 톤 치환 후 회색 덩어리가 됐다).
   */
  textureMode: "auto" | "tone" | "keep";
  /**
   * 컬러로 그려진 도면에서 **채도가 있는 픽셀은 선이 아니라 색면**으로 본다.
   * 보석·금속을 사진처럼 그라데이션으로 그려 보내는 경우, 그 명암을 이진화하면
   * 얼룩진 잔선 덩어리가 된다(실측: jewelry_3 보석이 검은 얼룩이 됨).
   * 선은 거의 언제나 중성 검정이므로 채도로 갈라내면 색면은 fill 로 남고 선만 추적된다.
   *
   * **기본은 꺼짐이고, 켜기 전에 반드시 측정할 것.** 윤곽선까지 유채색으로 그려진 도면에서는
   * 정반대로 작동한다 — jewelry_3 실측: 선 일치 F@2px 0.866 → 0.789, 잉크비 0.752 → 0.525,
   * 작은 디테일 100% → 8.3%.
   */
  neutralInkOnly: boolean;
  /** 선 표현 방식 */
  mode: LineMode;
  /**
   * 추적 작업 캔버스의 목표 장변(px). 원본이 작으면 확대해서 추적한다.
   * 확대는 4배로 제한한다 — 그 이상은 파일만 커지고 충실도는 안 오른다.
   */
  workLong: number;
  /** 이 면적(px, 작업 캔버스 기준) 미만의 닫힌 면은 버린다 */
  minRegionPx: number;
  /** 폴리곤 단순화 허용 오차(px) */
  simplifyPx: number;
  /** 면 색을 원본에서 샘플링할 것인가 (컬러 도면) */
  sampleFill: boolean;
  /**
   * 색을 뽑을 다른 이미지. 컬러 도식은 선과 색면이 같은 검정이라 선을 못 뽑으므로
   * **기하는 모노 도식(pngPath)에서, 색은 여기(컬러 도식)에서** 가져온다.
   */
  colorFrom?: string;
  /** 선 패스 상한 */
  maxStrokes: number;
  /** 같은 면색으로 묶을 ΔE2000 한계 */
  colorMergeDeltaE: number;
  /** 중간 산출물을 둘 디렉터리 */
  workDir?: string;
  /**
   * 파트별 마스크 — **작업 캔버스 좌표계**여야 한다.
   *
   * clip으로 파트마다 따로 벡터화하면 clip 경계가 외곽선을 잘라 면이 새어나간다
   * (실측: 가방 파트 커버리지 83.8%, 실루엣 IoU 0.58). 도면 전체를 한 번 처리하고
   * 만들어진 패스를 파트에 배분한다.
   */
  parts?: { id: string; mask: Uint8Array }[];
}

export const DEFAULT_LINE_OPTIONS: LineVectorOptions = {
  inkThreshold: 170,
  localContrast: 22,
  textureMode: "auto",
  neutralInkOnly: false,
  mode: "hybrid",
  workLong: 2200,
  minRegionPx: 24,
  simplifyPx: 0.8,
  sampleFill: true,
  maxStrokes: 4000,
  colorMergeDeltaE: 12,
};

export interface VecPath {
  /** parts를 준 경우 이 패스가 속한 파트 */
  partId?: string;
  /** 이 패스가 사실상 함께 쓰는 다른 파트들 (파트 경계선) */
  shared?: string[];
  d: string;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number | null;
  /** 면의 픽셀 면적 — z 정렬용 */
  area: number;
  /** 어떤 방식으로 만들어졌나 */
  kind: "fill" | "centerline" | "outline";
}

export interface LineVectorResult {
  /** 라인이 감싼 면 (면적 내림차순 = 그리는 순서) */
  regions: VecPath[];
  /** 선 (centerline stroke 또는 outline fill) */
  strokes: VecPath[];
  stats: {
    /** 작업 캔버스 크기 — SVG viewBox가 이 크기다 */
    workWidth: number;
    workHeight: number;
    supersample: number;
    inkRatio: number;
    enclosedRatio: number;
    /** 해프톤으로 판정해 톤 면으로 바꾼 화면 비율 */
    textureRatio: number;
    /** 해프톤이 아닌데도 지워진 얼룩 — 0이어야 한다 */
    speckDroppedOutsideTexture: number;
    /** 질감이 그림을 지배해 톤 치환을 포기했는가 */
    textureKept: boolean;
    /** 질감이 제품 bbox 에서 차지하는 면적 비율 / 잉크에서 차지하는 비율 */
    textureAreaShare: number;
    textureInkShare: number;
    regionCount: number;
    regionDropped: number;
    colorGroups: number;
    strokeCount: number;
    centerlineCount: number;
    outlineCount: number;
    nodes: number;
    /** 닫힌 면 중 벡터가 덮은 비율 */
    coverage: number;
    /** 파트 경계로 판정돼 공유 표시된 패스 수 */
    sharedPaths: number;
  };
  /** 잉크 마스크 (QA·디버깅용, 작업 캔버스 해상도) */
  ink: Uint8Array;
  /** 톤 면으로 치환한 해프톤 영역 — QA가 이 안의 손실은 의도된 것으로 제외한다 */
  texture: Uint8Array;
  width: number;
  height: number;
}

// ── 추적기 설정 ──────────────────────────────────────────────
const TRACE_SPLINE = {
  colorMode: ColorMode.Binary,
  hierarchical: Hierarchical.Cutout,
  mode: PathSimplifyMode.Spline,
  colorPrecision: 6,
  layerDifference: 16,
  cornerThreshold: 60,
  lengthThreshold: 4,
  maxIterations: 10,
  spliceThreshold: 45,
  pathPrecision: 3,
} as const;

const PATH_TAG = new RegExp("<path\\b([^>]*?)/?>", "g");
const D_ATTR = new RegExp('d="([^"]*)"');
const FILL_ATTR = new RegExp('fill="([^"]*)"');
const TRANSLATE_ATTR = new RegExp("translate\\(([-0-9.]+)[ ,]+([-0-9.]+)\\)");
const NUMBER = new RegExp("-?\\d*\\.?\\d+(?:e[-+]?\\d+)?", "gi");

export async function vectorizeByLines(
  pngPath: string,
  opts: Partial<LineVectorOptions> = {},
): Promise<LineVectorResult> {
  const o = { ...DEFAULT_LINE_OPTIONS, ...opts };
  const workDir = o.workDir ?? path.join(path.dirname(pngPath), ".lv");
  await fsp.mkdir(workDir, { recursive: true });

  // ── 0) 작업 해상도 결정 ───────────────────────────────────
  const meta = await sharp(pngPath).metadata();
  const srcLong = Math.max(meta.width!, meta.height!);
  const supersample = Math.max(1, Math.min(4, Math.round(o.workLong / srcLong)));
  const W = meta.width! * supersample;
  const H = meta.height! * supersample;
  const N = W * H;

  const { data, info } = await sharp(pngPath)
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .resize(W, H, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;

  // 색 샘플링 원본 (컬러 모드)
  let colorData = data;
  let colorCh = ch;
  if (o.colorFrom) {
    const c = await sharp(o.colorFrom)
      .flatten({ background: "#ffffff" })
      .removeAlpha()
      .resize(W, H, { fit: "fill", kernel: "lanczos3" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    colorData = c.data;
    colorCh = c.info.channels;
  }

  // ── 1) 잉크 마스크 ────────────────────────────────────────
  //
  // 전역 밝기 임계 하나로는 부족하다. schematic 모델이 **컬러로 그려 보내는 경우**가 있는데
  // (실측: jewelry_3은 금색 테·파란 보석으로 그려졌다), 금색 윤곽선은 루미넌스가 높아
  // 임계 위로 빠져나가 선이 통째로 사라진다(잉크비 0.739, p95 14px).
  // 그래서 **국소 대비**를 함께 본다 — 주변보다 뚜렷하게 어두우면 밝기와 무관하게 선이다.
  const gray = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const p = i * ch;
    gray[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) | 0;
  }
  const chromaOf = (i: number) => {
    const p = i * ch;
    return Math.max(data[p], data[p + 1], data[p + 2]) - Math.min(data[p], data[p + 1], data[p + 2]);
  };
  const NEUTRAL = 45;
  let ink = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    ink[i] = gray[i] < o.inkThreshold && (!o.neutralInkOnly || chromaOf(i) < NEUTRAL) ? 1 : 0;
  }

  {
    const radius = Math.max(2, Math.round(Math.min(W, H) * 0.01));
    const mean = boxMean(gray, W, H, radius);
    let added = 0;
    for (let i = 0; i < N; i++) {
      // 배경(거의 흰색)에서는 국소 대비가 잡음을 잉크로 만들므로 상한을 둔다
      if (ink[i] || gray[i] >= 236) continue;
      if (o.neutralInkOnly && chromaOf(i) >= NEUTRAL) continue;
      if (gray[i] < mean[i] - o.localContrast) { ink[i] = 1; added++; }
    }
    // 국소 대비가 전역보다 훨씬 많이 잡으면 그림이 사진에 가깝다는 뜻이라 신뢰하지 않는다
    if (added > N * 0.25) {
      for (let i = 0; i < N; i++) {
        ink[i] = gray[i] < o.inkThreshold && (!o.neutralInkOnly || chromaOf(i) < NEUTRAL) ? 1 : 0;
      }
    }
  }

  // 두꺼운 덩어리는 선이 아니라 면이다 — 침식으로 살아남는 심을 빼서 선만 남긴다.
  // (검정 갑피가 통째로 "선"이 되면 닫힌 면이 사라진다.
  //  실측: 검정 운동화 도면에서 잉크 45% → 닫힌 면 6%)
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

  // ── 1b) 해프톤 질감 → 톤 면 ────────────────────────────────
  //
  // 도면은 메시·니트·가죽결을 **작은 점을 촘촘히 찍어** 나타낸다. 점을 선으로 따면 잔선
  // 수백 개가 스크래치처럼 그려지고, 더 촘촘하면 통째로 검게 뭉친다. 테크팩 관례대로
  // 점은 지우고 그 자리를 옅은 톤 면으로 표시한다.
  //
  // **중요**: 예전에는 승인 여부와 무관하게 모든 작은 성분(speck)을 지웠다. 그 바람에
  // 점선 스티치·지퍼 이빨·로고 문자·짧은 접합선이 함께 사라졌다(shoe_1에서 작은 성분의
  // 95.5%가 소실). 이제 **승인된 질감 클러스터 안의 점만** 지운다.
  const texture = new Uint8Array(N);
  let speckDroppedOutsideTexture = 0;
  let textureKept = false;
  let textureAreaShare = 0;
  let textureInkShare = 0;
  {
    const dot = Math.max(2, Math.round(Math.min(W, H) * 0.008));
    const speck = new Uint8Array(N);
    let speckN = 0;
    const lab = labelComponents(ink, W, H, 8);
    const speckComps: Component[] = [];
    for (const c of lab.components) {
      const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
      if (w > dot * 3 || h > dot * 3 || c.area > dot * dot * 4) continue;
      speckComps.push(c);
      for (let k = 0; k < c.pixels.length; k++) { speck[c.pixels[k]] = 1; speckN++; }
    }
    if (speckN > N * 0.0004) {
      // 점이 모여 있는 곳만 질감이다 — 흩어진 점 몇 개는 의미 있는 디테일일 수 있으니 남긴다
      const cluster = close(dilate(speck, W, H, dot * 2), W, H, dot);
      const accepted = new Uint8Array(N);
      for (const c of labelComponents(cluster, W, H, 4).components) {
        if (c.area < N * 0.0015) continue;
        let dots = 0;
        for (let k = 0; k < c.pixels.length; k++) if (speck[c.pixels[k]]) dots++;
        if (dots < c.area * 0.05) continue; // 성긴 곳은 질감이 아니다
        for (let k = 0; k < c.pixels.length; k++) { texture[c.pixels[k]] = 1; accepted[c.pixels[k]] = 1; }
      }
      // 지울 후보를 먼저 모은다 — 승인된 클러스터 안의 점만
      const doomed: Component[] = [];
      let doomedPx = 0;
      for (const c of speckComps) {
        let inside = 0;
        for (let k = 0; k < c.pixels.length; k++) if (accepted[c.pixels[k]]) inside++;
        if (inside >= c.pixels.length * 0.6) { doomed.push(c); doomedPx += c.pixels.length; }
      }

      // 질감이 **그림을 지배하면** 그대로 둔다. 잉크의 대부분이 질감인데 톤 면으로 바꾸면
      // 남는 구조선이 없어 제품이 회색 덩어리가 된다(실측: 비즈 메시 가방은 잉크의 68%가
      // 메시라, 치환 후 큰 성분이 1→14로 부서지고 메시 조직이 통째로 사라졌다).
      // 반대로 신발 갑피처럼 구조선이 충분히 남는 경우(질감 58%)는 톤 쪽이 훨씬 깔끔하다.
      // 질감이 **그림을 지배하는가**를 판정한다. 지배하면 톤으로 바꾸지 않고 그대로 둔다 —
      // 비즈 메시 가방처럼 메시가 곧 제품인 경우 톤 치환은 회색 덩어리를 남긴다.
      //
      // 임계는 9종을 실측해 골랐다(질감 잉크점유 / 질감 면적점유):
      //   shoe_1 0.601/0.324 · shoe_2 0.443/0.212 · shoe_3 0.257/0.199
      //   bag_1  0.652/0.382 · bag_2  0.810/0.475 · bag_3 0/0
      //   jewelry_1 0/0 · jewelry_2 0/0 · jewelry_3 0.005/0.004
      // 잉크 점유가 더 넓게 갈린다 — 비즈 가방 0.810과 차순위 0.652 사이가 비어 있다.
      // 면적 점유(0.475 vs 0.382)로 재면 간격이 절반이라 사소한 변경에 판정이 뒤집혔다.
      // 그래서 0.75를 쓴다. 두 지표 모두 stats로 내보내 다음 사람이 다시 고를 수 있게 한다.
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (!ink[y * W + x]) continue;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      const bboxArea = x1 < 0 ? N : (x1 - x0 + 1) * (y1 - y0 + 1);
      textureAreaShare = area(accepted) / bboxArea;
      {
        const inkNow = area(ink);
        let n = 0;
        for (let i = 0; i < N; i++) if (ink[i] && accepted[i]) n++;
        textureInkShare = inkNow ? n / inkNow : 0;
      }
      void doomedPx;
      const suppress =
        o.textureMode === "tone" ? true :
        o.textureMode === "keep" ? false :
        textureInkShare < 0.75;

      if (suppress) {
        for (const c of doomed) for (let k = 0; k < c.pixels.length; k++) ink[c.pixels[k]] = 0;
      } else {
        texture.fill(0);
        textureKept = true;
      }
    }
  }

  // ── 2) 면 찾기용 마스크는 따로 만든다 ──────────────────────
  //
  // 닫힌 면을 찾으려면 외곽선에 1px 틈도 없어야 한다(있으면 큰 면이 통째로 바깥으로 샌다).
  // 그래서 morphological closing이 필요하다. 그런데 같은 마스크로 **선까지** 그리면
  // closing이 가까운 평행선을 붙이고 교차점에 검은 혹을 만든다(실측: 성분 11→7,
  // 골격 끝점 57→27). 두 용도를 분리한다 — 면은 닫은 마스크로, 선은 원본 마스크로.
  const inkFill = close(ink, W, H, Math.max(1, Math.round(supersample / 2)));

  // ── 3) 라인을 장벽으로 flood fill → 닫힌 면 ───────────────
  const outside = new Uint8Array(N);
  {
    const q = new Int32Array(N);
    let head = 0, tail = 0;
    const push = (i: number) => { if (!outside[i] && !inkFill[i]) { outside[i] = 1; q[tail++] = i; } };
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
  }
  const enclosed = new Uint8Array(N);
  let enclosedN = 0;
  for (let i = 0; i < N; i++) {
    if (inkFill[i] || outside[i]) continue;
    enclosed[i] = 1;
    enclosedN++;
  }

  // 파트 조회를 O(1)로 — 픽셀마다 **가장 앞** 파트를 미리 적어 둔다.
  // (파트마다 전체 픽셀을 훑으면 6M px × 10파트 × 성분 수가 되어 못 쓴다)
  let partAt: Int16Array | null = null;
  if (o.parts?.length) {
    partAt = new Int16Array(N).fill(-1);
    for (let pi = 0; pi < o.parts.length; pi++) {
      const m = o.parts[pi].mask;
      for (let i = 0; i < N; i++) if (m[i]) partAt[i] = pi;
    }
  }

  // ── 4) 닫힌 면 → 색으로 묶기 → 윤곽 추적 ──────────────────
  // minRegionPx 는 **원본 도면 기준**이다. 작업 캔버스를 키웠으면 면적도 그만큼 커진다.
  const faceLab = labelComponents(enclosed, W, H, 4, o.minRegionPx * supersample * supersample);
  let dropped = 0;
  const groups: { color: string; area: number; mask: Uint8Array; partId?: string }[] = [];
  const scratch = new Uint8Array(N);
  for (const c of faceLab.components) {
    let color = o.sampleFill ? dominantOf(colorData, colorCh, c) : "#ffffff";
    // 지운 해프톤 자리는 톤 면으로 되살린다. 점을 지운 뒤 색을 샘플링하면 흰색이
    // 나와 질감이 통째로 사라지므로, 덮인 비율만큼 어둡게 눌러 준다.
    {
      let tex = 0;
      for (let k = 0; k < c.pixels.length; k++) if (texture[c.pixels[k]]) tex++;
      if (tex > c.area * 0.35) color = tone(color, 0.14 + 0.1 * (tex / c.area));
    }
    let partId: string | undefined;
    if (o.parts?.length && partAt) {
      const tally = new Int32Array(o.parts.length);
      for (let k = 0; k < c.pixels.length; k++) {
        const p = partAt[c.pixels[k]];
        if (p >= 0) tally[p]++;
      }
      let best = -1, bestN = 0;
      for (let p = 0; p < tally.length; p++) if (tally[p] > bestN) { bestN = tally[p]; best = p; }
      partId = best >= 0 ? o.parts[best].id : o.parts[0].id;
    }
    const hit = groups.find((g) => g.partId === partId && colorClose(g.color, color, o.colorMergeDeltaE));
    if (hit) {
      for (let k = 0; k < c.pixels.length; k++) hit.mask[c.pixels[k]] = 1;
      hit.area += c.area;
    } else {
      const m = new Uint8Array(N);
      for (let k = 0; k < c.pixels.length; k++) m[c.pixels[k]] = 1;
      groups.push({ color, area: c.area, mask: m, partId });
    }
  }

  const regions: VecPath[] = [];
  const drawn = new Uint8Array(N);
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    // 면을 살짝 넓혀 선 중심까지 닿게 한다 — 면과 선 사이 틈 방지
    const grown = dilate(g.mask, W, H, Math.max(1, Math.round(supersample / 2)));
    const traced = await traceMask(grown, W, H, path.join(workDir, `face_${gi}.png`), o.simplifyPx);
    if (!traced.length) { dropped++; continue; }
    for (const d of traced) {
      regions.push({ partId: g.partId, d, fill: g.color, stroke: null, strokeWidth: null, area: g.area, kind: "fill" });
    }
    for (let i = 0; i < N; i++) if (g.mask[i]) drawn[i] = 1;
  }
  regions.sort((a, b) => b.area - a.area);

  // ── 5) 선 ────────────────────────────────────────────────
  const strokes: VecPath[] = [];
  let centerlineCount = 0, outlineCount = 0;
  if (area(ink)) {
    const inkPng = path.join(workDir, "ink.png");
    await writeMask(ink, W, H, inkPng);

    if (o.mode === "outline") {
      for (const d of await traceMask(ink, W, H, path.join(workDir, "outline.png"), o.simplifyPx)) {
        strokes.push({ d, fill: "#111111", stroke: null, strokeWidth: null, area: 0, kind: "outline" });
        outlineCount++;
      }
    } else {
      const minLen = Math.max(4, Math.round(Math.min(W, H) * 0.012));
      const traced = await centerlineTrace(inkPng, {
        color: "#111111",
        inkThreshold: 128,
        minLength: minLen,
        maxPaths: o.maxStrokes,
        // 기본 상한 6 은 원본 해상도 기준 값이다. 우리는 확대 캔버스에서 추적하므로
        // 그대로 두면 모든 선이 상한에 눌린다. 선/면을 가르는 기준과 같은 값을 쓴다 —
        // 이보다 두꺼우면 애초에 선이 아니라 면이다.
        maxWidth: lineWidthLimit,
      });

      if (o.mode === "centerline") {
        for (const s of traced) {
          strokes.push({ d: s.d, fill: null, stroke: s.stroke ?? "#111111", strokeWidth: s.strokeWidth ?? 2, area: 0, kind: "centerline" });
          centerlineCount++;
        }
      } else {
        // hybrid — 굵기가 안정적인 **긴 구조선**만 stroke로 승격하고,
        // 그 stroke가 실제로 설명하지 못한 잉크는 outline으로 남긴다.
        const keep = traced.filter((s) => isStructural(s.d, s.strokeWidth ?? 2, W, H));
        const covered = await rasterizeStrokes(keep, W, H, path.join(workDir, "cover.png"));
        // stroke가 덮은 곳을 잉크에서 뺀다. 여유를 1px 줘서 경계 잔털이 남지 않게 한다.
        const grownCover = dilate(covered, W, H, 1);
        const residual = new Uint8Array(N);
        let residN = 0;
        for (let i = 0; i < N; i++) if (ink[i] && !grownCover[i]) { residual[i] = 1; residN++; }

        for (const s of keep) {
          strokes.push({ d: s.d, fill: null, stroke: s.stroke ?? "#111111", strokeWidth: s.strokeWidth ?? 2, area: 0, kind: "centerline" });
          centerlineCount++;
        }
        if (residN > N * 0.00002) {
          for (const d of await traceMask(residual, W, H, path.join(workDir, "residual.png"), o.simplifyPx)) {
            strokes.push({ d, fill: "#111111", stroke: null, strokeWidth: null, area: 0, kind: "outline" });
            outlineCount++;
          }
        }
      }
    }
  }

  // ── 6) 파트 배분 — **곡선 위의 점**으로 ────────────────────
  //
  // 예전에는 `d` 문자열의 숫자를 훑어 좌표쌍으로 썼다. 큐빅 베지어의 제어점은 곡선 위에
  // 없으므로 곡률이 큰 곳에서 엉뚱한 파트에 배정된다. 이제 실제로 곡선을 평탄화해 샘플링한다.
  let sharedPaths = 0;
  if (o.parts?.length) {
    for (const s of strokes) {
      const a = assignByCurve(s.d, o.parts, W, H);
      s.partId = a.partId;
      if (a.shared.length) { s.shared = a.shared; sharedPaths++; }
    }
  }

  let covered = 0;
  for (let i = 0; i < N; i++) if (enclosed[i] && drawn[i]) covered++;

  const nodeCount = (d: string) => (d.match(new RegExp("[LCQSTA]", "g")) ?? []).length;
  const nodes =
    regions.reduce((n, p) => n + nodeCount(p.d), 0) +
    strokes.reduce((n, p) => n + nodeCount(p.d), 0);

  return {
    regions,
    strokes,
    stats: {
      workWidth: W,
      workHeight: H,
      supersample,
      inkRatio: +(area(ink) / N).toFixed(4),
      enclosedRatio: +(enclosedN / N).toFixed(4),
      textureRatio: +(area(texture) / N).toFixed(4),
      speckDroppedOutsideTexture,
      textureKept,
      textureAreaShare: +textureAreaShare.toFixed(3),
      textureInkShare: +textureInkShare.toFixed(3),
      regionCount: regions.length,
      regionDropped: dropped,
      colorGroups: groups.length,
      strokeCount: strokes.length,
      centerlineCount,
      outlineCount,
      nodes,
      coverage: enclosedN ? +(covered / enclosedN).toFixed(4) : 1,
      sharedPaths,
    },
    ink,
    texture,
    width: W,
    height: H,
  };
}

// ── 헬퍼 ────────────────────────────────────────────────────

/** 적분영상 기반 박스 평균 — 국소 대비 임계용 */
function boxMean(gray: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const sum = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += gray[y * W + x];
      sum[(y + 1) * (W + 1) + (x + 1)] = sum[y * (W + 1) + (x + 1)] + row;
    }
  }
  const out = new Uint8Array(W * H);
  const S = W + 1;
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
      const total =
        sum[(y1 + 1) * S + (x1 + 1)] - sum[y0 * S + (x1 + 1)] -
        sum[(y1 + 1) * S + x0] + sum[y0 * S + x0];
      out[y * W + x] = (total / ((y1 - y0 + 1) * (x1 - x0 + 1))) | 0;
    }
  }
  return out;
}

/**
 * centerline으로 올려도 되는 선인가.
 *
 * 판정은 **길이 대비 굵기**로 한다. 길고 가는 선은 중심선이 잘 정의되지만, 짧거나 굵은
 * 조각(로고 글자, 버클, 지퍼 헤드, 교차점 뭉치)은 중심선이 의미를 잃고 원형 캡이 겹쳐
 * 검은 혹이 된다. 그런 것은 outline으로 남기는 편이 형상에 훨씬 충실하다.
 */
function isStructural(d: string, width: number, W: number, H: number): boolean {
  const pts = samplePath(d, 3, 400);
  if (pts.length < 3) return false;
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const minLen = Math.min(W, H) * 0.03;
  return len >= minLen && len >= width * 8;
}

/** stroke들을 실제로 래스터화해 "설명된 잉크"를 얻는다 */
async function rasterizeStrokes(
  paths: { d: string; strokeWidth?: number | null }[],
  W: number,
  H: number,
  tmp: string,
): Promise<Uint8Array> {
  const out = new Uint8Array(W * H);
  if (!paths.length) return out;
  const body = paths
    .map((p) => `<path d="${p.d}" fill="none" stroke="#000" stroke-width="${(p.strokeWidth ?? 2)}" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`;
  const g = await sharp(Buffer.from(svg))
    .flatten({ background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer();
  for (let i = 0; i < W * H; i++) if (g[i] < 200) out[i] = 1;
  void tmp;
  return out;
}

async function writeMask(mask: Uint8Array, W: number, H: number, dest: string): Promise<void> {
  const buf = Buffer.alloc(W * H, 255);
  for (let i = 0; i < W * H; i++) if (mask[i]) buf[i] = 0;
  await sharp(buf, { raw: { width: W, height: H, channels: 1 } }).png().toFile(dest);
}

/**
 * 이진 마스크를 채워진 컴파운드 패스들로 추적.
 *
 * VTracer 출력을 그대로 쓰면 안 되는 두 가지가 있다 — 둘 다 빠뜨리면 결과가 조용히 망가진다.
 *   · 배경까지 하나의 **흰 패스**로 뱉는다. 그대로 두면 도면 위에 흰 사각형이 덮인다.
 *   · 패스에 `transform="translate(tx,ty)"`를 붙인다. transform 을 무시하고 `d` 만 가져오면
 *     **모든 패스가 통째로 밀린다**(실측: 가방 선이 조각조각 어긋나고 F@2px 0.994 → 0.738).
 *     여기서 좌표에 직접 더해 없앤다.
 */
async function traceMask(
  mask: Uint8Array,
  W: number,
  H: number,
  tmp: string,
  simplifyPx: number,
): Promise<string[]> {
  if (!area(mask)) return [];
  await writeMask(mask, W, H, tmp);
  const svg = await vectorize(await fsp.readFile(tmp), {
    ...TRACE_SPLINE,
    filterSpeckle: Math.max(1, Math.round(simplifyPx * 2)),
  });

  const out: string[] = [];
  PATH_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_TAG.exec(svg))) {
    const attrs = m[1];
    const d = D_ATTR.exec(attrs)?.[1];
    if (!d) continue;
    const fill = (FILL_ATTR.exec(attrs)?.[1] ?? "").trim().toLowerCase();
    // 마스크를 검정으로 그렸으므로 흰 path 는 배경이다
    if (fill === "#fff" || fill === "#ffffff" || fill === "white") continue;

    let dd = d;
    const tr = TRANSLATE_ATTR.exec(attrs);
    if (tr) {
      const tx = parseFloat(tr[1]), ty = parseFloat(tr[2]);
      let k = 0;
      NUMBER.lastIndex = 0;
      dd = d.replace(NUMBER, (num) => {
        const v = parseFloat(num) + (k++ % 2 === 0 ? tx : ty);
        return String(Math.round(v * 100) / 100);
      });
    }
    const opt = optimizePathData(dd, { minArea: 4, epsilon: simplifyPx });
    if (opt.d && new RegExp("[LCQS]").test(opt.d)) out.push(opt.d);
  }
  return out;
}

/** 성분 픽셀들의 지배색 (8×8×8 히스토그램) */
function dominantOf(data: Buffer | Uint8Array, ch: number, c: Component): string {
  const bins = new Uint32Array(512);
  for (let k = 0; k < c.pixels.length; k++) {
    const p = c.pixels[k] * ch;
    bins[((data[p] >> 5) << 6) | ((data[p + 1] >> 5) << 3) | (data[p + 2] >> 5)]++;
  }
  let best = 0, bestN = 0;
  for (let i = 0; i < 512; i++) if (bins[i] > bestN) { bestN = bins[i]; best = i; }
  // 대표 bin 안에서 평균을 내 색 계단을 줄인다
  let r = 0, g = 0, b = 0, n = 0;
  for (let k = 0; k < c.pixels.length; k++) {
    const p = c.pixels[k] * ch;
    if ((((data[p] >> 5) << 6) | ((data[p + 1] >> 5) << 3) | (data[p + 2] >> 5)) !== best) continue;
    r += data[p]; g += data[p + 1]; b += data[p + 2]; n++;
  }
  if (!n) return "#ffffff";
  return toHex([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
}

/** 색을 amount 만큼 검정 쪽으로 눌러 톤 면을 만든다 */
function tone(hex: string, amount: number): string {
  const v = parseInt(hex.slice(1), 16);
  const k = 1 - Math.min(0.45, amount);
  const c = (s: number) => Math.round(((v >> s) & 255) * k);
  return toHex([c(16), c(8), c(0)]);
}

function colorClose(a: string, b: string, limit: number): boolean {
  const p = (h: string) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  return deltaE2000Rgb(r1, g1, b1, r2, g2, b2) < limit;
}
