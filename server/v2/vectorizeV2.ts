/**
 * S11 레이어 벡터화 + S12 기하·Topology·Bézier 정리 — 개발계획서 §10, §11.
 *
 * §10.1 원칙: 파이프라인은 VTracer CLI 플래그가 아니라 **내부 VectorProfile 계약**을
 * 소비한다. 그래서 tracer 버전이 바뀌어도 manifest와 서비스 API는 유지된다.
 *
 * §11.1 도구 역할 분리에 대한 구현 메모:
 *   계획서는 Shapely(polygon)/Skia PathOps(Bézier boolean)/Clipper2를 나눠 쓴다.
 *   이 구현은 Node 런타임이므로 같은 보장을 다른 수단으로 확보한다.
 *     · same-fill union   → **래스터 단계에서** 같은 색 성분을 합친 뒤 추적한다.
 *       (곡선 boolean보다 안전하고, §11.1이 경계하는 "곡선 손실"이 원천적으로 없다)
 *     · hole/cutout       → VTracer의 cutout hierarchy + fill-rule 일관 지정
 *     · simplify/refit    → topology-preserving DP + cubic Bézier refit (deviation 재검증)
 *   polygonization 허용 오차 ε는 아래 EPSILON_PX로 명시하고 QA 리포트에 기록한다(§11.2-4).
 */
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { vectorize, ColorMode, Hierarchical, PathSimplifyMode } from "@neplex/vectorizer";
import { centerlineTrace } from "../vector/centerline.js";
import { optimizePathData } from "../vector/optimize.js";
import { parsePath, serializePath, subPathArea } from "../vector/pathdata.js";
import { VECTOR_PROFILES, type ProfileDecision } from "./profiles.js";
import { area, components, deltaE2000Rgb, dominantColor, toHex, type Raster } from "./raster.js";
import type { ManifestLayer } from "./schema.js";

/** §11.2-4 polygonization 허용 오차 — 출력 해상도 대비 0.25~0.5px */
export const EPSILON_PX = 0.35;

export interface VectorPath {
  d: string;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number | null;
  fillRule: "nonzero" | "evenodd";
  /** gradient를 쓰는 경우 defs id */
  gradientId?: string;
}

export interface LayerVector {
  layerId: string;
  paths: VectorPath[];
  profile: string;
  nodes: number;
  /** gradient 정의 (metal/gem 프로파일) */
  gradients: GradientDef[];
  /** budget 초과로 단순화를 강화했는가 */
  budgetAdjusted: boolean;
  notes: string[];
}

export interface GradientDef {
  id: string;
  type: "linear" | "radial";
  stops: { offset: number; color: string; opacity?: number }[];
  x1?: number; y1?: number; x2?: number; y2?: number;
  cx?: number; cy?: number; r?: number;
}

/**
 * 한 레이어를 벡터화한다.
 *
 * @param rgb   S10 표현 정규화를 마친 RGB (W*H*3)
 * @param alpha 연속 알파 — 반투명은 opacity로 표현
 */
export async function vectorizeLayerV2(
  layer: ManifestLayer,
  rgb: Buffer,
  alpha: Float32Array,
  mask: Uint8Array,
  W: number,
  H: number,
  decision: ProfileDecision,
  workDir: string,
  onProgress?: (m: string) => void,
): Promise<LayerVector> {
  const spec = VECTOR_PROFILES[decision.profile];
  const notes: string[] = [];
  const gradients: GradientDef[] = [];
  await fs.mkdir(workDir, { recursive: true });

  // ── vector_ready 래스터 작성 (S10 산출물) ────────────────
  //
  // 마스크 밖을 **흰색으로 채우면 안 된다**. 색 트레이서는 색으로 클러스터를
  // 만들기 때문에, 근백색 제품(폴리시드 은·아이보리 가방)의 몸통이 흰 배경과
  // 같은 클러스터로 병합돼 배경으로 함께 지워진다
  // (실측: 은반지 ring_band가 path 4개로 붕괴, 실루엣 IoU 0.32).
  //
  // 그래서 이 레이어의 색들과 가장 먼 sentinel 색을 골라 채운다. 형상 경계는
  // 마스크가 정의하고, 추적 후 sentinel 클러스터만 정확히 골라 버린다.
  const sentinel = pickSentinel(rgb, mask, W, H);
  const ready = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const p3 = i * 3;
    if (mask[i]) {
      ready[p3] = rgb[p3];
      ready[p3 + 1] = rgb[p3 + 1];
      ready[p3 + 2] = rgb[p3 + 2];
    } else {
      ready[p3] = sentinel[0];
      ready[p3 + 1] = sentinel[1];
      ready[p3 + 2] = sentinel[2];
    }
  }
  const readyPath = path.join(workDir, `${layer.id}.vector_ready.png`);
  await sharp(ready, { raw: { width: W, height: H, channels: 3 } }).png().toFile(readyPath);

  // ── line_mono: 중심선 추출 (§10.2) ───────────────────────
  // 중심선은 밝기 임계로 잉크를 찾으므로 배경은 흰색이어야 한다
  if (spec.centerline) {
    const white = Buffer.alloc(W * H * 3, 255);
    for (let i = 0; i < W * H; i++) {
      if (!mask[i]) continue;
      white[i * 3] = rgb[i * 3]; white[i * 3 + 1] = rgb[i * 3 + 1]; white[i * 3 + 2] = rgb[i * 3 + 2];
    }
    await sharp(white, { raw: { width: W, height: H, channels: 3 } }).png().toFile(readyPath);
    const col = toHex(dominantColor({ data: rgb, channels: 3, width: W, height: H } as Raster, mask));
    const strokes = await centerlineTrace(readyPath, {
      color: col,
      inkThreshold: 170,
      minLength: 4,
      maxPaths: spec.budgets.max_paths,
    });
    const paths: VectorPath[] = strokes.map((s) => ({
      d: s.d,
      fill: null,
      stroke: s.stroke ?? col,
      strokeWidth: s.strokeWidth ?? 2,
      fillRule: "nonzero",
    }));
    return {
      layerId: layer.id,
      paths,
      profile: spec.name,
      nodes: countNodes(paths),
      gradients,
      budgetAdjusted: false,
      notes,
    };
  }

  // ── same-fill union: 색이 같은 성분을 래스터에서 미리 합친다 ──
  // §11.2-6의 unary_union 역할. 곡선 boolean을 피하면서 같은 목적을 달성한다.
  // (VTracer는 색 클러스터마다 path를 만들므로, 색을 먼저 정리하면 path가 준다)

  // ── VTracer 추적 ─────────────────────────────────────────
  // §10.4/§11.3: silhouette과 파트 경계는 simplification 보호 영역이다.
  // 예시 6의 파라미터는 1024px 캔버스 기준이므로 작은 캔버스에 그대로 쓰면
  // speckle·simplify가 실루엣을 갉아먹는다(실측: 618×580 반지에서 boundary F 0.81).
  // 캔버스 크기에 비례해 축소한다.
  const canvasScale = Math.max(0.35, Math.min(1, Math.min(W, H) / 1024));
  let simplify = spec.tracer.simplify_px * canvasScale;
  let speckle = Math.max(1, Math.round(spec.tracer.filter_speckle_px * canvasScale * canvasScale));
  let budgetAdjusted = false;
  let paths: VectorPath[] = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    const svg = await vectorize(await fs.readFile(readyPath), {
      colorMode: spec.tracer.clustering === "binary" ? ColorMode.Binary : ColorMode.Color,
      hierarchical: spec.tracer.hierarchy === "cutout" ? Hierarchical.Cutout : Hierarchical.Stacked,
      mode: spec.tracer.curve_mode === "spline" ? PathSimplifyMode.Spline : PathSimplifyMode.Polygon,
      filterSpeckle: speckle,
      colorPrecision: spec.tracer.color_precision,
      layerDifference: 16,
      cornerThreshold: spec.tracer.corner_threshold,
      lengthThreshold: spec.tracer.length_threshold,
      maxIterations: 10,
      spliceThreshold: spec.tracer.splice_threshold,
      pathPrecision: spec.tracer.path_precision,
    });
    paths = extractPaths(svg);

    // 마스크 밖 배경 path만 제거한다.
    // "흰색이면 배경"으로 걸렀더니 **흰 제품의 몸통이 통째로 사라졌다**
    // (실측: 폴리시드 은반지 body 대표색 #f6f6f6 → 삭제 → 실루엣 IoU 0.32).
    // 배경은 캔버스를 거의 다 덮는 흰 path 하나뿐이므로 그것만 지운다.
    paths = paths.filter((p) => !isSentinel(p.fill, sentinel));

    // ── S12 기하 정리 ──────────────────────────────────────
    paths = cleanupGeometry(paths, spec, W, H, notes, canvasScale);

    const nodes = countNodes(paths);
    if (paths.length <= spec.budgets.max_paths && nodes <= spec.budgets.max_nodes) break;

    // §10.4 budget 초과 → simplify tolerance를 올린다
    budgetAdjusted = true;
    simplify *= 1.8;
    speckle = Math.round(speckle * 1.6) + 1;
    notes.push(
      `budget 초과 (paths ${paths.length}/${spec.budgets.max_paths}, nodes ${nodes}/${spec.budgets.max_nodes}) → simplify ${simplify.toFixed(1)}px`,
    );
    onProgress?.(`  ${layer.id}: ${notes[notes.length - 1]}`);
  }

  // ── gradient 근사 (metal/gem 프로파일) ───────────────────
  if (spec.gradient && paths.length) {
    const g = fitGradient(layer.id, rgb, mask, W, H);
    if (g) {
      gradients.push(g);
      // 가장 큰 path에 gradient를 입힌다 (base fill 역할)
      let biggest = 0, bi = 0;
      paths.forEach((p, i) => {
        const a = Math.abs(parsePath(p.d).reduce((s, sp) => s + subPathArea(sp), 0));
        if (a > biggest) { biggest = a; bi = i; }
      });
      paths[bi] = { ...paths[bi], fill: null, gradientId: g.id };
      notes.push(`gradient 근사 적용 (${g.type}, stop ${g.stops.length}개)`);
    }
  }

  // ── 반투명: 연속 알파 평균을 opacity로 (§9.1 translucent) ──
  if (decision.profile === "mask_only") {
    let sum = 0, n = 0;
    for (let i = 0; i < W * H; i++) if (mask[i]) { sum += alpha[i]; n++; }
    const op = n ? sum / n : 1;
    if (op < 0.97) notes.push(`translucent opacity ${op.toFixed(2)}`);
  }

  return {
    layerId: layer.id,
    paths,
    profile: spec.name,
    nodes: countNodes(paths),
    gradients,
    budgetAdjusted,
    notes,
  };
}

// ── S12 기하 정리 (§11.2 순서) ──────────────────────────────

function cleanupGeometry(
  paths: VectorPath[],
  spec: (typeof VECTOR_PROFILES)[keyof typeof VECTOR_PROFILES],
  W: number,
  H: number,
  notes: string[],
  canvasScale = 1,
): VectorPath[] {
  const minArea = spec.cleanup.min_component_area_ratio * W * H;
  // ε도 캔버스에 비례 — 작은 캔버스에서 0.35px는 상대적으로 큰 이동이다
  const eps = EPSILON_PX * canvasScale;
  const out: VectorPath[] = [];
  let dropped = 0, holesKept = 0;

  for (const p of paths) {
    // 5) 면적 임계 이하 component 제거 · 8) needle/sliver 제거
    const subs = parsePath(p.d);
    const keep = subs.filter((sp) => {
      const a = Math.abs(subPathArea(sp));
      if (a >= minArea) return true;
      // hole은 더 관대하게 (preserve_holes_over_px2)
      if (subPathArea(sp) < 0 && a >= spec.cleanup.preserve_holes_over_px2) { holesKept++; return true; }
      dropped++;
      return false;
    });
    if (!keep.length) continue;

    // 7) topology-preserving simplify + 9) Bézier refit
    // optimizePathData가 DP 단순화와 퇴화 세그먼트 제거를 함께 한다.
    // ε 이하로만 움직인다 — §11.2-4
    const { d } = optimizePathData(serializePath(keep), { minArea, epsilon: eps });
    if (!d || !/[LC]/.test(d)) continue;

    out.push({
      ...p,
      d,
      // 6) hole orientation과 fill-rule 일치 — cutout hierarchy는 evenodd로 일관 지정
      fillRule: "evenodd",
    });
  }
  if (dropped) notes.push(`미세 조각 ${dropped}개 제거 (< ${minArea.toFixed(1)}px²)`);
  if (holesKept) notes.push(`hole ${holesKept}개 보존`);
  return out;
}

/** metal/gem: 마스크 안 밝기 분포에서 선형 gradient를 근사 */
function fitGradient(
  layerId: string,
  rgb: Buffer,
  mask: Uint8Array,
  W: number,
  H: number,
): GradientDef | null {
  // 주 방향: 밝기의 1차 모멘트 축
  let n = 0, sx = 0, sy = 0;
  for (let i = 0; i < W * H; i++) if (mask[i]) { sx += i % W; sy += (i / W) | 0; n++; }
  if (n < 200) return null;
  const cx = sx / n, cy = sy / n;

  // 밝기와 좌표의 상관으로 gradient 방향 추정
  let sxx = 0, syy = 0, sxl = 0, syl = 0, sl = 0;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    const x = (i % W) - cx, y = ((i / W) | 0) - cy;
    const l = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
    sxx += x * x; syy += y * y; sxl += x * l; syl += y * l; sl += l;
  }
  const bx = sxx > 0 ? sxl / sxx : 0;
  const by = syy > 0 ? syl / syy : 0;
  const mag = Math.hypot(bx, by);
  if (mag < 0.02) return null; // 방향성이 없으면 gradient가 아니다

  const ux = bx / mag, uy = by / mag;
  // 축 방향으로 5개 구간의 평균색을 stop으로
  const K = 5;
  const buckets = Array.from({ length: K }, () => ({ r: 0, g: 0, b: 0, n: 0 }));
  let tmin = Infinity, tmax = -Infinity;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    const t = ((i % W) - cx) * ux + (((i / W) | 0) - cy) * uy;
    if (t < tmin) tmin = t;
    if (t > tmax) tmax = t;
  }
  if (tmax - tmin < 4) return null;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    const t = ((i % W) - cx) * ux + (((i / W) | 0) - cy) * uy;
    const k = Math.min(K - 1, Math.max(0, Math.floor(((t - tmin) / (tmax - tmin)) * K)));
    buckets[k].r += rgb[i * 3]; buckets[k].g += rgb[i * 3 + 1]; buckets[k].b += rgb[i * 3 + 2]; buckets[k].n++;
  }
  const stops = buckets
    .map((b, k) => ({
      offset: k / (K - 1),
      color: b.n ? toHex([Math.round(b.r / b.n), Math.round(b.g / b.n), Math.round(b.b / b.n)]) : null,
    }))
    .filter((s): s is { offset: number; color: string } => !!s.color);
  if (stops.length < 2) return null;

  return {
    id: `grad-${layerId}`,
    type: "linear",
    stops,
    x1: +(cx + ux * tmin).toFixed(1), y1: +(cy + uy * tmin).toFixed(1),
    x2: +(cx + ux * tmax).toFixed(1), y2: +(cy + uy * tmax).toFixed(1),
  };
}

// ── 헬퍼 ────────────────────────────────────────────────────

/**
 * VTracer SVG에서 path 추출.
 * VTracer는 각 path를 transform="translate(tx,ty)"로 배치하고 d는 원점 기준으로 쓴다.
 * §11.2-1 "모든 transform을 path 좌표로 bake" — 여기서 흡수한다.
 */
function extractPaths(svg: string): VectorPath[] {
  const out: VectorPath[] = [];
  const re = /<path\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const attrs = m[1];
    const d = /\bd="([^"]*)"/.exec(attrs)?.[1];
    if (!d) continue;
    const fill = /\bfill="([^"]*)"/.exec(attrs)?.[1] ?? null;
    const tr = /\btransform="translate\(([-\d.]+)[,\s]+([-\d.]+)\)"/.exec(attrs);
    let dd = d;
    if (tr) {
      const tx = parseFloat(tr[1]), ty = parseFloat(tr[2]);
      dd = translatePath(d, tx, ty);
    }
    out.push({ d: dd, fill: fill === "none" ? null : fill, stroke: null, strokeWidth: null, fillRule: "evenodd" });
  }
  return out;
}

function translatePath(d: string, tx: number, ty: number): string {
  // 절대 좌표만 다룬다 (VTracer 출력은 절대)
  let i = 0;
  return d.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (num) => {
    const v = parseFloat(num) + (i++ % 2 === 0 ? tx : ty);
    return String(Math.round(v * 100) / 100);
  });
}

function isNearWhite(hex: string | null): boolean {
  if (!hex || !hex.startsWith("#") || hex.length < 7) return false;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return r > 246 && g > 246 && b > 246;
}

/**
 * 이 레이어의 색들과 가장 먼 sentinel 색을 고른다.
 * 후보 중 레이어 색 표본과의 최소 ΔE2000이 가장 큰 것.
 */
function pickSentinel(rgb: Buffer, mask: Uint8Array, W: number, H: number): [number, number, number] {
  const CANDIDATES: [number, number, number][] = [
    [255, 0, 255], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 0], [0, 0, 0], [255, 255, 255],
  ];
  const samples: [number, number, number][] = [];
  const step = Math.max(1, Math.floor((W * H) / 4000));
  let seen = 0;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    if (seen++ % step) continue;
    samples.push([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]);
  }
  if (!samples.length) return [255, 0, 255];
  let best = CANDIDATES[0], bestMin = -1;
  for (const c of CANDIDATES) {
    let mn = Infinity;
    for (const s of samples) mn = Math.min(mn, deltaE2000Rgb(c[0], c[1], c[2], s[0], s[1], s[2]));
    if (mn > bestMin) { bestMin = mn; best = c; }
  }
  return best;
}

/** sentinel 클러스터 판정 — 추적 과정에서 약간 섞일 수 있어 ΔE 여유를 둔다 */
function isSentinel(hex: string | null, sentinel: [number, number, number]): boolean {
  if (!hex || !hex.startsWith("#") || hex.length < 7) return false;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return deltaE2000Rgb(r, g, b, sentinel[0], sentinel[1], sentinel[2]) < 14;
}

/** path의 subpath들을 폴리라인으로 평탄화 (곡선은 제어점 샘플링으로 근사) */
function flattenPath(d: string): [number, number][][] {
  const polys: [number, number][][] = [];
  for (const sp of parsePath(d)) {
    const pts: [number, number][] = [sp.start];
    let cur = sp.start;
    for (const seg of sp.segs) {
      if (seg.type === "L" || !seg.c1 || !seg.c2) {
        pts.push(seg.end);
      } else {
        // cubic을 4등분 샘플
        const c1 = seg.c1, c2 = seg.c2;
        for (let t = 0.25; t <= 1.0001; t += 0.25) {
          const mt = 1 - t;
          const x = mt * mt * mt * cur[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t * t * t * seg.end[0];
          const y = mt * mt * mt * cur[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t * t * t * seg.end[1];
          pts.push([x, y]);
        }
      }
      cur = seg.end;
    }
    if (pts.length > 2) polys.push(pts);
  }
  return polys;
}

/** even-odd 광선 투사 — 여러 subpath(구멍 포함)를 함께 판정 */
function pointInPolygons(polys: [number, number][][], x: number, y: number): boolean {
  let crossings = 0;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) crossings++;
    }
  }
  return crossings % 2 === 1;
}

export function countNodes(paths: VectorPath[]): number {
  return paths.reduce((n, p) => n + (p.d.match(/[LCQMZ]/gi) ?? []).length, 0);
}

export { area, components };
