/**
 * V3 오케스트레이터 — VRINGON 플랫스케치 기반 레이어드 SVG.
 *
 *   S1 정규화 · 객체 격리 · 크롭
 *   S2 GPT 구성품 분해 (partPlan)
 *   S3 파트별 가시 마스크
 *   S4 파트별 입력 이미지 생성 (그 파트만 남긴 흰 배경 이미지)
 *   S5 파트별 VRINGON 플랫스케치 생성 → 깨끗한 라인 드로잉
 *   S6 라인 기준 벡터화 (선=stroke, 선이 감싼 면=fill)
 *   S7 z-order대로 레이어 어셈블 → layered.svg
 *   S8 재합성 QA
 *
 * V1/V2와의 차이는 S5·S6이다. 사진의 색면을 클러스터링하지 않고, 도면의 라인을
 * 기준으로 벡터를 만든다. 라인은 파트 경계와 정확히 일치하므로 형상이 깨지지 않는다.
 */
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import sharp from "sharp";
import { isolateProduct, cropToSubject } from "../pipeline/prepare.js";
import { planParts, type PartPlan, type ProductPart } from "./partPlan.js";
import { generateSchematic, activeBackend, normalizeCategory, type SchematicResult } from "./schematicClient.js";
import { vectorizeByLines, type LineVectorResult, type VecPath } from "./lineVector.js";
import { buildVisibleMasks } from "../v2/masks.js";
import { alignToBox, fgBBox } from "../pipeline/layers.js";
import { area, backgroundMask, boundary, dilate, edgeF1, iou, loadRaster } from "../v2/raster.js";
import type { LayerManifest, ManifestLayer } from "../v2/schema.js";

export type V3State =
  | "PREPROCESSING" | "PLANNING" | "SEGMENTING" | "SKETCHING"
  | "VECTORIZING" | "ASSEMBLING" | "VALIDATING" | "SUCCEEDED" | "NEEDS_REVIEW" | "FAILED";

export interface V3Options {
  categoryHint?: string;
  minParts: number;
  maxParts: number;
  /** 파트별로 도면을 만들 것인가(part), 전체를 한 번 만들고 파트로 자를 것인가(whole) */
  schematicScope: "part" | "whole";
  /** 모노톤 도식(true) / 컬러 플랫(false) */
  grayscale: boolean;
  /** 작업 캔버스 긴 변 */
  workLong: number;
  /** 잉크 임계 */
  inkThreshold: number;
  /** 이미 만든 도면을 재사용한다 (백엔드 없이 벡터화·어셈블만 검증) */
  schematicFrom?: string;
  /** 업스케일 단계 (워커의 공통 단계, 실패는 무시) */
  upscale?: boolean;
}

export const DEFAULT_V3_OPTIONS: V3Options = {
  minParts: 3,
  maxParts: 10,
  schematicScope: "part",
  grayscale: true,
  workLong: 1400,
  inkThreshold: 190,
};

export interface V3Result {
  state: V3State;
  plan: PartPlan;
  layers: {
    partId: string;
    label: string;
    z: number;
    regions: number;
    strokes: number;
    nodes: number;
    schematic?: { backend: string; prompt: string; seed: number | null; cached: boolean; ms: number };
    note?: string;
  }[];
  qa: {
    pass: boolean;
    silhouetteIou: number;
    boundaryF: number;
    partCoverage: number;
    invalidPaths: number;
    totalPaths: number;
    totalNodes: number;
    fileKb: number;
    notes: string[];
  };
  artifacts: Record<string, string>;
  timings: Record<string, number>;
}

export async function runV3(
  inputPath: string,
  jobDir: string,
  opts: V3Options = DEFAULT_V3_OPTIONS,
  onProgress?: (s: V3State, m: string) => void,
): Promise<V3Result> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (k: string, t: number) => (timings[k] = Date.now() - t);
  const say = (s: V3State, m: string) => onProgress?.(s, m);

  await fs.mkdir(jobDir, { recursive: true });
  const partsDir = path.join(jobDir, "parts");
  const sketchDir = path.join(jobDir, "schematics");
  const masksDir = path.join(jobDir, "masks");
  const workDir = path.join(jobDir, "work");
  for (const d of [partsDir, sketchDir, masksDir, workDir]) await fs.mkdir(d, { recursive: true });

  // ── S1 정규화 · 격리 · 크롭 ───────────────────────────────
  let ts = Date.now();
  say("PREPROCESSING", "정규화 · 객체 격리 · 크롭");
  const normalized = path.join(jobDir, "normalized.png");
  await sharp(inputPath).rotate().flatten({ background: "#ffffff" }).png().toFile(normalized);

  const isolated = path.join(jobDir, "isolated.png");
  let isoNote = "";
  try {
    const noun = guessNoun(opts.categoryHint);
    const r = await isolateProduct(normalized, isolated, noun.noun, noun.category);
    isoNote = r.note ?? "";
  } catch (e) {
    await fs.copyFile(normalized, isolated);
    isoNote = `격리 생략 (${(e as Error).message.slice(0, 50)})`;
  }
  const cropped = path.join(jobDir, "cropped.png");
  const crop = await cropToSubject(isolated, cropped);

  const cm = await sharp(cropped).metadata();
  const scale = Math.min(1, opts.workLong / Math.max(cm.width!, cm.height!));
  const W = Math.max(64, Math.round(cm.width! * scale));
  const H = Math.max(64, Math.round(cm.height! * scale));
  const canonical = path.join(jobDir, "canonical_input.png");
  await sharp(cropped).flatten({ background: "#ffffff" }).resize(W, H, { fit: "fill" }).png().toFile(canonical);
  const original = await loadRaster(canonical);
  mark("S1_preprocess", ts);
  say("PREPROCESSING", `${W}×${H} ${[isoNote, crop.note].filter(Boolean).join(" / ")}`);

  // ── S2 구성품 분해 ────────────────────────────────────────
  ts = Date.now();
  say("PLANNING", "GPT 구성품 분해");
  const planPath = path.join(jobDir, "part_plan.json");
  let plan: PartPlan;
  try {
    plan = JSON.parse(await fs.readFile(planPath, "utf8"));
    const sha = crypto.createHash("sha256").update(await fs.readFile(canonical)).digest("hex");
    if (plan.provenance?.inputSha256 !== sha) throw new Error("입력이 바뀜");
    say("PLANNING", `구성품 캐시 사용 (${plan.parts.length}개)`);
  } catch {
    plan = await planParts(canonical, { categoryHint: opts.categoryHint, minParts: opts.minParts, maxParts: opts.maxParts },
      (m) => say("PLANNING", m));
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
  }
  mark("S2_plan", ts);

  // ── S3 파트별 가시 마스크 ─────────────────────────────────
  ts = Date.now();
  say("SEGMENTING", "파트별 가시 마스크");
  const manifest = toManifest(plan);
  const vm = await buildVisibleMasks(canonical, manifest, masksDir, (m) => say("SEGMENTING", m));
  mark("S3_masks", ts);
  say("SEGMENTING", `마스크 ${vm.masks.size}개 · 커버리지 ${(vm.coverage * 100).toFixed(1)}%`);

  // 생성 모델은 제품을 원본과 다른 크기·위치로 그린다. 정합하지 않으면 파트 마스크와
  // 도면이 어긋나 실루엣이 통째로 밀린다(실측: 사진 전경 59.7% vs 도면 38.9%, IoU 0.65).
  // V1에서 쓰던 alignToBox로 도면의 잉크 bbox를 원본 전경 bbox에 맞춘다.
  const origBox = await fgBBox(canonical);

  // ── S4~S6 파트별: 이미지 → 도면 → 라인 벡터 ────────────────
  const backend = activeBackend();
  const ordered = [...plan.parts].sort((a, b) => a.z - b.z);

  // whole 모드: 전체를 한 번 도면화하고 파트 마스크로 잘라 쓴다
  let wholeSketch: SchematicResult | null = null;
  if (opts.schematicScope === "whole" && !opts.schematicFrom) {
    ts = Date.now();
    say("SKETCHING", "전체 도면 1회 생성");
    wholeSketch = await generateSchematic(canonical, sketchDir,
      { category: normalizeCategory(plan.category), grayscale: opts.grayscale, upscale: opts.upscale }, (m) => say("SKETCHING", m));
    mark("S5_schematic_whole", ts);
  }

  const layers: V3Result["layers"] = [];
  const vectors = new Map<string, LineVectorResult>();
  const alignedSketches: string[] = [];
  let sketchMs = 0, vecMs = 0;

  const partMasks = ordered
    .map((p) => ({ id: p.id, mask: vm.masks.get(p.id) }))
    .filter((x): x is { id: string; mask: Uint8Array } => !!x.mask && area(x.mask) > 0);

  const singleSketch = opts.schematicFrom || wholeSketch;
  if (singleSketch) {
    // ── 도면 1장 경로 ────────────────────────────────────────
    // 파트마다 clip해서 따로 벡터화하면 clip 경계가 외곽선을 잘라 면이 새어나간다
    // (실측: 가방 파트 커버리지 83.8%). 한 번 벡터화하고 파트에 배분한다.
    const st = Date.now();
    let raw = opts.schematicFrom
      ? await resolveExistingSketch(opts.schematicFrom, "_whole", canonical, W, H, sketchDir)
      : wholeSketch!.pngPath;
    const alignedPath = path.join(workDir, "whole.aligned.png");
    await fs.writeFile(alignedPath, await alignToBox(raw, origBox, W, H));
    alignedSketches.push(alignedPath);
    sketchMs += Date.now() - st;

    const vt = Date.now();
    say("VECTORIZING", "도면 전체 라인 벡터화 후 파트 배분");
    const lv = await vectorizeByLines(alignedPath, {
      inkThreshold: opts.inkThreshold,
      workDir,
      sampleFill: !opts.grayscale,
      parts: partMasks,
    });
    vecMs += Date.now() - vt;

    for (const p of ordered) {
      const regions = lv.regions.filter((r) => r.partId === p.id);
      const strokes = lv.strokes.filter((r) => r.partId === p.id);
      vectors.set(p.id, { ...lv, regions, strokes });
      layers.push({
        partId: p.id, label: p.label, z: p.z,
        regions: regions.length, strokes: strokes.length,
        nodes: [...regions, ...strokes].reduce((n, x) => n + (x.d.match(/[LC]/g) ?? []).length, 0),
        schematic: {
          backend: opts.schematicFrom ? "reuse" : wholeSketch!.backend,
          prompt: opts.schematicFrom ? "(재사용)" : wholeSketch!.prompt,
          seed: opts.schematicFrom ? null : wholeSketch!.seed,
          cached: true, ms: 0,
        },
      });
    }
    say("VECTORIZING", `면 ${lv.regions.length} · 선 ${lv.strokes.length} · 노드 ${lv.stats.nodes}`);
  } else {
    // ── 파트별 도면 경로 (계획한 본래 흐름) ──────────────────
    for (const p of ordered) {
      const mask = vm.masks.get(p.id);
      if (!mask || !area(mask)) {
        layers.push({ partId: p.id, label: p.label, z: p.z, regions: 0, strokes: 0, nodes: 0, note: "가시 영역 없음" });
        continue;
      }
      const partPng = path.join(partsDir, `${p.id}.png`);
      await writePartImage(canonical, mask, W, H, partPng);

      if (!backend) {
        layers.push({
          partId: p.id, label: p.label, z: p.z, regions: 0, strokes: 0, nodes: 0,
          note: "schematic 백엔드 없음 — VRINGON_SCHEMATIC_URL / REPLICATE_API_TOKEN / FAL_KEY 필요",
        });
        continue;
      }

      const st = Date.now();
      say("SKETCHING", `${p.label || p.id} 도면 생성`);
      const r = await generateSchematic(partPng, sketchDir,
        { category: normalizeCategory(plan.category), grayscale: opts.grayscale, upscale: opts.upscale }, (m) => say("SKETCHING", m));
      const alignedPath = path.join(workDir, `${p.id}.aligned.png`);
      await fs.writeFile(alignedPath, await alignToBox(r.pngPath, origBox, W, H));
      alignedSketches.push(alignedPath);
      sketchMs += Date.now() - st;

      // 파트 도면은 그 파트만 그려져 있으므로 clip이 필요 없다 — 선이 잘리지 않는다
      const vt = Date.now();
      say("VECTORIZING", `${p.label || p.id} 라인 벡터화`);
      const lv = await vectorizeByLines(alignedPath, {
        inkThreshold: opts.inkThreshold, workDir, sampleFill: !opts.grayscale,
      });
      vecMs += Date.now() - vt;
      vectors.set(p.id, lv);
      layers.push({
        partId: p.id, label: p.label, z: p.z,
        regions: lv.regions.length, strokes: lv.strokes.length, nodes: lv.stats.nodes,
        schematic: { backend: r.backend, prompt: r.prompt, seed: r.seed, cached: r.cached, ms: r.ms },
      });
      say("VECTORIZING", `  ${p.id}: 면 ${lv.regions.length} · 선 ${lv.strokes.length}`);
    }
  }
  timings.S5_schematic = sketchMs;
  timings.S6_vectorize = vecMs;

  // ── S7 어셈블 ─────────────────────────────────────────────
  ts = Date.now();
  say("ASSEMBLING", "레이어 어셈블");
  const svg = assemble(plan, ordered, vectors, W, H);
  const svgPath = path.join(jobDir, "layered.svg");
  await fs.writeFile(svgPath, svg, "utf8");
  mark("S7_assemble", ts);

  // ── S8 재합성 QA ──────────────────────────────────────────
  ts = Date.now();
  say("VALIDATING", "SVG 래스터화 후 원본 대조");
  // 기준은 사진이 아니라 **정합된 도면**이다. 벡터는 도면에서 파생되므로
  // 도면과 대조해야 "벡터화가 잘 됐는가"를 재는 것이 된다. 사진과 대조하면
  // 도면화 단계의 스타일 차이까지 섞여 지표가 흐려진다(V1에서 같은 교훈).
  const qa = await validate(svg, alignedSketches, vm.foreground, vectors, W, H);
  mark("S8_qa", ts);

  await sharp(Buffer.from(svg), { density: 96 })
    .resize(Math.min(1400, W * 2), undefined)
    .flatten({ background: "#ffffff" })
    .png()
    .toFile(path.join(jobDir, "preview.png"));

  const state: V3State = qa.pass ? "SUCCEEDED" : "NEEDS_REVIEW";
  const report = {
    job: { state, canvas: { width: W, height: H }, totalMs: Date.now() - t0, createdAt: new Date().toISOString() },
    options: opts,
    plan,
    layers,
    qa,
    timings,
  };
  await fs.writeFile(path.join(jobDir, "qa_report.json"), JSON.stringify(report, null, 2), "utf8");

  say(state, state === "SUCCEEDED" ? "완료" : "완료 (검토 필요)");
  return {
    state, plan, layers, qa, timings,
    artifacts: {
      "layered.svg": "layered.svg",
      "part_plan.json": "part_plan.json",
      "qa_report.json": "qa_report.json",
      "preview.png": "preview.png",
    },
  };
}

// ── 헬퍼 ────────────────────────────────────────────────────

function guessNoun(hint?: string): { noun: string; category: string } {
  const h = (hint ?? "").toLowerCase();
  if (!h) return { noun: "object", category: "other" };
  const [a, b] = h.split(".").map((x) => x.trim()).filter(Boolean);
  const noun = b || a;
  const map: Record<string, string> = {
    shoe: "footwear", sneaker: "footwear", bag: "bag", purse: "bag",
    ring: "jewelry", earring: "jewelry", necklace: "jewelry", jewelry: "jewelry",
  };
  return { noun, category: map[noun] ?? (b ? a : "other") };
}

/** V2의 buildVisibleMasks가 소비하는 형태로 변환 */
function toManifest(plan: PartPlan): LayerManifest {
  const layers: ManifestLayer[] = plan.parts.map((p) => ({
    id: p.id,
    label: p.label,
    semantic_role: p.kind === "marking" ? "appearance" : "structural",
    parent_id: null,
    z_index: p.z,
    material: "flat_color",
    bbox_norm: p.bbox,
    visible_description: p.description,
    hidden_geometry_hint: "",
    occludes: [],
    occluded_by: p.occludedBy,
    vector_profile: "flat_color",
    expected_color_count: 4,
    confidence: p.confidence,
    requires_review: false,
  }));
  return {
    schema_version: "1.0",
    object: { category: plan.category, view: plan.view, style: "product_photo", background: "clean", confidence: 1 },
    policy: { target_mode: "line_art", strict_vector: true, max_layers: layers.length, layer_order: "back_to_front" },
    layers,
    relations: [],
  };
}

/** 파트만 남긴 흰 배경 이미지 — 도면 모델에 넣을 입력 */
async function writePartImage(
  canonical: string,
  mask: Uint8Array,
  W: number,
  H: number,
  dest: string,
): Promise<void> {
  const src = await loadRaster(canonical, W, H);
  const out = Buffer.alloc(W * H * 3, 255);
  // 경계를 조금 넓혀 파트가 잘려 보이지 않게 한다
  const m = dilate(mask, W, H, 1);
  for (let i = 0; i < W * H; i++) {
    if (!m[i]) continue;
    const p = i * src.channels;
    out[i * 3] = src.data[p];
    out[i * 3 + 1] = src.data[p + 1];
    out[i * 3 + 2] = src.data[p + 2];
  }
  await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toFile(dest);
}

/** 개발 모드: 기존 도면(라인아트) 재사용 */
async function resolveExistingSketch(
  from: string,
  partId: string,
  fallback: string,
  W: number,
  H: number,
  outDir: string,
): Promise<string> {
  const cands = [path.join(from, `${partId}.png`), from];
  for (const c of cands) {
    try {
      const st = await fs.stat(c);
      if (st.isFile()) {
        const dest = path.join(outDir, `reuse_${partId}.png`);
        await sharp(c).flatten({ background: "#ffffff" }).resize(W, H, { fit: "fill" }).png().toFile(dest);
        return dest;
      }
    } catch { /* 다음 후보 */ }
  }
  return fallback;
}

/** z-order대로 <g> 조립 — 면 먼저, 그 위에 선 */
function assemble(
  plan: PartPlan,
  ordered: ProductPart[],
  vectors: Map<string, LineVectorResult>,
  W: number,
  H: number,
): string {
  const body: string[] = [];
  for (const p of ordered) {
    const v = vectors.get(p.id);
    if (!v || (!v.regions.length && !v.strokes.length)) continue;
    const paths = [
      ...v.regions.map((r) => pathTag(r, true)),
      ...v.strokes.map((s) => pathTag(s, false)),
    ].join("\n");
    body.push(
      `    <g id="layer-${p.id}" inkscape:label="${esc(p.label || p.id)}" ` +
        `data-z="${p.z}" data-kind="${p.kind}" data-regions="${v.regions.length}" data-strokes="${v.strokes.length}">\n` +
        paths +
        `\n    </g>`,
    );
  }
  const meta = {
    pipeline: "v3.vringon-schematic",
    category: plan.category,
    parts: ordered.map((p) => ({ id: p.id, z: p.z, kind: p.kind })),
    provenance: plan.provenance,
  };
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"\n` +
    `     viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n` +
    `  <metadata id="part-plan">${esc(JSON.stringify(meta))}</metadata>\n` +
    body.join("\n") +
    `\n</svg>\n`
  );
}

function pathTag(p: VecPath, isFill: boolean): string {
  if (isFill) {
    return `      <path d="${p.d}" fill="${p.fill ?? "#ffffff"}" fill-rule="evenodd"/>`;
  }
  return (
    `      <path d="${p.d}" fill="none" stroke="${p.stroke ?? "#111111"}" ` +
    `stroke-width="${p.strokeWidth ?? 2}" stroke-linecap="round" stroke-linejoin="round"/>`
  );
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 외곽선이 감싼 영역을 전경으로 본다.
 * 캔버스 테두리에서 "밝고 잉크가 아닌" 픽셀만 타고 퍼진 뒤, 도달하지 못한 곳이 제품이다.
 */
function enclosedForeground(
  raster: { data: Buffer; channels: number },
  bg: Uint8Array,
  W: number,
  H: number,
): Uint8Array {
  const N = W * H;
  const ink = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const p = i * raster.channels;
    const lum = 0.299 * raster.data[p] + 0.587 * raster.data[p + 1] + 0.114 * raster.data[p + 2];
    ink[i] = lum < 200 ? 1 : 0;
  }
  const outside = new Uint8Array(N);
  const q = new Int32Array(N);
  let head = 0, tail = 0;
  const push = (i: number) => {
    if (outside[i] || ink[i]) return;
    outside[i] = 1;
    q[tail++] = i;
  };
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
  const fg = new Uint8Array(N);
  for (let i = 0; i < N; i++) fg[i] = outside[i] ? 0 : 1;
  void bg;
  return fg;
}

/** SVG를 다시 래스터화해 원본 실루엣과 대조 */
async function validate(
  svg: string,
  sketchPaths: string[],
  photoForeground: Uint8Array,
  vectors: Map<string, LineVectorResult>,
  W: number,
  H: number,
): Promise<V3Result["qa"]> {
  const notes: string[] = [];
  // QA용 렌더는 면을 검게 칠한다. 모노톤 도면에서는 면 fill이 흰색이라
  // 그대로 렌더하면 흰 배경과 구분되지 않아 "면을 못 그렸다"고 오판한다
  // (실측: 도면 전경 41%인데 벡터 전경 2%로 측정됨).
  const qaSvg = svg.replace(/fill="#[0-9a-fA-F]{3,6}"/g, 'fill="#000000"');
  const rendered = await sharp(Buffer.from(qaSvg), { density: 96 })
    .resize(W, H, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const raster = { data: rendered.data, channels: rendered.info.channels, width: W, height: H };
  // 라인 드로잉의 전경은 "흰색이 아닌 픽셀"이 아니다 — 내부가 흰색이므로 그렇게 재면
  // 선만 전경이 되어 실루엣 IoU가 구조적으로 낮게 나온다(실측: 0.65인데 결과물은 정확했다).
  // 바깥에서 flood fill 해서 **외곽선이 막아 준 안쪽**을 전경으로 본다.
  const bg = backgroundMask(raster, W, H, 246);
  const fg = enclosedForeground(raster, bg, W, H);

  // 기준 = 도면들의 합집합에서 뽑은 전경·경계
  let refFg: Uint8Array<ArrayBufferLike> = new Uint8Array(W * H);
  let refInk: Uint8Array<ArrayBufferLike> = new Uint8Array(W * H);
  for (const sp of sketchPaths) {
    const sk = await sharp(sp).flatten({ background: "#ffffff" }).resize(W, H, { fit: "fill" })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const r2 = { data: sk.data, channels: sk.info.channels, width: W, height: H };
    const sbg = backgroundMask(r2, W, H, 246);
    const sfg = enclosedForeground(r2, sbg, W, H);
    for (let i = 0; i < W * H; i++) {
      if (sfg[i]) refFg[i] = 1;
      const q = i * r2.channels;
      const lum = 0.299 * sk.data[q] + 0.587 * sk.data[q + 1] + 0.114 * sk.data[q + 2];
      if (lum < 200) refInk[i] = 1;
    }
  }
  if (!area(refFg)) { refFg = photoForeground.slice(); refInk = boundary(photoForeground, W, H); }

  // 벡터가 그린 잉크 — 면을 채운 QA 렌더가 아니라 **원본 SVG 렌더**에서 뽑는다.
  // 채운 렌더로 재면 면 전체가 잉크가 되어 선 일치도가 무의미해진다.
  const inkRender = await sharp(Buffer.from(svg), { density: 96 })
    .resize(W, H, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const vecInk = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const q = i * inkRender.info.channels;
    const lum = 0.299 * inkRender.data[q] + 0.587 * inkRender.data[q + 1] + 0.114 * inkRender.data[q + 2];
    if (lum < 200) vecInk[i] = 1;
  }

  const silhouetteIou = iou(fg, refFg);
  const ef = edgeF1(vecInk, refInk, W, H, 2);
  const photoIou = iou(fg, photoForeground);

  let totalPaths = 0, totalNodes = 0, invalid = 0;
  const margin = Math.max(W, H) * 0.5;
  for (const v of vectors.values()) {
    for (const p of [...v.regions, ...v.strokes]) {
      totalPaths++;
      totalNodes += (p.d.match(/[LC]/g) ?? []).length;
      const nums = (p.d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
      if (nums.some((n) => !Number.isFinite(n))) { invalid++; continue; }
      for (let i = 0; i + 1 < nums.length; i += 2) {
        if (nums[i] < -margin || nums[i] > W + margin || nums[i + 1] < -margin || nums[i + 1] > H + margin) {
          invalid++;
          break;
        }
      }
    }
  }
  const partCoverage = vectors.size
    ? [...vectors.values()].reduce((s, v) => s + v.stats.coverage, 0) / vectors.size
    : 0;

  if (silhouetteIou < 0.9) notes.push(`도면 대비 실루엣 IoU ${silhouetteIou.toFixed(3)}`);
  if (ef.f1 < 0.8) notes.push(`도면 대비 선 일치 F ${ef.f1.toFixed(3)}`);
  notes.push(`참고: 사진 실루엣 대비 IoU ${photoIou.toFixed(3)} (도면화는 재해석이므로 낮을 수 있음)`);
  if (invalid) notes.push(`유효하지 않은 패스 ${invalid}개`);
  if (partCoverage < 0.95) notes.push(`파트 내부 커버리지 ${(partCoverage * 100).toFixed(1)}% — 닫히지 않은 라인 의심`);

  return {
    pass: silhouetteIou >= 0.9 && ef.f1 >= 0.8 && invalid === 0 && partCoverage >= 0.95,
    silhouetteIou: +silhouetteIou.toFixed(4),
    boundaryF: +ef.f1.toFixed(4),
    partCoverage: +partCoverage.toFixed(4),
    invalidPaths: invalid,
    totalPaths,
    totalNodes,
    fileKb: +(Buffer.byteLength(svg) / 1024).toFixed(1),
    notes,
  };
}
