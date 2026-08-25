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
import { centerlineTrace } from "../vector/centerline.js";
import { optimizePathData } from "../vector/optimize.js";
import { assignByCurve, samplePath } from "../v3/pathSample.js";
import { labelComponents } from "../v3/label.js";
import { area, deltaE2000Rgb, dilate, toHex } from "../v2/raster.js";
import { extractEvidence, traceContour, type EvidenceField, type ComponentEvidence } from "./evidence.js";
import { bestFit, type FitResult } from "./primitives.js";
import { findPatterns, findDashRuns } from "./pattern.js";
import { buildOwnerMap, splitByOwner, neighborsOf, fillTinyHoles } from "./inkOwner.js";
import { splitCompound } from "./compound.js";

/**
 * 단순화 허용오차의 상한(작업 캔버스 px). 원본 좌표 기준으로 환산한 값이 이보다 커지지
 * 않게 막는다. 실측으로 정한다 — 올리면 앵커가 줄고 형상이 흐려진다.
 */
const EPS_CAP = Number(process.env.V4_EPS_CAP ?? 1.6);
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
    if (opt.d && new RegExp("[LCQS]").test(opt.d)) out.push(opt.d);
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
    const assignFace = (pixels: Int32Array): { id?: string; shared: string[] } => {
      if (!opts.parts?.length || !partAt) return { shared: [] };
      const tally = new Int32Array(opts.parts.length);
      for (let k = 0; k < pixels.length; k++) {
        const q2 = partAt[pixels[k]];
        if (q2 >= 0) tally[q2]++;
      }
      let best = -1, bestN = 0, second = 0;
      for (let q2 = 0; q2 < tally.length; q2++) {
        if (tally[q2] > bestN) { second = bestN; bestN = tally[q2]; best = q2; }
        else if (tally[q2] > second) second = tally[q2];
      }
      if (best < 0) return { id: opts.parts[0].id, shared: [] };
      const shared: string[] = [];
      if (bestN && second >= bestN * 0.75) {
        for (let q2 = 0; q2 < tally.length; q2++) {
          if (q2 !== best && tally[q2] >= bestN * 0.75) shared.push(opts.parts[q2].id);
        }
      }
      return { id: opts.parts[best].id, shared };
    };

    const faceColor = (c: { pixels: Int32Array; area: number }): string => {
      let color = opts.sampleFill ? dominantOf(colorData, colorCh, c.pixels) : "#ffffff";
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
          motif: cl.motif, motifSize: cl.motifSize, instances,
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
          id: nextId("f"), cls: "FACE_FILL", area: g.area, bbox: [0, 0, W, H], d, fill: g.color,
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
    if (tinyHolesFilled) say?.(`면의 미세 구멍 ${tinyHolesFilled}개를 메움 (위에 덮이는 자리)`);
    facePartAt = partAt;
    say?.(`면 ${primitives.length}개 (색 묶음 ${groups.length})`);
  }

  // 단순화 허용오차는 **원본 좌표 기준**이어야 한다 — 작업 캔버스는 supersample 배로
  // 커져 있으므로 그대로 쓰면 원본 기준 0.4px 로 재는 셈이다.
  const epsWork = Math.min(EPS_CAP, opts.simplifyPx * ev.supersample);
  void tinyHolesFilled;

  // ── 반복 패턴 · 점선 ─────────────────────────────────────
  const clusters = findPatterns(ev.components, N);
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
          area: 0, bbox: [0, 0, W, H],
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
          area: 0, bbox: [0, 0, W, H],
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

  // ── 나머지 → outline (파트별) ────────────────────────────
  if (area(outlineMask)) {
    const outlineOne = async (m: Uint8Array, tag: string, partId?: string, shared?: string[]) => {
      for (const draw of await traceMask(m, W, H, path.join(opts.workDir, `outline_${tag}.png`), epsWork)) {
      // 그물·니트 윤곽은 셀마다 서브패스가 생겨 한 패스에 수백 개가 된다 —
      // Illustrator 에서 통째로만 선택되므로 덩이(바깥+그 구멍) 단위로 쪼갠다.
      for (const d of splitCompound(draw)) {
        primitives.push({
          id: nextId("o"), cls: "OUTLINE_SHAPE", d, fill: "#111111",
          area: 0, bbox: [0, 0, W, H],
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
  }

  // ── 패턴 ────────────────────────────────────────────────
  for (const c of clusters) {
    primitives.push({
      id: nextId("p"), cls: "REPEATING_PATTERN",
      motif: c.motif, motifSize: c.motifSize, instances: c.instances,
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

  void samplePath;
  void geometric;
  return { scene, evidence: ev };
}
