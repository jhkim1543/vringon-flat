/**
 * 라인 기준 벡터화 — V3의 핵심.
 *
 * VRINGON schematic 워커의 출력은 **흰 배경 + 명확한 검은 라인**(+ 컬러 모드면 평면 색면)이다.
 * 사진처럼 그라데이션·질감이 없으므로, 색면을 클러스터링하는 대신 **라인만 기준으로**
 * 벡터를 만들 수 있다. 이게 기존 방식(색 클러스터 → 윤곽 추적)보다 나은 이유:
 *
 *   · 색 클러스터링은 인접한 두 파트가 비슷한 색이면 하나로 뭉치고, 반대로 한 파트 안에
 *     명암이 있으면 여러 조각으로 쪼갠다. 라인은 그 문제가 없다 — 도면의 라인이 곧 파트 경계다.
 *   · 면과 선을 **같은 이진 마스크**에서 뽑으므로 경계가 정확히 맞물린다. 틈(hairline gap)도,
 *     이중선도 생기지 않는다.
 *   · 결과 구조가 일러스트레이터에서 자연스럽다: 선은 stroke, 면은 fill.
 *
 * 알고리즘
 *   1. 잉크(라인) 마스크 추출 — 흰 배경 도면이므로 밝기 임계로 충분하다.
 *   2. 라인을 장벽으로 두고 바깥에서 flood fill → 도달하지 못한 영역이
 *      **라인으로 둘러싸인 닫힌 면**이다.
 *   3. 닫힌 면을 색으로 묶고, 묶음마다 윤곽을 추적해 fill 패스로 만든다.
 *   4. 라인 자체는 중심선 추출로 stroke를 만든다.
 *   5. 면은 면적 내림차순으로 쌓고(작은 것이 위), 그 위에 선을 얹는다.
 */
import path from "node:path";
import fsp from "node:fs/promises";
import sharp from "sharp";
import { vectorize, ColorMode, Hierarchical, PathSimplifyMode } from "@neplex/vectorizer";
import { centerlineTrace } from "../vector/centerline.js";
import { optimizePathData } from "../vector/optimize.js";
import {
  area, close, components, deltaE2000Rgb, dilate, dominantColor, erode, toHex, type Raster,
} from "../v2/raster.js";

export interface LineVectorOptions {
  /** 잉크 판정 임계 (0~255). 흰 배경 도면은 170~210이 적당 */
  inkThreshold: number;
  /** 이 면적(px) 미만의 닫힌 면은 버린다 */
  minRegionPx: number;
  /** 폴리곤 단순화 허용 오차(px) */
  simplifyPx: number;
  /** 선을 stroke로도 뽑을 것인가 */
  emitStrokes: boolean;
  /** 면 색을 원본에서 샘플링할 것인가 (컬러 도면) */
  sampleFill: boolean;
  /** 선 패스 상한 */
  maxStrokes: number;
  /** 같은 면색으로 묶을 ΔE2000 한계 */
  colorMergeDeltaE: number;
  /** 중간 산출물을 둘 디렉터리. 미지정이면 입력 옆의 .lv/ */
  workDir?: string;
  /**
   * 파트별 마스크. 주면 닫힌 면을 파트에 배분해 레이어별로 나눠 돌려준다.
   *
   * clip으로 파트마다 따로 벡터화하면 **clip 경계가 외곽선을 잘라** 면이 바깥으로
   * 새어나간다(실측: 가방 파트 커버리지 83.8%, 실루엣 IoU 0.58). 도면 전체를 한 번
   * 처리하고 면을 파트에 배분하면 선이 잘리지 않는다.
   */
  parts?: { id: string; mask: Uint8Array }[];
}

export const DEFAULT_LINE_OPTIONS: LineVectorOptions = {
  inkThreshold: 190,
  minRegionPx: 24,
  simplifyPx: 0.8,
  emitStrokes: true,
  sampleFill: true,
  maxStrokes: 4000,
  colorMergeDeltaE: 12,
};

export interface VecPath {
  /** parts를 준 경우 이 패스가 속한 파트 */
  partId?: string;
  d: string;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number | null;
  /** 닫힌 면의 픽셀 면적 — z 정렬용 */
  area: number;
}

export interface LineVectorResult {
  /** 라인이 감싼 면 (면적 내림차순 = 그리는 순서) */
  regions: VecPath[];
  /** 라인 자체 */
  strokes: VecPath[];
  stats: {
    inkRatio: number;
    enclosedRatio: number;
    regionCount: number;
    regionDropped: number;
    colorGroups: number;
    strokeCount: number;
    nodes: number;
    /** 닫힌 면 중 벡터가 덮은 비율 (1에 가까워야 한다) */
    coverage: number;
  };
  /** 잉크 마스크 (QA·디버깅용) */
  ink: Uint8Array;
  width: number;
  height: number;
}

export async function vectorizeByLines(
  pngPath: string,
  opts: Partial<LineVectorOptions> = {},
  clip?: Uint8Array,
): Promise<LineVectorResult> {
  const o = { ...DEFAULT_LINE_OPTIONS, ...opts };

  const { data, info } = await sharp(pngPath)
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, N = W * H;
  const ch = info.channels;
  const src: Raster = { data, channels: ch, width: W, height: H };
  const workDir = o.workDir ?? path.join(path.dirname(pngPath), ".lv");
  await fsp.mkdir(workDir, { recursive: true });

  // ── 1) 잉크 마스크 ────────────────────────────────────────
  const gray = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const p = i * ch;
    gray[i] = Math.round(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
  }
  let ink: Uint8Array<ArrayBufferLike> = new Uint8Array(N);
  for (let i = 0; i < N; i++) ink[i] = gray[i] < o.inkThreshold ? 1 : 0;

  // 두꺼운 덩어리는 선이 아니라 면이다 — 침식으로 살아남는 심을 빼서 선만 남긴다.
  // (검정 갑피가 통째로 "선"이 되면 닫힌 면이 사라진다.
  //  실측: 검정 운동화 도면에서 잉크 45% → 닫힌 면 6%)
  {
    const lineWidthLimit = Math.max(2, Math.round(Math.min(W, H) * 0.012));
    const core = erode(ink, W, H, lineWidthLimit);
    if (area(core) > N * 0.002) {
      const solid = dilate(core, W, H, lineWidthLimit);
      const thinned = new Uint8Array(N);
      for (let i = 0; i < N; i++) thinned[i] = ink[i] && !solid[i] ? 1 : 0;
      // 얇은 선이 조금이라도 남으면 그것이 진짜 라인이다
      if (area(thinned) > N * 0.0008) ink = thinned;
    }
  }
  if (clip) for (let i = 0; i < N; i++) if (!clip[i]) ink[i] = 0;

  // 선의 끊긴 곳을 잇는다 — 1~2px 틈이 있으면 닫힌 면이 배경으로 새어 나간다
  ink = close(ink, W, H, 1);

  // ── 2) 라인을 장벽으로 flood fill → 닫힌 면 ───────────────
  const outside = new Uint8Array(N);
  {
    const q = new Int32Array(N);
    let head = 0, tail = 0;
    const push = (i: number) => {
      if (outside[i] || ink[i]) return;
      if (clip && !clip[i]) return;
      outside[i] = 1;
      q[tail++] = i;
    };
    if (clip) {
      // clip 경계에 닿은 비잉크 픽셀이 바깥이다
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (!clip[i] || ink[i]) continue;
          const edge =
            x === 0 || y === 0 || x === W - 1 || y === H - 1 ||
            !clip[i - 1] || !clip[i + 1] || !clip[i - W] || !clip[i + W];
          if (edge) push(i);
        }
      }
    } else {
      for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
      for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    }
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
    if (ink[i] || outside[i]) continue;
    if (clip && !clip[i]) continue;
    enclosed[i] = 1;
    enclosedN++;
  }

  // ── 3) 닫힌 면 → 색으로 묶기 → 윤곽 추적 ──────────────────
  //
  // 면 하나하나를 따로 추적하지 않고 같은 색끼리 묶어 한 번에 추적한다.
  // 도면의 색면은 몇 종류뿐이라 추적 횟수가 3~8회로 끝나고, 같은 색이 인접하면
  // 자연스럽게 하나의 패스가 된다.
  const comps = components(enclosed, W, H, 1);
  let dropped = 0;
  const groups: { color: string; area: number; mask: Uint8Array; partId?: string }[] = [];
  for (const c of comps) {
    if (c.area < o.minRegionPx) { dropped++; continue; }
    const color = o.sampleFill ? toHex(dominantColor(src, c.mask, false)) : "#ffffff";
    // 파트가 주어지면 겹침이 가장 큰 파트에 배분한다
    let partId: string | undefined;
    if (o.parts?.length) {
      let best = -1;
      for (const part of o.parts) {
        let ov = 0;
        for (let i = 0; i < N; i++) if (c.mask[i] && part.mask[i]) ov++;
        if (ov > best) { best = ov; partId = part.id; }
      }
      if (best <= 0) partId = o.parts[0].id;
    }
    const hit = groups.find((g) => g.partId === partId && colorClose(g.color, color, o.colorMergeDeltaE));
    if (hit) {
      for (let i = 0; i < N; i++) if (c.mask[i]) hit.mask[i] = 1;
      hit.area += c.area;
    } else {
      const m = new Uint8Array(N);
      for (let i = 0; i < N; i++) if (c.mask[i]) m[i] = 1;
      groups.push({ color, area: c.area, mask: m, partId });
    }
  }

  const regions: VecPath[] = [];
  const drawn = new Uint8Array(N);
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    // 면을 1px 넓혀 선 중심까지 닿게 한다 — 면과 선 사이 틈 방지
    const grown = dilate(g.mask, W, H, 1);
    const traced = await traceMask(grown, W, H, o.simplifyPx, workPath(pngPath, gi, workDir));
    if (!traced.length) { dropped++; continue; }
    for (const d of traced) regions.push({ partId: g.partId, d, fill: g.color, stroke: null, strokeWidth: null, area: g.area });
    for (let i = 0; i < N; i++) if (g.mask[i]) drawn[i] = 1;
  }
  // 큰 면부터 그린다 — 안쪽의 작은 면이 위에 온다
  regions.sort((a, b) => b.area - a.area);

  // ── 4) 라인 → 중심선 stroke ───────────────────────────────
  let strokes: VecPath[] = [];
  if (o.emitStrokes && area(ink)) {
    const inkPng = Buffer.alloc(N, 255);
    for (let i = 0; i < N; i++) if (ink[i]) inkPng[i] = 0;
    const tmp = workPath(pngPath, "ink", workDir);
    await sharp(inkPng, { raw: { width: W, height: H, channels: 1 } }).png().toFile(tmp);
    const traced = await centerlineTrace(tmp, {
      color: "#111111",
      inkThreshold: 128,
      minLength: 4,
      maxPaths: o.maxStrokes,
    });
    strokes = traced.map((s) => ({
      partId: o.parts?.length ? assignStroke(s.d, o.parts, W, H) : undefined,
      d: s.d,
      fill: null,
      stroke: s.stroke ?? "#111111",
      strokeWidth: s.strokeWidth ?? 2,
      area: 0,
    }));
  }

  let covered = 0;
  for (let i = 0; i < N; i++) if (enclosed[i] && drawn[i]) covered++;

  const nodes =
    regions.reduce((n, p) => n + (p.d.match(/[LC]/g) ?? []).length, 0) +
    strokes.reduce((n, p) => n + (p.d.match(/[LC]/g) ?? []).length, 0);

  return {
    regions,
    strokes,
    stats: {
      inkRatio: +(area(ink) / N).toFixed(4),
      enclosedRatio: +(enclosedN / N).toFixed(4),
      regionCount: regions.length,
      regionDropped: dropped,
      colorGroups: groups.length,
      strokeCount: strokes.length,
      nodes,
      coverage: enclosedN ? +(covered / enclosedN).toFixed(4) : 1,
    },
    ink,
    width: W,
    height: H,
  };
}

// ── 헬퍼 ────────────────────────────────────────────────────

/**
 * 선을 파트에 배분한다 — 패스 좌표를 훑어 가장 많이 겹치는 파트.
 * 선은 파트 경계에 놓이므로 표본 몇 개로 충분하다.
 */
function assignStroke(
  d: string,
  parts: { id: string; mask: Uint8Array }[],
  W: number,
  H: number,
): string | undefined {
  const nums = d.match(/-?d*.?d+(?:e[-+]?d+)?/gi);
  if (!nums || nums.length < 2) return parts[0]?.id;
  const score = new Map<string, number>();
  const step = Math.max(2, Math.floor(nums.length / 40) * 2); // 좌표쌍 단위
  for (let i = 0; i + 1 < nums.length; i += step) {
    const x = Math.round(Number(nums[i])), y = Math.round(Number(nums[i + 1]));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const idx = ny * W + nx;
        for (const p of parts) if (p.mask[idx]) score.set(p.id, (score.get(p.id) ?? 0) + 1);
      }
    }
  }
  let best: string | undefined, bestN = 0;
  for (const [id, n] of score) if (n > bestN) { bestN = n; best = id; }
  return best ?? parts[0]?.id;
}

/** 두 hex 색이 ΔE2000 기준으로 가까운가 */
function colorClose(a: string, b: string, limit: number): boolean {
  const p = (h: string) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  return deltaE2000Rgb(r1, g1, b1, r2, g2, b2) < limit;
}

/**
 * 중간 산출물 경로. 입력 파일 **옆에 두면 안 된다** — candidates/ 같은 디렉터리를
 * 오염시켜 다음 실행의 glob이 작업파일을 원본으로 집는다(실측: *.__w0.png가
 * lineart 후보로 잡혀 sharp가 열지 못했다).
 */
function workPath(src: string, tag: string | number, workDir?: string): string {
  const dir = workDir ?? path.join(path.dirname(src), ".lv");
  const base = path.basename(src, path.extname(src));
  return path.join(dir, base + "." + tag + ".png");
}

// 정규식은 RegExp 생성자로 만든다 — 셸 heredoc으로 파일을 고칠 때
// 리터럴 안의 역슬래시가 조용히 사라져 정규식이 망가진 적이 있다.
const PATH_TAG = new RegExp("<path\\b([^>]*?)/?>", "g");
const D_ATTR = new RegExp('\\bd="([^"]*)"');
const FILL_ATTR = new RegExp('\\bfill="([^"]*)"');
const TRANSLATE_ATTR = new RegExp('\\btransform="translate\\(([-0-9.]+)[,\\s]+([-0-9.]+)\\)"');
const NUMBER = new RegExp("-?\\d*\\.?\\d+(?:e[-+]?\\d+)?", "gi");

/**
 * 이진 마스크의 윤곽을 추적한다.
 *
 * 직접 짠 Moore 경계추적은 폴리곤이 8점 미만으로 나와 면이 전부 버려졌다(실측:
 * region 0개). 검증된 VTracer 이진 모드로 대체한다 — hole(cutout)도 알아서 처리한다.
 */
async function traceMask(
  mask: Uint8Array,
  W: number,
  H: number,
  simplifyPx: number,
  tmpPath: string,
): Promise<string[]> {
  if (!area(mask)) return [];
  const gray = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = mask[i] ? 0 : 255;
  const png = await sharp(gray, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  await sharp(png).toFile(tmpPath);

  const svg = await vectorize(png, {
    colorMode: ColorMode.Binary,
    hierarchical: Hierarchical.Cutout,
    mode: PathSimplifyMode.Spline,
    filterSpeckle: Math.max(1, Math.round(simplifyPx * 2)),
    colorPrecision: 6,
    layerDifference: 16,
    cornerThreshold: 60,
    lengthThreshold: 4,
    maxIterations: 10,
    spliceThreshold: 45,
    pathPrecision: 3,
  });

  const out: string[] = [];
  PATH_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_TAG.exec(svg))) {
    const attrs = m[1];
    const d = D_ATTR.exec(attrs)?.[1];
    if (!d) continue;
    const fill = (FILL_ATTR.exec(attrs)?.[1] ?? "").trim().toLowerCase();
    // 마스크는 검정으로 그렸으므로 흰 path는 배경이다
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
    if (opt.d && /[LC]/.test(opt.d)) out.push(opt.d);
  }
  return out;
}
