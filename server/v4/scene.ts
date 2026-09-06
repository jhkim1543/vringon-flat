/**
 * VectorScene 구성 — 증거 → 라우팅 → 표현 컴파일.
 *
 * 성분마다 표현을 하나 고른 뒤, **같은 표현끼리 모아 한 번에** 만든다. 성분마다 추적기를
 * 부르면 수백 번 호출이 되어 못 쓴다(도면 하나에 성분이 1,000개를 넘는다).
 * 배타성은 마스크 수준에서 지킨다 — 한 성분의 픽셀은 정확히 하나의 마스크에만 들어간다.
 */
import path from "node:path";
import fsp from "node:fs/promises";
import sharp from "sharp";
import { vectorize, ColorMode, Hierarchical, PathSimplifyMode } from "@neplex/vectorizer";
import { centerlineTrace, skeletonize, crossingNumber } from "../vector/centerline.js";
import { optimizePathData } from "../vector/optimize.js";
import { assignByCurve, samplePath } from "../v3/pathSample.js";
import { labelComponents } from "../v3/label.js";
import { area, deltaE2000Rgb, dilate, toHex } from "../v2/raster.js";
import { extractEvidence, traceContour, type EvidenceField, type ComponentEvidence } from "./evidence.js";
import { bestFit, type FitResult } from "./primitives.js";
import { findPatterns, findDashRuns } from "./pattern.js";
import { buildOwnerMap, splitByOwner, neighborsOf, fillTinyHoles } from "./inkOwner.js";
import { distanceTransform } from "../v3/metrics.js";
import { splitCompound } from "./compound.js";
import { refitPath, pathDeviation, thinAnchors, dropDegenerate, widthGrades, snapGrade, enforceAnchorSpacing, mergeStraightRuns } from "./refit.js";
import { bridgeGaps } from "./bridgeGaps.js";
import { rescueContinuity } from "./continuity.js";
import { mergeOpenStrokes } from "./lineMerge.js";
import { compressPeriodic, clusterStrokes } from "./periodic.js";
import { buildDashChains } from "./dashCarrier.js";
import { parsePath, subPathArea } from "../vector/pathdata.js";
import { findLetterRegions, letterMaskFromBoxes } from "./letterDetect.js";

/**
 * 재피팅 허용오차(작업 캔버스 px). 0 이면 끈다.
 * VTracer 는 곡선 조각을 잘게 내보내 직선 한 줄에도 앵커가 수십 개 붙는다 —
 * 점들에 새 곡선을 맞춰 다시 만든다.
 *
 * 2.4 는 실측으로 정했다 (jewelry_2, 도면 기준 QA):
 *   끄면      앵커 3,056 · F@0 0.9290 · 선F@2 0.9938
 *   1.6       앵커 2,517 (−18%) · F@0 0.9262 · 선F@2 0.9938 (불변)
 *   **2.4**   앵커 2,035 (−33%) · F@0 0.9170 · 선F@2 0.9924
 *   3.2       앵커 1,461 (−52%) · F@0 0.9062 · 선F@2 0.9906
 * 선F@2(게이트 기준)는 2.4 까지 사실상 그대로다.
 */
/**
 * **단순화 허용오차는 측정 창보다 작아야 한다.** QA 는 2px 창(f2)으로 판정하는데
 * 여기가 2.4px 였다 — 단순화가 허용하는 이탈이 측정 창을 넘어, 통과 못 할 오차를
 * 구조적으로 싣고 있었다. GPT-5.6·Gemini 3.1 이 독립적으로 같은 곳을 지목했고
 * 스윕이 확인했다(shoe_1: 2.4 → 1.0 에서 선 F@2 0.961 → 0.9814).
 * 무릎점은 1.0~1.3 이며 1.3 을 기본으로 둔다.
 */
const REFIT_ERR = Number(process.env.V4_REFIT ?? 1.3);

/**
 * 패턴 모티프 재피팅 — **인스턴스 수만큼 곱해지는 자리**다.
 *
 * 모티프는 지금까지 재피팅을 한 번도 안 거쳤다. 그래서 17×3px 조각에 앵커가 34개 붙은 채로
 * 1,038번 복제됐다(실측 bag_2: 펼치면 87,320개 · bag_3 34,343 · shoe_3 32,878). SVG 에서는
 * `<use>` 참조라 세어도 한 번뿐이지만, `.ai` 는 인스턴스마다 펼치므로 Illustrator 를 열면
 * 그대로 드러난다 — 앵커 밀도 지표가 실제보다 좋게 나오던 이유이기도 하다.
 *
 * 허용오차는 모티프 크기에 맞춘다. 3px 두께 조각에 2.4px 를 쓰면 형체가 사라진다.
 */
function refitMotif(d: string, size: [number, number]): string {
  if (REFIT_ERR <= 0) return d;
  const thin = Math.max(1, Math.min(size[0], size[1]));
  // 이탈 한계는 **모티프 두께에 대한 비율**로 정한다. 3px 조각과 50px 조각에 같은 px
  // 한계를 쓰면 한쪽은 뭉개지고 다른 쪽은 하나도 안 줄어든다.
  const cap = Math.min(MOTIF_DEV_CAP, Math.max(MOTIF_DEV_FLOOR, thin * MOTIF_DEV_RATIO));

  let best = d, bestA = anchorsOf(d);
  for (const ratio of MOTIF_LADDER) {
    const err = Math.min(REFIT_ERR, Math.max(0.3, thin * ratio));
    // 서브패스 단위 안전장치를 켠 것과 끈 것을 **둘 다** 후보로 둔다. 켜면 어긋나는
    // 조각만 원본으로 되돌아가고(앵커가 늘 수 있다), 끄면 전부 새로 맞춘다. 어느 쪽이
    // 이길지는 모티프마다 다르다 — 실측에서 bag_2 는 끈 쪽이, bag_3 은 켠 쪽이 나았다.
    for (const devLimit of [2.5, Infinity]) {
      const cand = refitPath(d, err, { devLimit }).d;
      if (!cand) continue;
      const a = anchorsOf(cand);
      if (a >= bestA) continue;
      // 최종 판정은 **모티프 전체**의 어긋남으로 한다 — 서브패스 기준은 조각 안쪽만 본다
      if (pathDeviation(d, cand) > cap) continue;
      best = cand; bestA = a;
    }
  }
  // 마지막으로 직선 위에 남은 앵커를 걷어낸다 — 한계는 모티프 것을 그대로 쓴다
  const thinned = thinAnchors(best, cap);
  return anchorsOf(thinned) < bestA && pathDeviation(d, thinned) <= cap ? thinned : best;
}
const anchorsOf = (d: string) => (d.match(new RegExp("[MLCQSTA]", "g")) ?? []).length;

/**
 * 경로 `d` 의 실제 bbox. **`[0,0,W,H]` 를 넣으면 안 되는 이유**: z 정렬·면적 통계·QA 의
 * 영역 판정이 전부 캔버스 전체를 보게 된다(실측: 글리프 bbox 를 캔버스로 두었더니
 * QA 의 글리프 제외 영역이 도면 전부가 되어 골격 F@3 가 0.000 이 됐다).
 */
/**
 * 패스를 점열로 편다 — 닫힌 획을 원·타원에 맞춰 보기 위해.
 *
 * `v4/types` 의 Pt 는 `{x,y}` 이고 `vector/pathdata` 의 Pt 는 `[x,y]` 다. 여기서는
 * **적합기가 쓰는 `{x,y}` 로 맞춰 낸다** — 두 표현을 섞으면 조용히 어긋난다.
 */
function flattenForFit(d: string, step = 2): Pt[] {
  const out: Pt[] = [];
  const put = (x: number, y: number) => out.push({ x, y } as unknown as Pt);
  for (const sp of parsePath(d)) {
    let cur = sp.start;
    put(cur[0], cur[1]);
    for (const seg of sp.segs) {
      if (seg.type === "L") { put(seg.end[0], seg.end[1]); cur = seg.end; continue; }
      const [x0, y0] = cur, [x1, y1] = seg.c1!, [x2, y2] = seg.c2!, [x3, y3] = seg.end;
      const rough = Math.hypot(x3 - x0, y3 - y0) + Math.hypot(x1 - x0, y1 - y0);
      const n = Math.max(2, Math.min(16, Math.ceil(rough / step)));
      for (let i = 1; i <= n; i++) {
        const t = i / n, m = 1 - t;
        put(
          m * m * m * x0 + 3 * m * m * t * x1 + 3 * m * t * t * x2 + t * t * t * x3,
          m * m * m * y0 + 3 * m * m * t * y1 + 3 * m * t * t * y2 + t * t * t * y3,
        );
      }
      cur = seg.end;
    }
  }
  return out;
}

function bboxOfPath(d: string, W: number, H: number): [number, number, number, number] {
  // **정규식 리터럴로 쓴다.** `new RegExp("-?\d*\.?\d+")` 로 적으면 JS 문자열이
  // `\d` 를 `d` 로 삼켜 `-?d*.?d+` 가 되고, 패스 문자열에서 아무것도 못 잡아
  // 모든 bbox 가 조용히 캔버스 전체로 떨어진다(실측 jewelry_1_line: 글리프 10개가
  // 전부 [0,0,W,H] 라 골격 비교 영역이 통째로 제외돼 F@3 이 0 이 됐다).
  const n = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < n.length; i += 2) {
    if (n[i] < x0) x0 = n[i];
    if (n[i] > x1) x1 = n[i];
    if (n[i + 1] < y0) y0 = n[i + 1];
    if (n[i + 1] > y1) y1 = n[i + 1];
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, W, H];
}
/**
 * 모티프마다 이 배율들을 다 해 보고 **한계 안에서 앵커가 가장 적은 것**을 고른다.
 * 하나만 쓰면 결과가 단조롭지 않다 — 실측에서 배율을 0.08 → 0.20 으로 올렸더니
 * bag_3 의 모티프 앵커가 78 → 157 로 오히려 늘었다(허용오차가 커지면 샘플 간격과
 * 코너 창도 함께 커져 피팅이 다른 곳에서 갈라진다). 골라 담으면 그런 역행이 없다.
 */
const MOTIF_LADDER = (process.env.V4_MOTIF_LADDER ?? "0.08,0.15,0.25,0.4,0.6")
  .split(",").map(Number).filter((v) => v > 0);
/**
 * 이탈 한계 = 짧은 변 × 이 값, 단 아래위로 자른다.
 *
 * 천장이 2.5px 였을 때 **큰 모티프가 통째로 거부**됐다. shoe_3 의 78×209px 모티프는
 * 직선 239개짜리 원본 그대로 20번 복제됐다 — 다시 맞추면 앵커 6개면 되는데 그때 이탈이
 * 3.85px 라 한계에 걸렸다. 78px 짜리 도형에 3.85px 는 5% 다. 바닥도 마찬가지로,
 * 2px 두께 모티프는 0.6px 한계에 걸려 앵커 13개를 그대로 지고 있었다(필요한 값은 0.84).
 *
 * 실측(5개 샘플의 거부된 모티프 4개, 펼친 앵커 24,572 기준):
 *   한계 2.5px →   875 감소     **4px → 10,355 감소**     6·8·12px → 4px 와 동일
 * 4px 위로는 더 얻을 것이 없다. 그래서 4.
 */
const MOTIF_DEV_RATIO = Number(process.env.V4_MOTIF_DEV_RATIO ?? 0.3);
const MOTIF_DEV_FLOOR = Number(process.env.V4_MOTIF_DEV_FLOOR ?? 1.0);
const MOTIF_DEV_CAP = Number(process.env.V4_MOTIF_DEV_CAP ?? 4.0);

/**
 * 단순화 허용오차의 상한(작업 캔버스 px). 원본 좌표 기준으로 환산한 값이 이보다 커지지
 * 않게 막는다. 실측으로 정한다 — 올리면 앵커가 줄고 형상이 흐려진다.
 */
const EPS_CAP = Number(process.env.V4_EPS_CAP ?? 1.6);

/**
 * 앵커 솎기 허용오차(px). 재피팅이 끝난 뒤 **직선 위에 붙어 남은** 앵커를 뺄 때 쓴다.
 * 재피팅 허용오차와 같은 값이면 "재피팅이 허용한 만큼만 더 허용한다"는 뜻이 된다.
 */
const THIN_TOL = Number(process.env.V4_THIN ?? REFIT_ERR);

/** 라인 모드 균일 굵기(px). 0 이면 체인별 실측 굵기 */
const LINE_WIDTH = Number(process.env.V4_LINE_WIDTH ?? 0);
import { isGemPart } from "./gemFlatten.js";
import type { Pt } from "./types.js";
import { routeComponent, DEFAULT_THRESHOLDS, type RouteThresholds } from "./router.js";
import type {
  GeometricPrimitive, PartNode, PatternPrimitive, ScenePrimitive,
  SharedBoundary, ShapePrimitive, StrokePrimitive, VectorScene,
} from "./types.js";

const TRACE = {
  colorMode: ColorMode.Binary,
  hierarchical: Hierarchical.Cutout,
  mode: PathSimplifyMode.Spline,
  colorPrecision: 6,
  layerDifference: 16,
  cornerThreshold: 60,
  /**
   * 스플라인 한 조각의 최소 길이. **앵커 수를 정하는 진짜 손잡이다.**
   * optimizePathData 의 epsilon 을 올려도 앵커가 안 줄었다 — VTracer 가 이미 만들어 놓은
   * 조각들이 곡률이 달라 병합 조건에 안 걸리기 때문이다. 여기서 줄여야 준다.
   *
   * 4 → **8** 로 올렸다. A/B 실측(jewelry_2 · shoe_1 · bag_2 · bag_3):
   *   4 → 8   앵커 −16~24% · 충실도 불변 (jewelry_2 는 F@0 0.9278 → 0.9290 으로 **개선**)
   *   8 → 14  앵커 −10% 더 · F@0 −0.005~0.010 손해
   * 8 이 공짜에 가깝고 14 부터 값을 치른다. 그래서 8.
   */
  lengthThreshold: Number(process.env.V4_LEN_TH ?? 8),
  maxIterations: 10,
  spliceThreshold: Number(process.env.V4_SPLICE ?? 45),
  pathPrecision: 3,
} as const;

const PATH_TAG = new RegExp("<path\\b([^>]*?)/?>", "g");
const D_ATTR = new RegExp('d="([^"]*)"');
const FILL_ATTR = new RegExp('fill="([^"]*)"');
const TRANSLATE_ATTR = new RegExp("translate\\(([-0-9.]+)[ ,]+([-0-9.]+)\\)");
const NUMBER = new RegExp("-?\\d*\\.?\\d+(?:e[-+]?\\d+)?", "gi");

export interface SceneOptions {
  inkThreshold: number;
  localContrast: number;
  workLong: number;
  textureMode: "auto" | "tone" | "keep";
  simplifyPx: number;
  minRegionPx: number;
  colorMergeDeltaE: number;
  sampleFill: boolean;
  colorFrom?: string;
  workDir: string;
  thresholds: RouteThresholds;
  parts?: { id: string; mask: Uint8Array }[];
  partNodes?: PartNode[];
  /** 제품 카테고리 — 보석 반사 제거처럼 카테고리에만 맞는 처리를 가른다 */
  category?: string;
  /**
   * **라인 모드** — 잉크를 면(외곽선 추적)이 아니라 **중심선 스트로크**로 표현한다.
   *
   * 외곽선 추적은 3px 선 하나를 "안쪽 윤곽 + 바깥 윤곽" 닫힌 면으로 떠서, 앵커가
   * 선 양쪽에 두 벌 생기고 선 하나를 옮기려면 양쪽 경계를 다 잡아야 한다(사용자 지적).
   * 라인 모드는 골격 체인마다 패스 하나 — 앵커가 중심선 위에 한 줄로 놓이고,
   * 굵기는 stroke-width 값 하나라 디자이너가 숫자로 바꾼다. 면(FACE_FILL)은 아예
   * 만들지 않는다 — "면이라는 걸 표현하지 말자".
   */
  lineMode?: boolean;
  /**
   * **선을 라이브 스트로크로 낸다** — 면은 그대로 만든다.
   *
   * `lineMode` 는 두 가지를 한꺼번에 했다: (가) 선을 중심선 스트로크로 내고 (나) 면을
   * 아예 안 만든다. 그런데 실무 심사에서 둘이 **서로 다른 사람의 요구**임이 드러났다.
   *   · 테크니컬 디자이너·일러스트레이터: "선이 확장된 면이라 굵기를 못 바꾼다" → (가)가 필요
   *   · 텍스타일·그래픽 디자이너: "면이 없어 색을 못 채운다" → (나)는 곤란
   * 그래서 축을 갈랐다. 이 옵션만 켜면 **면은 채울 수 있고 선은 굵기를 바꿀 수 있는**
   * 산출물이 된다 — 사람이 그린 도식화의 구조가 바로 그것이다.
   */
  strokeLines?: boolean;
  /**
   * 스트로크 굵기를 **몇 등급으로 양자화**할지. 0 이면 체인별 실측값을 그대로 쓴다.
   *
   * 도식화의 선 굵기는 재현이 아니라 **재할당**이다 — 외곽 > 구조 > 스티치의 위계가
   * 있어야 하고, 같은 뜻의 선은 같은 값이어야 한다. 사진에서 잰 굵기는 조명·초점을
   * 반영해 값이 수십 개로 흩어진다(실무 심사: "0.71/0.73/0.78 … 수십 개 고유값").
   */
  widthGrades?: number;
  /** 얇은 마감 — 굵기 위계는 지키고 값만 1.2~6px 사다리로 (앵커가 선에 파묻히지 않게) */
  thinFinish?: boolean;
  /** 도면 PNG 경로 — 라인 모드에서 각인 글자 인식에 쓴다 */
  schematicPath?: string;
}

export const DEFAULT_SCENE_OPTIONS: Omit<SceneOptions, "workDir"> = {
  inkThreshold: 170,
  localContrast: 22,
  workLong: 2200,
  textureMode: "auto",
  simplifyPx: 0.8,
  minRegionPx: 24,
  colorMergeDeltaE: 12,
  sampleFill: false,
  thresholds: DEFAULT_THRESHOLDS,
};

async function writeMask(mask: Uint8Array, W: number, H: number, dest: string): Promise<void> {
  const buf = Buffer.alloc(W * H, 255);
  for (let i = 0; i < W * H; i++) if (mask[i]) buf[i] = 0;
  await sharp(buf, { raw: { width: W, height: H, channels: 1 } }).png().toFile(dest);
}

/**
 * 이진 마스크를 채워진 패스들로. VTracer 출력의 두 가지를 반드시 처리해야 한다 —
 * 배경까지 흰 패스로 뱉는 것과, 패스에 `transform="translate()"` 를 붙이는 것.
 * transform 을 무시하면 **모든 패스가 통째로 밀린다**(V3에서 겪은 실패).
 */
async function traceMask(
  mask: Uint8Array, W: number, H: number, tmp: string, simplifyPx: number,
): Promise<string[]> {
  if (!area(mask)) return [];
  await writeMask(mask, W, H, tmp);
  const svg = await vectorize(await fsp.readFile(tmp), {
    ...TRACE, filterSpeckle: Math.max(1, Math.round(simplifyPx * 2)),
  });
  const out: string[] = [];
  PATH_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_TAG.exec(svg))) {
    const attrs = m[1];
    const d = D_ATTR.exec(attrs)?.[1];
    if (!d) continue;
    const fill = (FILL_ATTR.exec(attrs)?.[1] ?? "").trim().toLowerCase();
    if (fill === "#fff" || fill === "#ffffff" || fill === "white") continue;
    let dd = d;
    const tr = TRANSLATE_ATTR.exec(attrs);
    if (tr) {
      const tx = parseFloat(tr[1]), ty = parseFloat(tr[2]);
      let k = 0;
      NUMBER.lastIndex = 0;
      dd = d.replace(NUMBER, (num) => String(Math.round((parseFloat(num) + (k++ % 2 === 0 ? tx : ty)) * 100) / 100));
    }
    const opt = optimizePathData(dd, { minArea: 4, epsilon: simplifyPx });
    if (!opt.d || !new RegExp("[LCQS]").test(opt.d)) continue;
    const fitted = REFIT_ERR > 0 ? refitPath(opt.d, REFIT_ERR).d : opt.d;
    out.push(thinAnchors(fitted, THIN_TOL));
  }
  return out;
}

function tone(hex: string, amount: number): string {
  const v = parseInt(hex.slice(1), 16);
  const k = 1 - Math.min(0.45, amount);
  const c = (s: number) => Math.round(((v >> s) & 255) * k);
  return toHex([c(16), c(8), c(0)]);
}

function colorClose(a: string, b: string, limit: number): boolean {
  const p = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  return deltaE2000Rgb(r1, g1, b1, r2, g2, b2) < limit;
}

function dominantOf(data: Buffer | Uint8Array, ch: number, pixels: Int32Array): string {
  const bins = new Uint32Array(512);
  for (let k = 0; k < pixels.length; k++) {
    const p = pixels[k] * ch;
    bins[((data[p] >> 5) << 6) | ((data[p + 1] >> 5) << 3) | (data[p + 2] >> 5)]++;
  }
  let best = 0, bestN = 0;
  for (let i = 0; i < 512; i++) if (bins[i] > bestN) { bestN = bins[i]; best = i; }
  let r = 0, g = 0, b = 0, n = 0;
  for (let k = 0; k < pixels.length; k++) {
    const p = pixels[k] * ch;
    if ((((data[p] >> 5) << 6) | ((data[p + 1] >> 5) << 3) | (data[p + 2] >> 5)) !== best) continue;
    r += data[p]; g += data[p + 1]; b += data[p + 2]; n++;
  }
  return n ? toHex([Math.round(r / n), Math.round(g / n), Math.round(b / n)]) : "#ffffff";
}

/** stroke 들을 실제로 그려 "설명된 잉크"를 얻는다 */
async function rasterizeStrokes(
  paths: { d: string; strokeWidth?: number | null }[], W: number, H: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(W * H);
  if (!paths.length) return out;
  const body = paths.map((p) =>
    `<path d="${p.d}" fill="none" stroke="#000" stroke-width="${p.strokeWidth ?? 2}" stroke-linecap="round" stroke-linejoin="round"/>`).join("");
  const g = await sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`))
    .flatten({ background: "#ffffff" }).greyscale().raw().toBuffer();
  for (let i = 0; i < W * H; i++) if (g[i] < 200) out[i] = 1;
  return out;
}

let seq = 0;
const nextId = (p: string) => `${p}${(++seq).toString(36)}`;

export async function buildScene(
  pngPath: string,
  opts: SceneOptions,
  say?: (m: string) => void,
): Promise<{ scene: VectorScene; evidence: EvidenceField }> {
  seq = 0;
  await fsp.mkdir(opts.workDir, { recursive: true });

  // 보석 파트를 골라 넘긴다 — 그 안쪽의 빛 반사·그림자는 제품의 형상이 아니다
  // **주얼리에서만 돈다.** "bead" 는 주얼리에서는 진주 알이지만 가방에서는 소재 그 자체다
  // (실측: bag_2 "Beaded pouch body" 가 보석으로 잡혀 비즈 조직이 통째로 지워졌다 —
  // 패스 671 → 136). 카테고리를 안 보면 이 처리는 남의 제품을 망친다.
  const isJewelry = /jewel|ring|earring|necklace|bracelet|pendant/i.test(opts.category ?? "");
  const gemParts = !isJewelry ? [] : (opts.parts ?? []).filter((pm) => {
    const node = opts.partNodes?.find((n) => n.id === pm.id);
    return isGemPart(node?.label ?? "", pm.id);
  });
  const ev = await extractEvidence(pngPath, {
    inkThreshold: opts.inkThreshold,
    localContrast: opts.localContrast,
    workLong: opts.workLong,
    textureMode: opts.textureMode,
    gemParts: gemParts.length ? gemParts : undefined,
  });
  const { width: W, height: H } = ev;
  const N = W * H;
  say?.(`증거 ${W}×${H} (×${ev.supersample}) · 성분 ${ev.components.length}`);
  if (ev.gemFlatten?.removed[0]) {
    say?.(`보석 반사 제거 — ${ev.gemFlatten.parts.join(", ")}: 얼룩 ${ev.gemFlatten.removed[0]}개(${ev.gemFlatten.removed[1]}px) 삭제 · 패싯 능선 ${ev.gemFlatten.keptFacets}개 보존`);
  }

  // 색 샘플링 원본
  let colorData: Buffer | Uint8Array = ev.rgb;
  let colorCh = ev.channels;
  if (opts.colorFrom) {
    const c = await sharp(opts.colorFrom).flatten({ background: "#ffffff" }).removeAlpha()
      .resize(W, H, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer({ resolveWithObject: true });
    colorData = c.data;
    colorCh = c.info.channels;
  }

  const primitives: ScenePrimitive[] = [];
  /** 픽셀별 최전면 파트 — 면 배정에서 만들어 패턴 배정에도 쓴다 */
  let facePartAt: Int16Array | null = null;
  let tinyHolesFilled = 0;

  // ── 닫힌 면 ──────────────────────────────────────────────
  {
    const outside = new Uint8Array(N);
    const q = new Int32Array(N);
    let head = 0, tail = 0;
    const push = (i: number) => { if (!outside[i] && !ev.inkFill[i]) { outside[i] = 1; q[tail++] = i; } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (head < tail) {
      const c = q[head++], x = c % W, y = (c / W) | 0;
      if (x > 0) push(c - 1);
      if (x < W - 1) push(c + 1);
      if (y > 0) push(c - W);
      if (y < H - 1) push(c + W);
    }
    const enclosed = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (!ev.inkFill[i] && !outside[i]) enclosed[i] = 1;

    const faces = labelComponents(enclosed, W, H, 4, opts.minRegionPx * ev.supersample * ev.supersample);
    const faceTol = Math.min(W, H) * opts.thresholds.primitiveToleranceRatio;
    const faceMember = new Uint8Array(N);

    // 파트 조회를 O(1)로. 픽셀마다 **가장 앞** 파트를 적어 둔다.
    let partAt: Int16Array | null = null;
    if (opts.parts?.length) {
      partAt = new Int16Array(N).fill(-1);
      for (let pi = 0; pi < opts.parts.length; pi++) {
        const m = opts.parts[pi].mask;
        for (let i = 0; i < N; i++) if (m[i]) partAt[i] = pi;
      }
    }

    /**
     * 면을 파트에 배정한다. **면적 겹침**으로 재야 한다 — 경계 좌표 표본은 선에는 맞지만
     * 면에는 맞지 않는다. 두 파트의 점수가 비슷하면 한쪽에 강제로 몰지 않고 공유로 표시한다.
     */
    const assignFace = (pixels: Int32Array): { id?: string; shared: string[]; covered: number } => {
      if (!opts.parts?.length || !partAt) return { shared: [], covered: 1 };
      const tally = new Int32Array(opts.parts.length);
      let hit = 0;
      for (let k = 0; k < pixels.length; k++) {
        const q2 = partAt[pixels[k]];
        if (q2 >= 0) { tally[q2]++; hit++; }
      }
      const covered = pixels.length ? hit / pixels.length : 0;
      let best = -1, bestN = 0, second = 0;
      for (let q2 = 0; q2 < tally.length; q2++) {
        if (tally[q2] > bestN) { second = bestN; bestN = tally[q2]; best = q2; }
        else if (tally[q2] > second) second = tally[q2];
      }
      if (best < 0) return { id: opts.parts[0].id, shared: [], covered };
      const shared: string[] = [];
      if (bestN && second >= bestN * 0.75) {
        for (let q2 = 0; q2 < tally.length; q2++) {
          if (q2 !== best && tally[q2] >= bestN * 0.75) shared.push(opts.parts[q2].id);
        }
      }
      return { id: opts.parts[best].id, shared, covered };
    };

    /**
     * **어느 파트 마스크도 덮지 않는 닫힌 면은 제품이 아니라 배경이다.**
     *
     * 선이 감싼 영역이라고 다 제품의 면은 아니다. 손잡이 두 가닥 사이, 체인의 V자 안쪽,
     * 버클 고리 안쪽은 **뚫려서 뒤가 보이는 자리**다. 그걸 면으로 채우면 흰 종이 위에
     * 흰 면이라 눈에는 안 보이지만, 레이어로는 엉뚱한 부품에 커다란 조각이 붙는다
     * (실측 bag_2: 체인 두 가닥 사이 삼각형이 chain_handle 에 들어가 precision 0.199).
     *
     * 마스크를 못 믿을 때는 이 규칙을 끈다 — 마스크가 제품을 거의 못 잡은 판에서
     * 이걸 적용하면 진짜 면까지 배경으로 몰린다.
     */
    const BG_COVER = Number(process.env.V4_BG_COVER ?? 0.2);
    let maskUnionPx = 0;
    if (partAt) for (let i = 0; i < N; i++) if (partAt[i] >= 0) maskUnionPx++;
    const trustMasks = maskUnionPx > N * 0.02;
    let bgFaces = 0, bgPx = 0;
    const isBackgroundFace = (at: { covered: number }, area: number): boolean => {
      if (!trustMasks) return false;
      // 작은 면은 그냥 둔다 — 잡티를 배경이라 부를 이유가 없고, 오판의 대가만 크다
      if (area < opts.minRegionPx * 8) return false;
      if (at.covered >= BG_COVER) return false;
      bgFaces++; bgPx += area;
      return true;
    };

    const faceColor = (c: { pixels: Int32Array; area: number }): string => {
      // **지운 반사는 색 표본에서도 지운다.** 스톤 안의 반사 잉크를 지우고 나면 그
      // 자리가 면에 편입되는데, 표본에 남겨 두면 지운 반사의 어두운 색이 스톤 면
      // 색으로 뽑혀 얼룩덜룩한 스톤이 된다(실측 jewelry_3 미리보기).
      const gm = ev.gemFlatten?.removedMask;
      let pixels = c.pixels;
      if (gm) {
        const kept: number[] = [];
        for (let k = 0; k < c.pixels.length; k++) if (!gm[c.pixels[k]]) kept.push(c.pixels[k]);
        // 남은 표본이 조금이라도 실하면 그걸 쓴다 — 반사 위에 통째로 앉은 면 조각도
        // 가장자리의 진짜 스톤 색으로 칠해져야 한다
        if (kept.length >= Math.min(30, c.pixels.length * 0.1)) pixels = Int32Array.from(kept);
      }
      let color = opts.sampleFill ? dominantOf(colorData, colorCh, pixels) : "#ffffff";
      let tex = 0;
      for (let k = 0; k < c.pixels.length; k++) if (ev.texture[c.pixels[k]]) tex++;
      if (tex > c.area * 0.35) color = tone(color, 0.14 + 0.1 * (tex / c.area));
      return color;
    };

    // ── 면 패턴: 같은 모양의 작은 면 수백 개는 개별 면이 아니라 반복이다 ──
    //
    // 프리미티브 적합보다 **먼저** 돈다. 아웃솔 러그·비즈 알이 각각 타원으로 승격되면
    // 이후 패턴 검출기는 아무것도 못 본다(실측: shoe_3 프리미티브 208개 · bag_3 은
    // 한 컴파운드 패스에 서브패스 1,089개).
    const faceInPattern = new Set<number>();
    {
      const cands: { idx: number; area: number; bbox: [number, number, number, number]; contour: Pt[] }[] = [];
      for (let fi = 0; fi < faces.components.length; fi++) {
        const c = faces.components[fi];
        if (c.area < opts.minRegionPx * 4 || c.area > N * 0.004) continue;
        for (let k = 0; k < c.pixels.length; k++) faceMember[c.pixels[k]] = 1;
        const contour = traceContour(c, W, H, faceMember);
        for (let k = 0; k < c.pixels.length; k++) faceMember[c.pixels[k]] = 0;
        if (contour.length < 6) continue;
        cands.push({ idx: fi, area: c.area, bbox: [c.x0, c.y0, c.x1, c.y1], contour });
      }
      for (const cl of findPatterns(cands, N)) {
        // 인스턴스마다 파트가 다를 수 있다 — 알알이 배정한다
        const tally = new Map<string, number>();
        const instances = cl.instances.map((inst, k) => {
          const at = assignFace(faces.components[cl.members[k].idx].pixels);
          if (at.id) tally.set(at.id, (tally.get(at.id) ?? 0) + 1);
          return { ...inst, partId: at.id };
        });
        let major: string | undefined, majorN = 0;
        for (const [id, n] of tally) if (n > majorN) { major = id; majorN = n; }
        const rep0 = faces.components[cl.members[0].idx];
        primitives.push({
          id: nextId("fp"), cls: "REPEATING_PATTERN", paint: "fill",
          motif: refitMotif(cl.motif, cl.motifSize), motifSize: cl.motifSize, instances,
          fill: faceColor(rep0), pathsSaved: cl.pathsSaved,
          area: cl.members.reduce((a, m) => a + m.area, 0),
          bbox: [
            Math.min(...cl.members.map((m) => m.bbox[0])), Math.min(...cl.members.map((m) => m.bbox[1])),
            Math.max(...cl.members.map((m) => m.bbox[2])), Math.max(...cl.members.map((m) => m.bbox[3])),
          ],
          partId: major,
          route: {
            chosen: "REPEATING_PATTERN",
            features: { members: cl.members.length, deviationMean: cl.shapeDeviation.mean, fromFaces: true },
            why: `닫힌 면 ${cl.members.length}개가 같은 모티프 (형상 편차 평균 ${cl.shapeDeviation.mean})`,
            confidence: Math.max(0.5, 1 - cl.shapeDeviation.mean * 3),
          },
        } as PatternPrimitive);
        for (const m of cl.members) faceInPattern.add(m.idx);
      }
      if (faceInPattern.size) say?.(`면 패턴: ${faceInPattern.size}개 면을 모티프로 압축`);
    }

    // **색 병합은 파트 배정 뒤에.** 먼저 화면 전체에서 같은 색끼리 묶으면 서로 다른 부품의
    // 흰 면들이 하나의 컴파운드 패스가 되고, 그 패스는 결국 파트 하나에만 들어간다 —
    // 가방 몸통·플랩·스트랩이 전부 회색/흰색이라 한 레이어로 몰렸다.
    const groups: { color: string; area: number; mask: Uint8Array; partId?: string; shared: string[] }[] = [];
    for (let fi = 0; fi < faces.components.length; fi++) {
      const c = faces.components[fi];
      if (faceInPattern.has(fi)) continue;
      const at = assignFace(c.pixels);
      // 뚫려서 뒤가 보이는 자리는 면이 아니다 — 채우면 엉뚱한 부품에 붙는다
      if (isBackgroundFace(at, c.area)) continue;

      // **원은 성분이 아니라 면에 있다.** 버클 구멍·에어홀·리벳·보석 윤곽은 선이 감싼 닫힌
      // 면이지 독립된 잉크 성분이 아니다(실측: jewelry_1 은 잉크 성분이 1개뿐이다).
      if (c.area >= opts.minRegionPx * 4) {
        for (let k = 0; k < c.pixels.length; k++) faceMember[c.pixels[k]] = 1;
        const contour = traceContour(c, W, H, faceMember);
        for (let k = 0; k < c.pixels.length; k++) faceMember[c.pixels[k]] = 0;
        const fit = bestFit(contour, { tolerance: faceTol, closed: true });
        if (fit) {
          primitives.push({
            id: nextId("gf"), cls: "GEOMETRIC_PRIMITIVE", kind: fit.kind, params: fit.params,
            // 면에서 온 프리미티브는 **fill** 이다. stroke 로 내면 굵기가 없어 사라진다.
            paint: "fill", fill: faceColor(c),
            d: fit.d,
            anchorsSaved: Math.max(0, Math.round(contour.length / 3) - fit.anchors),
            residual: { rms: fit.rms, max: fit.max },
            area: c.area, bbox: [c.x0, c.y0, c.x1, c.y1],
            partId: at.id, shared: at.shared.length ? at.shared : undefined,
            route: {
              chosen: "GEOMETRIC_PRIMITIVE",
              features: { area: c.area, fitMax: fit.max, contourPts: contour.length },
              why: `닫힌 면이 ${fit.kind} 에 적합 (잔차 max ${fit.max}px, 허용 ${faceTol.toFixed(1)}px)`,
              confidence: Math.max(0.6, Math.min(0.98, 1 - fit.max / Math.max(faceTol, 1e-6) / 2)),
            },
          } as GeometricPrimitive);
          continue;
        }
      }

      const color = faceColor(c);
      // 같은 **파트 안에서** 같은 색끼리만 묶는다
      const hit = groups.find((g) => g.partId === at.id && colorClose(g.color, color, opts.colorMergeDeltaE));
      if (hit) {
        for (let k = 0; k < c.pixels.length; k++) hit.mask[c.pixels[k]] = 1;
        hit.area += c.area;
        for (const id of at.shared) if (!hit.shared.includes(id)) hit.shared.push(id);
      } else {
        const m = new Uint8Array(N);
        for (let k = 0; k < c.pixels.length; k++) m[c.pixels[k]] = 1;
        groups.push({ color, area: c.area, mask: m, partId: at.id, shared: [...at.shared] });
      }
    }

    groups.sort((x, y) => y.area - x.area);
    // 라인 모드 — 면을 아예 만들지 않는다 ("면이라는 걸 표현하지 말자")
    if (opts.lineMode) groups.length = 0;
    // 얇은 마감 — 선화가 목표다. 면은 만들지 않되 **로고·글씨 파트만 예외**로 남긴다
    // (글자는 윤곽이 곧 내용이라 선으로 갈면 깨진다). 경계선은 이미 스트로크로 나간다.
    if (opts.thinFinish && !opts.lineMode) {
      const kept = groups.filter((g) => {
        const label = (opts.partNodes?.find((pn) => pn.id === g.partId)?.label ?? "").toLowerCase();
        if (!/letter|logo|engrav|inscript|text|brand|monogram|marking/.test(label)) return false;
        // 로고 파트라도 **어두운 면만** 로고 그림이다 — 밝은 면은 파트에 상속된
        // 배경 판이다(실측 th_shoe_1: swoosh_logo 에 #cecece 342k px 판이 붙어 있었다).
        const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(g.color);
        if (!m) return true;
        const luma = 0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16);
        return luma < 130;
      });
      if (kept.length < groups.length) say?.(`얇은 마감 — 면 ${groups.length - kept.length}개 생략 (로고·글씨 ${kept.length}개만 면으로)`);
      groups.length = 0;
      groups.push(...kept);
    }
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const grown = dilate(g.mask, W, H, Math.max(1, Math.round(ev.supersample / 2)));
      const faceEps = Math.min(EPS_CAP, opts.simplifyPx * ev.supersample);
      for (const draw of await traceMask(grown, W, H, path.join(opts.workDir, `face_${gi}.png`), faceEps)) {
        // 비즈·메시 배경 면은 알마다 구멍이 뚫려 서브패스가 수천 개가 된다. 그 구멍은
        // 위에 알이 그려지므로 보이지 않는다 — 메우면 편집만 쉬워지고 그림은 그대로다.
        const { d: filled, dropped } = fillTinyHoles(draw);
        if (dropped) tinyHolesFilled += dropped;
        for (const d of splitCompound(filled)) {
        primitives.push({
          id: nextId("f"), cls: "FACE_FILL", area: g.area, bbox: bboxOfPath(d, W, H), d, fill: g.color,
          partId: g.partId, shared: g.shared.length ? g.shared : undefined,
          route: {
            chosen: "FACE_FILL",
            features: { area: g.area, sharedWith: g.shared.length },
            why: "선이 감싼 닫힌 면 (파트 배정 후 같은 파트 안에서만 색 병합)",
            confidence: g.shared.length ? 0.6 : 0.9,
          },
        } as ShapePrimitive);
        }
      }
    }
    // ── 검게 채운 면 ─────────────────────────────────────────
    //
    // 증거 단계가 "선보다 두꺼운 잉크"로 갈라 낸 덩어리다. 흰 면과 달리 **원본이 어두운**
    // 자리이므로 색을 그대로 뽑아 짙은 FACE_FILL 로 낸다. 흰 면 뒤에 밀어 넣어야
    // 같은 클래스 안에서 나중에 그려진다(z 는 클래스로만 갈리고 그 안은 배열 순서다).
    //
    // 라인 모드에서는 면을 만들지 않기로 했으므로 윤곽만 선으로 남긴다 — 그래야
    // "면을 표현하지 않는다"를 지키면서도 검은 판의 형상이 사라지지 않는다.
    if (ev.solidFill && area(ev.solidFill)) {
      const solids = labelComponents(ev.solidFill, W, H, 8, Math.max(opts.minRegionPx * 4, 64)).components;
      // **색으로 묶은 뒤에 추적한다.** 덩어리마다 따로 칠하면 한 무늬가 조각마다 다른
      // 색이 되어 한복판에 이음매가 생긴다(실측 t_jewelry_03: 오팔이 세로로 갈려
      // 왼쪽은 검은 파편, 오른쪽은 통짜 파랑이 됐다). 흰 면과 같은 규칙 —
      // **같은 파트 안에서 같은 색끼리만** 묶어 파트 경계를 넘지 않게 한다.
      const sgroups: { color: string; mask: Uint8Array; area: number; partId?: string; shared: string[] }[] = [];
      for (const c of solids) {
        const at = assignFace(c.pixels);
        const color = opts.sampleFill ? faceColor(c) : "#1a1a1a";
        const hit = sgroups.find((g) => g.partId === at.id && colorClose(g.color, color, opts.colorMergeDeltaE));
        if (hit) {
          for (let k = 0; k < c.pixels.length; k++) hit.mask[c.pixels[k]] = 1;
          hit.area += c.area;
          for (const id of at.shared) if (!hit.shared.includes(id)) hit.shared.push(id);
        } else {
          const m = new Uint8Array(N);
          for (let k = 0; k < c.pixels.length; k++) m[c.pixels[k]] = 1;
          sgroups.push({ color, mask: m, area: c.area, partId: at.id, shared: [...at.shared] });
        }
      }
      sgroups.sort((x, y) => y.area - x.area);
      let emitted = 0, px = 0;
      for (let si = 0; si < sgroups.length; si++) {
        const g = sgroups[si];
        const at = { id: g.partId, shared: g.shared };
        const c = { area: g.area };
        const eps = Math.min(EPS_CAP, opts.simplifyPx * ev.supersample);
        const draws = await traceMask(g.mask, W, H, path.join(opts.workDir, `solid_${si}.png`), eps);
        if (!draws.length) continue;
        const color = g.color;
        // 얇은 마감도 검게 채운 면을 윤곽선으로 낸다 — 단 로고·글씨 파트는 면 유지
        const gLabel = (opts.partNodes?.find((pn) => pn.id === g.partId)?.label ?? "").toLowerCase();
        const gGlyph = /letter|logo|engrav|inscript|text|brand|monogram|marking/.test(gLabel);
        const asOutline = opts.lineMode || (opts.thinFinish && !gGlyph);
        for (const draw of draws) {
          const { d: filled, dropped } = fillTinyHoles(draw);
          if (dropped) tinyHolesFilled += dropped;
          for (const d of splitCompound(filled)) {
            // 글리프 파트라도 조각이 **글자꼴이어야** 면으로 남는다. 선화 생성이 밴드
            // 모서리를 굵게 그리면 그 리본이 각인 파트에 배정돼 검은 초승달로 남았다
            // (실측 la_jewelry_1). 글자·로고는 평균 폭이 도톰하고, 리본은 길이 대비
            // 폭이 얇다 — 평균 폭(면적/최장변)으로 가른다.
            let pieceOutline = asOutline;
            if (!asOutline && opts.thinFinish && gGlyph) {
              const bb = bboxOfPath(d, W, H);
              const maxDim = Math.max(1, bb[2] - bb[0], bb[3] - bb[1]);
              const pieceArea = parsePath(d).reduce((acc, sp) => acc + Math.abs(subPathArea(sp)), 0);
              const meanWidth = pieceArea / maxDim;
              const glyphSized = maxDim < Math.min(W, H) * 0.12;
              const fat = meanWidth > Math.max(6, ev.lineWidthLimit) * 1.5;
              pieceOutline = !glyphSized && !fat;
            }
            if (pieceOutline) {
              primitives.push({
                id: nextId("sl"), cls: "STRUCTURAL_STROKE", d,
                color: "#000000", width: LINE_WIDTH > 0 ? LINE_WIDTH : 2,
                area: c.area, bbox: bboxOfPath(d, W, H),
                partId: at.id, shared: at.shared.length ? at.shared : undefined,
                route: {
                  chosen: "STRUCTURAL_STROKE",
                  features: { area: c.area, solid: 1 },
                  why: "검게 채운 면의 윤곽 — 라인 모드라 면 대신 선으로",
                  confidence: 0.85,
                },
              } as StrokePrimitive);
            } else {
              primitives.push({
                id: nextId("sf"), cls: "FACE_FILL", area: c.area, bbox: bboxOfPath(d, W, H), d,
                fill: color, partId: at.id, shared: at.shared.length ? at.shared : undefined,
                route: {
                  chosen: "FACE_FILL",
                  features: { area: c.area, solid: 1 },
                  why: "선 굵기보다 두꺼운 잉크 — 검게 채운 면",
                  confidence: 0.9,
                },
              } as ShapePrimitive);
            }
            emitted++;
          }
        }
        px += c.area;
      }
      if (emitted) say?.(`검게 채운 면 ${emitted}개 (${px}px) — ${opts.lineMode || opts.thinFinish ? "윤곽선으로" : "짙은 면으로"} 출고`);
    }

    if (bgFaces) say?.(`배경 면 ${bgFaces}개(${bgPx}px) 제외 — 파트 마스크가 안 덮는 뚫린 자리`);
    if (tinyHolesFilled) say?.(`면의 미세 구멍 ${tinyHolesFilled}개를 메움 (위에 덮이는 자리)`);
    facePartAt = partAt;
    say?.(`면 ${primitives.length}개 (색 묶음 ${groups.length})`);
  }

  // 단순화 허용오차는 **원본 좌표 기준**이어야 한다 — 작업 캔버스는 supersample 배로
  // 커져 있으므로 그대로 쓰면 원본 기준 0.4px 로 재는 셈이다.
  const epsWork = Math.min(EPS_CAP, opts.simplifyPx * ev.supersample);
  // 라인 모드는 스트로크 출력을 **포함한다** — 축을 갈랐어도 옛 호출부가 안 깨지게.
  const strokeLines = opts.strokeLines ?? opts.lineMode ?? false;
  void tinyHolesFilled;

  // ── 반복 패턴 · 점선 ─────────────────────────────────────
  // 성분 픽셀과 캔버스 폭을 함께 넘긴다 — 모티프가 구멍을 살리려면 필요하다
  const clusters = findPatterns(
    ev.components.map((c) => Object.assign(Object.create(Object.getPrototypeOf(c)), c, { srcWidth: W })),
    N,
  );
  const dashRuns = findDashRuns(ev.components, N);
  const inPattern = new Set<ComponentEvidence>();
  const inDash = new Set<ComponentEvidence>();
  for (const c of clusters) for (const m of c.members) inPattern.add(m);
  for (const r of dashRuns) for (const m of r.members) { if (!inPattern.has(m)) inDash.add(m); }
  say?.(`패턴 군집 ${clusters.length} (최대 ${clusters[0]?.members.length ?? 0}개) · 점선 ${dashRuns.length}`);

  // ── 성분 라우팅 ──────────────────────────────────────────
  const tol = Math.min(W, H) * opts.thresholds.primitiveToleranceRatio;
  const strokeMask = new Uint8Array(N);
  const outlineMask = new Uint8Array(N);
  const geometric: { ev: ComponentEvidence; fit: FitResult }[] = [];
  let lowConfidence = 0;

  for (const c of ev.components) {
    if (inPattern.has(c) || inDash.has(c)) continue;
    // 닫힌 성분(구멍이 있거나 끝점이 없는 것)만 원·타원 후보
    const closed = c.holes > 0 || c.endpoints === 0;
    const fit = bestFit(c.contour, { tolerance: tol, closed });
    const route = routeComponent(c, {
      width: W, height: H, lineWidthLimit: ev.lineWidthLimit,
      inPattern: false, inDash: false, fit,
    }, opts.thresholds);
    if (route.confidence < 0.6) lowConfidence++;

    if (route.chosen === "GEOMETRIC_PRIMITIVE" && fit) {
      geometric.push({ ev: c, fit });
      primitives.push({
        id: nextId("g"), cls: "GEOMETRIC_PRIMITIVE", kind: fit.kind, params: fit.params,
        // 선 성분에서 온 것은 stroke. 굵기는 그 성분의 실측 중앙값.
        paint: "stroke", stroke: "#111111", width: Math.max(1, c.widthMedian),
        d: fit.d,
        anchorsSaved: Math.max(0, Math.round(c.contour.length / 3) - fit.anchors),
        residual: { rms: fit.rms, max: fit.max },
        area: c.area, bbox: c.bbox, route,
      } as GeometricPrimitive);
    } else if (route.chosen === "STRUCTURAL_STROKE") {
      for (let k = 0; k < c.comp.pixels.length; k++) strokeMask[c.comp.pixels[k]] = 1;
    } else {
      for (let k = 0; k < c.comp.pixels.length; k++) outlineMask[c.comp.pixels[k]] = 1;
    }
  }

  // ── 잉크 주인 지도 ───────────────────────────────────────
  //
  // 추적 **전에** 잉크를 파트별로 쪼갠다. 통째로 추적한 뒤 패스 단위로 배정하면
  // 거대 성분 하나가 한 파트를 독점한다(실측: 빈 파트 22%, 한 파트 최대 93%).
  const owners = opts.parts?.length
    ? buildOwnerMap(ev.ink, opts.parts, W, H)
    : null;
  if (owners) {
    say?.(`잉크 주인 지도: 이웃 상속 ${owners.inherited}px · 무주공산 ${owners.unowned}px`);
  }
  const partOf = (pi: number) => opts.parts![pi].id;

  // ── 구조선 → centerline (파트별) ─────────────────────────
  if (area(strokeMask)) {
    const allTraced: Awaited<ReturnType<typeof centerlineTrace>> = [];
    const traceOne = async (m: Uint8Array, tag: string, partId?: string, shared?: string[]) => {
      const png = path.join(opts.workDir, `stroke_${tag}.png`);
      await writeMask(m, W, H, png);
      const traced = await centerlineTrace(png, {
        color: "#111111",
        inkThreshold: 128,
        minLength: Math.max(4, Math.round(Math.min(W, H) * 0.012)),
        maxPaths: 4000,
        // V3에서 배운 것: 기본 상한 6은 원본 해상도 기준 값이라 확대 캔버스에서 모든 선을 누른다
        maxWidth: ev.lineWidthLimit,
      });
      allTraced.push(...traced);
      for (const st of traced) {
        primitives.push({
          id: nextId("s"), cls: "STRUCTURAL_STROKE", d: st.d,
          width: st.strokeWidth ?? 2, color: st.stroke ?? "#111111",
          area: 0, bbox: bboxOfPath(st.d, W, H),
          partId, shared: shared?.length ? shared : undefined,
          route: {
            chosen: "STRUCTURAL_STROKE", features: {},
            why: partId ? `구조선 — ${partId} 몫만 중심선 추출` : "구조선 마스크 중심선 추출",
            confidence: 0.8,
          },
        } as StrokePrimitive);
      }
    };
    if (owners) {
      const sp = splitByOwner(strokeMask, owners.owner, opts.parts!.length, W, H);
      for (const [pi, m] of sp.byPart) {
        await traceOne(m, `p${pi}`, partOf(pi), neighborsOf(m, opts.parts!, pi, W, H));
      }
      if (sp.restN) await traceOne(sp.rest, "rest");
    } else {
      await traceOne(strokeMask, "all");
    }

    // **사후 검산.** 라우터가 "구조선"이라 판정해도 centerline 이 그 잉크를 다 설명한다는
    // 보장은 없다 — 굵기가 국소적으로 변하거나 끝이 뭉툭하면 남는다. 남은 것을 그대로 두면
    // 그만큼 도면에서 사라진다(실측: 검산 없이 shoe_2 선 F@2px 0.995 → 0.944).
    // 실제로 그려 보고 안 덮인 잉크만 outline 으로 보탠다. residual 을 ink ∧ ¬dilate(cover,1)
    // 로 정의하므로 stroke 와 겹치지 않는다 — 같은 선을 두 번 그리지 않는다.
    const cover = await rasterizeStrokes(allTraced, W, H);
    const grown = dilate(cover, W, H, 1);
    const residual = new Uint8Array(N);
    let residN = 0;
    for (let i = 0; i < N; i++) if (strokeMask[i] && !grown[i]) { residual[i] = 1; residN++; }
    if (residN > N * 0.00002) {
      // 남은 잉크도 주인별로 쪼개 보탠다 — 여기서 통째로 넣으면 분할이 새어 나간다
      const rs = owners
        ? splitByOwner(residual, owners.owner, opts.parts!.length, W, H)
        : { byPart: new Map<number, Uint8Array>([[-1, residual]]), rest: new Uint8Array(N), restN: 0 };
      const chunks: { m: Uint8Array; pid?: string }[] = [];
      for (const [pi, m] of rs.byPart) chunks.push({ m, pid: pi >= 0 ? partOf(pi) : undefined });
      if (rs.restN) chunks.push({ m: rs.rest });
      for (let ci = 0; ci < chunks.length; ci++) {
        const d2 = await traceMask(chunks[ci].m, W, H, path.join(opts.workDir, `stroke_residual_${ci}.png`), epsWork);
      for (const d of d2) {
        primitives.push({
          id: nextId("or"), cls: "OUTLINE_SHAPE", d, fill: "#111111",
          area: 0, bbox: bboxOfPath(d, W, H),
          partId: chunks[ci].pid,
          route: {
            chosen: "OUTLINE_SHAPE",
            features: { residualPx: residN },
            why: "구조선 stroke 가 덮지 못한 잉크 — 사후 검산으로 보탠 윤곽",
            confidence: 0.7,
          },
        } as ShapePrimitive);
        }
      }
      say?.(`구조선 검산 — 남은 잉크 ${(residN / Math.max(1, area(strokeMask)) * 100).toFixed(1)}% 를 outline 으로 보탬`);
    }
  }

  // ── 제품에서 떨어져 나온 잉크는 소품이다 ─────────────────
  //
  // 도면은 사진에 있는 것을 다 그린다 — 신발 안의 슈트리, 끈 끝의 열쇠고리, 바닥에
  // 놓인 선, 뒤에 보이는 상자. 테크팩에는 **제품만** 들어가야 하고, 실무 심사에서
  // 네 명이 같은 말을 했다("제품의 기본 구조가 아니며 공장에 혼란만 가중시킨다").
  //
  // **판정은 거리로 한다.** 어느 파트 마스크에도 안 걸리고, 그 어떤 파트에서도 멀리
  // 떨어져 있으면 제품이 아니다. 스트랩·체인처럼 마스크 밖으로 뻗어 나가는 부품은
  // 제품에 **닿아** 있으므로 살아남는다 — 크기로 가르면 그것들이 먼저 죽는다.
  if (opts.parts?.length && area(outlineMask)) {
    const near = new Uint8Array(N);
    for (const p of opts.parts) for (let i = 0; i < N; i++) if (p.mask[i]) near[i] = 1;
    const reach = Math.max(6, Math.round(Math.min(W, H) * (Number(process.env.V4_PROP_REACH ?? 0.03))));
    const grown = dilate(near, W, H, reach);
    let props = 0, propPx = 0;
    for (const c of labelComponents(outlineMask, W, H, 8, 1).components) {
      let touch = 0;
      for (let k = 0; k < c.pixels.length; k++) if (grown[c.pixels[k]]) { touch++; if (touch > 2) break; }
      if (touch > 2) continue;
      for (let k = 0; k < c.pixels.length; k++) outlineMask[c.pixels[k]] = 0;
      props++; propPx += c.area;
    }
    if (props) say?.(`제품 밖 소품 ${props}개(${propPx}px) 제외 — 어느 파트에서도 ${reach}px 넘게 떨어짐`);
  }

  // ── 나머지 → outline (파트별) ────────────────────────────
  if (area(outlineMask)) {
    // **글자는 인식해서 면으로.** 기하 추측은 세 번 실패했다(균일 굵기 볼드체는 안
    // 걸리고, 걸리게 조이면 몸통 선이 같이 걸린다). "글자인가"는 의미 질문이므로
    // 비전 모델에게 도면을 보여 주고 각인·로고 상자를 받는다. 상자 안의 잉크 성분
    // 중 3분의 2 이상이 상자에 들어간 것만 글리프로 본다 — 스쳐 가는 선은 제외.
    let letterMask: Uint8Array | null = null;
    if ((opts.lineMode || opts.thinFinish) && opts.schematicPath) {
      try {
        // **캐시는 잡 폴더 밖.** workDir 에 두면 잡 이름이 바뀔 때마다 비전 모델을 다시
        // 불러 다른 상자를 받는다 — 같은 도면에서 글리프 픽셀이 44,603 → 45,626 으로
        // 튀었고, 그 탓에 앵커가 455 → 518 이 됐다.
        const boxes = await findLetterRegions(opts.schematicPath, path.join(".cache", "letters"), say);
        if (boxes.length) {
          const invAll = new Uint8Array(N);
          for (let i = 0; i < N; i++) invAll[i] = ev.ink[i] ? 0 : 1;
          const dAll = distanceTransform({ data: invAll, width: W, height: H });
          const lm = letterMaskFromBoxes(boxes, ev.ink, W, H, dAll);
          let n = 0;
          for (let i = 0; i < N; i++) n += lm[i];
          if (n) { letterMask = lm; say?.(`각인 글리프 ${n}px — 면으로 유지`); }
        }
      } catch (e) {
        say?.(`각인 인식 실패(무시): ${(e as Error).message.slice(0, 70)}`);
      }
    }

    /**
     * **질감이 촘촘한 마스크는 중심선으로 가지 않는다.**
     *
     * 코바늘·니트의 그물은 선화가 아니라 질감이다. 셀 하나마다 골격 체인이 생겨
     * 수만 개가 되고, 추적이 사실상 멈춘다(실측 t_bag_05: 2시간 반 뒤에도 안 끝남).
     * 결과도 쓸모가 없다 — 디자이너가 원하는 것은 그물의 실 한 올마다 스트로크가
     * 아니라 "여기가 짜임"이라는 표현이다. 그런 마스크는 윤곽 추적으로 보낸다.
     */
    const tooDenseForCenterline = (m: Uint8Array): { dense: boolean; holes: number } => {
      // **성분 수로는 못 가른다** — 그물은 연결된 한 덩이라 성분이 두엇뿐이다.
      // 가르는 것은 **구멍 수**다(실측: 코바늘 가방 2,299~2,721개 · 보통 제품 84~187개).
      const cap = Number(process.env.V4_CENTERLINE_MAX_HOLES ?? 800);
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let i = 0; i < N; i++) {
        if (!m[i]) continue;
        const x = i % W, y = (i / W) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (x1 < 0) return { dense: false, holes: 0 };
      // bbox 테두리에서 배경을 채운다 — 못 닿은 배경이 구멍이다
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const g = new Uint8Array(bw * bh);   // 0 배경 · 1 잉크 · 2 바깥에서 닿음
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) if (m[(y0 + y) * W + (x0 + x)]) g[y * bw + x] = 1;
      }
      const st: number[] = [];
      for (let x = 0; x < bw; x++) { st.push(x, (bh - 1) * bw + x); }
      for (let y = 0; y < bh; y++) { st.push(y * bw, y * bw + bw - 1); }
      while (st.length) {
        const i = st.pop()!;
        if (g[i] !== 0) continue;
        g[i] = 2;
        const x = i % bw, y = (i / bw) | 0;
        if (x > 0) st.push(i - 1);
        if (x < bw - 1) st.push(i + 1);
        if (y > 0) st.push(i - bw);
        if (y < bh - 1) st.push(i + bw);
      }
      const inner = new Uint8Array(bw * bh);
      for (let i = 0; i < g.length; i++) if (g[i] === 0) inner[i] = 1;
      const holes = labelComponents(inner, bw, bh, 4, 6).components.length;
      return { dense: holes > cap, holes };
    };

    /**
     * 중심선 획은 **바로 출고하지 않고 모은다.**
     *
     * 획을 파트별로 나눠 추적하므로 부품이 바뀌는 자리에서 반드시 끊긴다 — 남은
     * "이어붙일 수 있는 끊김 17%"의 대부분이 이것이었다. 파트 안 병합만 하고 출고하면
     * 그 끊김은 영영 못 잇는다. 전부 모은 뒤 **파트 경계를 넘어 한 번 더 병합**하고,
     * 이은 획의 레이어는 긴 쪽 부품이 대표한다(경계를 걸쳤다는 사실은 shared 로 남긴다).
     */
    const pendingStrokes: import("./lineMerge.js").OpenStroke[] = [];
    let roundPromotedAll = 0;
    let periodicFolded = 0, periodicSaved = 0;

    const outlineOne = async (m: Uint8Array, tag: string, partId?: string, shared?: string[]) => {
      let useStroke = strokeLines;
      if (useStroke) {
        const d = tooDenseForCenterline(m);
        if (d.dense) {
          useStroke = false;
          say?.(`${tag}: 구멍 ${d.holes}개 — 그물 같은 질감이라 중심선 대신 윤곽으로`);
        }
      }
      if (useStroke) {
        // **선과 글리프를 가른다.** 각인 글자·로고는 굵은 채움 도형이라 골격화하면
        // 가지 많은 뼈대만 남아 산산이 깨진다(실측 jewelry_1: "ANTISM" 각인이 고리
        // 조각 무더기로). 성분마다 굵기 안정성·분기 밀도·세장비를 재서, 균일한 가는
        // 선만 중심선으로 가고 글리프는 라인 모드에서도 면(외곽 채움)으로 남긴다.
        // **글리프 여부는 기하 추측이 아니라 파트 의미로 가른다.** 굵기 기반 추측은
        // 세 번 실패했다 — 균일 굵기 볼드체는 안 걸리고, 걸리게 조이면 굵은 몸통 선이
        // 같이 걸린다(실측 jewelry_2 F@3 0.991→0.967 회귀). GPT 파트 계획이 이미
        // "Engraved side lettering" 처럼 의미를 알고 있다 — 각인·로고 파트는 통째로
        // 면(윤곽 채움), 나머지는 순수 중심선.
        const partLabel = (opts.partNodes?.find((pn) => pn.id === partId)?.label ?? "").toLowerCase();
        const isGlyphPart = /letter|logo|engrav|inscript|text|brand|monogram|marking/.test(partLabel);
        const glyphM = new Uint8Array(N);
        const strokeSrc = new Uint8Array(N);
        for (let i = 0; i < N; i++) {
          if (!m[i]) continue;
          if (isGlyphPart || letterMask?.[i]) glyphM[i] = 1;
          else strokeSrc[i] = 1;
        }
        let glyphPx = 0;
        for (let i = 0; i < N; i++) glyphPx += glyphM[i];
        // **글자꼴이 아닌 글리프 성분은 중심선으로 돌려보낸다.** 비전 글자 상자는
        // 직사각형이라 글자 밑을 지나는 밴드 모서리도 담는다 — 선화 생성이 그 모서리를
        // 굵게 그리면 letterMask 두께 문턱을 넘어 글리프가 되고, 검은 초승달 면으로
        // 출고됐다(실측 la_jewelry_1: 184×708px). 글자는 작고 도톰하다 — 길고 가는
        // 리본은 글자가 아니다.
        if (opts.thinFinish && glyphPx) {
          const comps = labelComponents(glyphM, W, H, 8, 16).components;
          let sentBack = 0;
          for (const comp of comps) {
            let x0 = W, y0 = H, x1 = -1, y1 = -1;
            for (const px of comp.pixels) {
              const x = px % W, y = (px / W) | 0;
              if (x < x0) x0 = x; if (x > x1) x1 = x;
              if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
            const maxDim = Math.max(1, x1 - x0, y1 - y0);
            const glyphSized = maxDim < Math.min(W, H) * 0.12;
            const fat = comp.area / maxDim > Math.max(6, ev.lineWidthLimit) * 1.5;
            if (glyphSized || fat) continue;
            for (const px of comp.pixels) { glyphM[px] = 0; strokeSrc[px] = 1; }
            glyphPx -= comp.area;
            sentBack++;
          }
          if (sentBack) say?.(`${tag}: 글자꼴 아닌 글리프 성분 ${sentBack}개 — 중심선으로`);
        }
        if (glyphPx) {
          // 글리프는 면 경로 그대로 — 글자의 형태는 윤곽이 곧 내용이다
          for (const draw of await traceMask(glyphM, W, H, path.join(opts.workDir, `glyph_${tag}.png`), epsWork)) {
            for (const d of splitCompound(draw)) {
              primitives.push({
                id: nextId("gl"), cls: "OUTLINE_SHAPE", d, fill: "#111111",
                area: 0,
                bbox: bboxOfPath(d, W, H),
                partId, shared: shared?.length ? shared : undefined,
                route: {
                  chosen: "OUTLINE_SHAPE", features: { glyph: true },
                  why: "글리프(각인·로고) — 라인 모드에서도 면으로 유지 (골격화하면 깨진다)",
                  confidence: 0.85,
                },
              } as ShapePrimitive);
            }
          }
        }
        const m2 = strokeSrc;
        {
          let sn = 0;
          for (let i = 0; i < N; i++) sn += m2[i];
          if (!sn) return; // 전부 글리프였다 — 중심선 없음
        }
        // 중심선 스트로크 — 마스크를 임시 PNG 로 내려 centerlineTrace(골격→체인→체인별
        // 굵기 실측)를 태운다. 체인 하나 = 패스 하나, 앵커는 중심선 위에 한 줄.
        const tmp = path.join(opts.workDir, `line_${tag}.png`);
        await writeMask(m2, W, H, tmp);
        const paths = await centerlineTrace(tmp, {
          color: "#111111",
          inkThreshold: 128,
          maxWidth: Math.max(8, ev.lineWidthLimit * 2),
          minLength: 6,
          maxPaths: 100000,
        });
        // 파트 안에서 먼저 병합해 두고(값싸다), 출고는 전역 병합 뒤로 미룬다
        const mergedStrokes = mergeOpenStrokes(
          paths.filter((ir) => ir.d).map((ir) => ({
            d: ir.d, width: Math.max(1, ir.strokeWidth), partId, shared,
          })),
        );
        pendingStrokes.push(...mergedStrokes);
        return;
      }
      for (const draw of await traceMask(m, W, H, path.join(opts.workDir, `outline_${tag}.png`), epsWork)) {
      // 그물·니트 윤곽은 셀마다 서브패스가 생겨 한 패스에 수백 개가 된다 —
      // Illustrator 에서 통째로만 선택되므로 덩이(바깥+그 구멍) 단위로 쪼갠다.
      for (const d of splitCompound(draw)) {
        primitives.push({
          id: nextId("o"), cls: "OUTLINE_SHAPE", d, fill: "#111111",
          area: 0, bbox: bboxOfPath(d, W, H),
          partId, shared: shared?.length ? shared : undefined,
          route: {
            chosen: "OUTLINE_SHAPE", features: {},
            why: partId ? `윤곽 — ${partId} 몫만 추적 (파트 경계에서 분할)` : "윤곽 추적 (주인 없는 잉크)",
            confidence: 0.85,
          },
        } as ShapePrimitive);
      }
      }
    };
    if (owners) {
      const sp = splitByOwner(outlineMask, owners.owner, opts.parts!.length, W, H);
      for (const [pi, m] of sp.byPart) {
        await outlineOne(m, `p${pi}`, partOf(pi), neighborsOf(m, opts.parts!, pi, W, H));
      }
      if (sp.restN) await outlineOne(sp.rest, "rest");
    } else {
      await outlineOne(outlineMask, "all");
    }

    // ── 전역 병합 → 승격 → 출고 ─────────────────────────────
    if (strokeLines && pendingStrokes.length) {
      const before = pendingStrokes.length;
      const globallyMerged = mergeOpenStrokes(pendingStrokes);
      const crossJoined = before - globallyMerged.length;
      if (crossJoined > 0) say?.(`파트 경계를 넘어 획 ${crossJoined}쌍 병합 (${before} → ${globallyMerged.length})`);

      // **대시 캐리어.** 일렬 짧은 획(스티치 점선)을 캐리어 패스 + 점선 속성으로.
      // 앵커 절감이자 표현 교정이다 — 실무 규범이 이쪽이다.
      const dashConsumed = new Set<number>();
      {
        const chains = buildDashChains(globallyMerged);
        for (const ch of chains) {
          for (const mi of ch.members) dashConsumed.add(mi);
          primitives.push({
            id: nextId("dc"), cls: "DASH_OR_STITCH", d: ch.d,
            color: "#111111", width: LINE_WIDTH > 0 ? LINE_WIDTH : ch.width,
            dashArray: ch.dashArray,
            area: 0, bbox: bboxOfPath(ch.d, W, H),
            partId: ch.partId,
            route: {
              chosen: "DASH_OR_STITCH",
              features: { dashCarrier: 1, members: ch.members.length },
              why: `대시 ${ch.members.length}개를 캐리어 하나 + 점선 속성으로 (앵커 ${ch.anchorsBefore} → ${ch.carrierAnchors})`,
              confidence: 0.85,
            },
          } as StrokePrimitive);
        }
        if (chains.length) {
          const saved = chains.reduce((a, c) => a + c.anchorsBefore - c.carrierAnchors, 0);
          say?.(`대시 캐리어 ${chains.length}줄 — 대시 ${dashConsumed.size}개를 접음 (앵커 ${saved}개 절감)`);
        }
      }

      // **닮은 작은 획 묶기.** 구슬·스티치 조각은 서로 떨어진 닮은 획 수백 개다
      // (실측: 앵커 1,772 가 획 337개에 분산 — 획당 5개). 형상을 정규화해 군집으로
      // 묶고, 군집마다 모티프 하나 + 배치 목록으로 접는다. 안 닮은 멤버는 그냥 남긴다.
      const consumed = new Set<number>();
      {
        const clusters = clusterStrokes(
          globallyMerged.map((x, i) => (dashConsumed.has(i) ? { ...x, d: "" } : x)),
        );
        for (const cl of clusters) {
          for (const mi of cl.members) consumed.add(mi);
          primitives.push({
            id: nextId("sc"), cls: "REPEATING_PATTERN", paint: "stroke",
            motif: cl.motif, motifSize: cl.motifSize,
            instances: cl.instances,
            fill: "#111111", strokeWidth: LINE_WIDTH > 0 ? LINE_WIDTH : cl.strokeWidth,
            pathsSaved: cl.members.length - 1,
            area: 0,
            // 인스턴스 위치의 실제 범위 — 캔버스 전체 bbox 는 옛 정규식 버그의 지문이라
            // 감사 도구가 결함으로 잡는다. 반경은 모티프 크기로 잡는다.
            bbox: (() => {
              const r = Math.max(cl.motifSize[0], cl.motifSize[1]);
              let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
              for (const inst of cl.instances) {
                x0 = Math.min(x0, inst.x - r); y0 = Math.min(y0, inst.y - r);
                x1 = Math.max(x1, inst.x + r); y1 = Math.max(y1, inst.y + r);
              }
              return [Math.max(0, x0), Math.max(0, y0), Math.min(W, x1), Math.min(H, y1)] as [number, number, number, number];
            })(),
            partId: cl.instances[0]?.partId,
            route: {
              chosen: "REPEATING_PATTERN",
              features: { strokeCluster: 1, members: cl.members.length },
              why: `닮은 획 ${cl.members.length}개를 모티프 하나로 (앵커 ${cl.anchorsBefore} → ${cl.motifAnchors})`,
              confidence: 0.8,
            },
          } as PatternPrimitive);
        }
        if (clusters.length) {
          const saved = clusters.reduce((a, c) => a + c.anchorsBefore - c.motifAnchors, 0);
          say?.(`닮은 획 군집 ${clusters.length}개 — 획 ${consumed.size}개를 접음 (앵커 ${saved}개 절감)`);
        }
      }

      for (let gi = 0; gi < globallyMerged.length; gi++) {
        if (dashConsumed.has(gi) || consumed.has(gi)) continue;
        const ir = globallyMerged[gi];
        let d = THIN_TOL > 0 ? thinAnchors(ir.d, THIN_TOL) : ir.d;
        // **선 굵기보다 가까운 앵커는 겹쳐 보인다.** 간격 하한을 굵기에 걸고, 코너는
        // 이탈 검증이 지킨다(실측 s_jewelry_1: 앵커의 26% 가 굵기 미만 간격이었다).
        d = enforceAnchorSpacing(d, Math.max(5, ir.width * 1.2), Math.max(1.2, THIN_TOL * 1.5));
        // **직선 구간은 앵커 양끝 둘이면 충분하다.** 추적 흔들림이 남긴 중간 앵커를
        // "이 구간이 직선인가"로 다시 물어 현 하나로 편다 (V4_STRAIGHT_TOL, 0 이면 끔).
        if (opts.thinFinish) {
          const st = Number(process.env.V4_STRAIGHT_TOL ?? Math.max(1.6, THIN_TOL * 2));
          if (st > 0) d = mergeStraightRuns(d, st);
        }
        const partId = ir.partId;
        const shared = ir.shared;

        // **작고 둥근 획은 원으로.** 구슬 테두리·리벳·아일릿은 중심선으로 뜨면
        // 알마다 작은 닫힌 고리가 되어 앵커를 8~12개씩 먹는다. 판정은 bestFit 이
        // 한다 — 잔차가 크면 저절로 거부된다.
        const closedRound = (() => {
          const subs = parsePath(d);
          if (subs.length !== 1 || !subs[0].closed) return null;
          const pts = flattenForFit(d);
          if (pts.length < 6) return null;
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const pp of pts as unknown as { x: number; y: number }[]) {
            if (pp.x < x0) x0 = pp.x; if (pp.x > x1) x1 = pp.x;
            if (pp.y < y0) y0 = pp.y; if (pp.y > y1) y1 = pp.y;
          }
          const w = x1 - x0, h = y1 - y0;
          if (Math.max(w, h) > Math.min(W, H) * 0.12) return null;
          if (Math.max(w, h) / Math.max(1, Math.min(w, h)) > 2.2) return null;
          return bestFit(pts, { tolerance: Math.max(1.2, Math.min(w, h) * 0.12), closed: true });
        })();
        if (closedRound) {
          roundPromotedAll++;
          primitives.push({
            id: nextId("gr"), cls: "GEOMETRIC_PRIMITIVE", kind: closedRound.kind,
            params: closedRound.params, paint: "stroke",
            stroke: "#111111", width: LINE_WIDTH > 0 ? LINE_WIDTH : ir.width,
            d: closedRound.d,
            anchorsSaved: Math.max(0, (d.match(/[MLC]/g) ?? []).length - closedRound.anchors),
            residual: { rms: closedRound.rms, max: closedRound.max },
            area: 0, bbox: bboxOfPath(closedRound.d, W, H),
            partId, shared: shared?.length ? shared : undefined,
            route: {
              chosen: "GEOMETRIC_PRIMITIVE",
              features: { closedStroke: 1, fitMax: closedRound.max },
              why: `작고 둥근 닫힌 획이 ${closedRound.kind} 에 적합 (잔차 max ${closedRound.max}px)`,
              confidence: 0.85,
            },
          } as GeometricPrimitive);
          continue;
        }

        // **주기 테두리는 모티프 하나로 접는다.** 물결·구슬 테두리는 한 획인데 같은
        // 굽이가 수십 번 반복된다 — 자기상관으로 주기를 찾고, 마디마다 실측 어긋남이
        // 허용 안일 때만 바꾼다. 한 마디라도 넘으면 원본 유지.
        const strokeW = LINE_WIDTH > 0 ? LINE_WIDTH : ir.width;
        const periodic = compressPeriodic(d, Math.max(1.5, strokeW * 0.6));
        if (periodic) {
          periodicFolded++;
          periodicSaved += periodic.anchorsBefore - periodic.motifAnchors;
          primitives.push({
            id: nextId("pp"), cls: "REPEATING_PATTERN", paint: "stroke",
            motif: periodic.motif, motifSize: periodic.motifSize,
            instances: periodic.instances.map((i) => ({ ...i, partId })),
            fill: "#111111", strokeWidth: strokeW,
            pathsSaved: 0,
            area: 0, bbox: bboxOfPath(d, W, H),
            partId, shared: shared?.length ? shared : undefined,
            route: {
              chosen: "REPEATING_PATTERN",
              features: { periodic: 1, period: periodic.period, reps: periodic.instances.length, dev: periodic.deviation },
              why: `주기 ${periodic.period.toFixed(0)}px 굽이 ${periodic.instances.length}회 반복 (어긋남 max ${periodic.deviation.toFixed(1)}px)`,
              confidence: 0.85,
            },
          } as PatternPrimitive);
          continue;
        }

        primitives.push({
          id: nextId("cl"), cls: "STRUCTURAL_STROKE", d,
          width: strokeW, color: "#111111",
          area: 0,
          bbox: bboxOfPath(d, W, H),
          partId, shared: shared?.length ? shared : undefined,
          route: {
            chosen: "STRUCTURAL_STROKE", features: { lineMode: true },
            why: partId ? `중심선 — ${partId} 몫 (라인 모드)` : "중심선 (주인 없는 잉크)",
            confidence: 0.85,
          },
        } as StrokePrimitive);
      }
      if (roundPromotedAll) say?.(`작고 둥근 획 ${roundPromotedAll}개를 원·타원으로 승격`);
      if (periodicFolded) say?.(`주기 테두리 ${periodicFolded}개를 모티프로 접음 (앵커 ${periodicSaved}개 절감)`);
    }
  }

  // ── 패턴 ────────────────────────────────────────────────
  for (const c of clusters) {
    primitives.push({
      id: nextId("p"), cls: "REPEATING_PATTERN",
      motif: refitMotif(c.motif, c.motifSize), motifSize: c.motifSize, instances: c.instances,
      fill: "#111111", pathsSaved: c.pathsSaved,
      area: c.members.reduce((a, m) => a + m.area, 0),
      bbox: [
        Math.min(...c.members.map((m) => m.bbox[0])), Math.min(...c.members.map((m) => m.bbox[1])),
        Math.max(...c.members.map((m) => m.bbox[2])), Math.max(...c.members.map((m) => m.bbox[3])),
      ],
      route: {
        chosen: "REPEATING_PATTERN",
        features: { members: c.members.length, deviationMean: c.shapeDeviation.mean, deviationMax: c.shapeDeviation.max },
        why: `모티프 1개 + 인스턴스 ${c.instances.length}개 (형상 편차 평균 ${c.shapeDeviation.mean})`,
        confidence: Math.max(0.5, 1 - c.shapeDeviation.mean * 3),
      },
    } as PatternPrimitive);
  }

  // ── 점선 ────────────────────────────────────────────────
  for (const r of dashRuns) {
    const f = (v: number) => Math.round(v * 10) / 10;
    const d = r.path.map((p, i) => `${i ? "L" : "M"} ${f(p.x)} ${f(p.y)}`).join(" ");
    primitives.push({
      id: nextId("d"), cls: "DASH_OR_STITCH", d,
      width: Math.max(1, r.width), color: "#111111",
      dashArray: `${f(r.dash)} ${f(r.gap)}`,
      area: r.members.reduce((a, m) => a + m.area, 0),
      bbox: [
        Math.min(...r.members.map((m) => m.bbox[0])), Math.min(...r.members.map((m) => m.bbox[1])),
        Math.max(...r.members.map((m) => m.bbox[2])), Math.max(...r.members.map((m) => m.bbox[3])),
      ],
      route: {
        chosen: "DASH_OR_STITCH",
        features: { members: r.members.length, straightness: r.straightness, dash: r.dash, gap: r.gap },
        why: `${r.members.length}개가 일정 간격 — carrier 1개 + dasharray`,
        confidence: Math.max(0.5, 1 - r.straightness * 8),
      },
    } as StrokePrimitive);
  }

  // ── 파트 배분 ────────────────────────────────────────────
  const sharedBoundaries: SharedBoundary[] = [];
  if (opts.parts?.length) {
    for (const p of primitives) {
      // 면과 면-프리미티브는 위에서 **면적 겹침**으로 이미 배정했다. 곡선 표본으로 다시
      // 배정하면 면에 맞지 않는 기준으로 덮어쓰게 된다.
      if (p.cls === "FACE_FILL" || (p.cls === "GEOMETRIC_PRIMITIVE" && (p as GeometricPrimitive).paint === "fill")) {
        if (p.shared?.length) sharedBoundaries.push({ primitiveId: p.id, between: [p.partId!, ...p.shared].filter(Boolean) });
        continue;
      }
      // **분할된 기하는 이미 주인이 있다.** 곡선 표본 다수결로 덮어쓰면 그 분할이
      // 무효가 된다 — 파트 경계에서 자른 조각을 다시 통째로 한 파트에 몰아넣는 셈이다.
      if (p.partId) {
        if (p.shared?.length) sharedBoundaries.push({ primitiveId: p.id, between: [p.partId, ...p.shared] });
        continue;
      }
      const d = (p as { d?: string }).d;
      if (!d) continue;
      const a = assignByCurve(d, opts.parts, W, H);
      p.partId = a.partId;
      if (a.shared.length) {
        p.shared = a.shared;
        sharedBoundaries.push({ primitiveId: p.id, between: [a.partId!, ...a.shared].filter(Boolean) });
      }
    }
    // 패턴은 인스턴스 중심으로 배분한다
    // 패턴은 **인스턴스마다** 파트가 다르다. 하나의 메시·체인이 여러 파트 경계를 넘나들면
    // 군집 전체를 한 파트에 몰아넣을 수 없다 — 그러면 그 파트를 껐을 때 남의 메시까지 사라진다.
    for (const p of primitives) {
      if (p.cls !== "REPEATING_PATTERN") continue;
      const pat = p as PatternPrimitive;
      const tally = new Map<string, number>();
      for (const inst of pat.instances) {
        const x = Math.round(inst.x + (pat.motifSize[0] * inst.scale) / 2);
        const y = Math.round(inst.y + (pat.motifSize[1] * inst.scale) / 2);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const pi = facePartAt ? facePartAt[y * W + x] : -1;
        if (pi >= 0) {
          inst.partId = opts.parts[pi].id;
          tally.set(inst.partId, (tally.get(inst.partId) ?? 0) + 1);
        }
      }
      let best = "", bestN = 0;
      for (const [id, n] of tally) if (n > bestN) { bestN = n; best = id; }
      if (best) p.partId = best;
      const spread = [...tally.keys()].filter((id) => id !== best && (tally.get(id) ?? 0) >= pat.instances.length * 0.1);
      if (spread.length) {
        p.shared = spread;
        sharedBoundaries.push({ primitiveId: p.id, between: [best, ...spread] });
      }
    }
  }

  const scene: VectorScene = {
    canvas: {
      width: W, height: H,
      sourceWidth: ev.sourceWidth, sourceHeight: ev.sourceHeight,
      supersample: ev.supersample,
    },
    parts: opts.partNodes ?? [],
    primitives,
    sharedBoundaries,
    correspondence: { method: "global-similarity", aspectRatio: 1, confident: true, note: "" },
    provenance: {
      pipeline: "v4.semantic-topology",
      schematic: { backend: "", prompt: "", seed: null },
      createdAt: new Date().toISOString(),
      lowConfidence,
    },
  };

  // ── 연속성 불변식 — 진한 선은 끊긴 채 나가지 않는다 ──────
  {
    const res = await rescueContinuity({
      primitives, W, H,
      inkStrict: ev.inkStrict,
      exclude: [ev.gemFlatten?.removedMask],
      texture: ev.textureKept ? undefined : ev.texture,
      parts: opts.parts,
      nextId,
    });
    if (res.runs) {
      primitives.push(...res.added);
      say?.(`연속성 재주입 — 끊긴 진한 선 ${res.runs}구간(골격 ${res.px}px)을 스트로크로 복원`);
    }
  }

  // ── 선 굵기 등급화 ───────────────────────────────────────
  //
  // **등급은 전부 모은 뒤에 정한다.** 파트마다 따로 정하면 같은 뜻의 선이 파트에 따라
  // 다른 값이 되어, 위계가 파일 전체에서 깨진다.
  {
    const GRADES = opts.widthGrades ?? Number(process.env.V4_WIDTH_GRADES ?? 0);
    if (GRADES > 0 && LINE_WIDTH <= 0) {
      const strokes = primitives.filter(
        (p) => p.cls === "STRUCTURAL_STROKE" || p.cls === "DASH_OR_STITCH",
      ) as StrokePrimitive[];
      if (strokes.length >= GRADES) {
        // 길이로 가중 — 짧은 토막 수백 개가 긴 외곽선 하나를 밀어내면 안 된다
        const lenOf = (d: string) => {
          const n = (d.match(/[MLC]/g) ?? []).length;
          return Math.max(1, n);
        };
        const grades = widthGrades(
          strokes.map((p) => ({ width: p.width, weight: lenOf(p.d) })), GRADES,
        );
        if (grades.length > 1) {
          for (const p of strokes) p.width = snapGrade(p.width, grades);
          // **얇은 마감** — 위계(순서)는 지키고 값만 가는 사다리로. 도면 실측 굵기
          // (5~35px)를 그대로 쓰면 앵커 점이 선 두께에 파묻혀 겹쳐 보인다.
          if (opts.thinFinish) {
            const LADDER = [1.2, 2, 3.2, 4.5, 6];
            const map = new Map(grades.map((g, i) => [g, LADDER[Math.min(i, LADDER.length - 1)]]));
            for (const p of strokes) { p.qaWidth = p.width; p.width = map.get(p.width) ?? p.width; }
            say?.(`얇은 마감 — 굵기 사다리 ${grades.map((g) => map.get(g)).join(" · ")}px`);
          } else {
            say?.(`선 굵기 ${grades.length}등급으로 통일 — ${grades.map((g) => g.toFixed(2)).join(" · ")}px`);
          }
        }
      }
    }
    // **사다리 탈출 잡기.** 등급화는 STRUCTURAL_STROKE·DASH 만 본다 — 기하 프리미티브의
    // stroke 폭과 등급 표본 미달 스트로크는 그대로 남아 굵은 선으로 출고됐다
    // (실측 th_shoe_1: 5.66px·10px 6개). 얇은 마감에서는 전부 상한 안으로 누른다.
    if (opts.thinFinish) {
      const CAP = 3.2;
      let caught = 0;
      for (const p of primitives) {
        const sp = p as { width?: number; qaWidth?: number; paint?: string; strokeWidth?: number };
        if (typeof sp.width === "number" && sp.qaWidth == null && sp.width > CAP) {
          sp.qaWidth = sp.width; sp.width = CAP; caught++;
        }
        if (p.cls === "REPEATING_PATTERN" && typeof sp.strokeWidth === "number" && sp.strokeWidth > CAP) {
          sp.qaWidth = sp.strokeWidth; sp.strokeWidth = CAP; caught++;
        }
      }
      if (caught) say?.(`얇은 마감 — 사다리 밖 굵기 ${caught}개를 ${CAP}px 이하로`);
    }
  }

  // ── 열린 끝점 잇기 ──────────────────────────────────────
  //
  // 얇은 선화는 끊김이 그대로 "안 닫힌 도형"으로 보인다. 실측 열린 끝점의 28~32%
  // 가 바로 옆에 짝이 있었다 — 굵기 등급화가 끝난 뒤(굵기 게이트가 무의미해진 뒤)
  // joinable 의 자로 닫고 잇는다.
  if (opts.thinFinish) {
    bridgeGaps(primitives, say);
  }

  // ── 퇴화 조각 정리 ───────────────────────────────────────
  //
  // **마지막에 한 곳에서 한다.** 길이 0 짜리 조각은 추적기·재피팅·병합 어디서든 생기고,
  // 만드는 자리마다 막으려 들면 빠뜨린다. 화면에는 안 보이지만 Illustrator 에서는
  // 겹친 앵커로 잡혀 디자이너가 손으로 지워야 한다(실측: 파일당 2~11개).
  {
    let dropped = 0;
    for (const p of primitives) {
      const d = (p as { d?: string }).d;
      if (!d) continue;
      const { d: clean, removed } = dropDegenerate(d);
      if (!removed) continue;
      // 통째로 사라질 패스는 손대지 않는다 — 없애는 것이 목적이 아니다
      if (!clean || !/[Cc Ll]/.test(clean)) continue;
      (p as { d: string }).d = clean;
      dropped += removed;
    }
    if (dropped) say?.(`길이 0 조각 ${dropped}개 제거`);
  }

  void samplePath;
  void geometric;
  return { scene, evidence: ev };
}
