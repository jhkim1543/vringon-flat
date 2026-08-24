/**
 * V4 오케스트레이터 — Semantic Topology Vectorizer.
 *
 *   S1  정규화 · 격리 · 크롭                (V3와 동일)
 *   S2  GPT 구성품 분해                      (V3와 동일)
 *   S3  파트별 가시 마스크                   (V3와 동일)
 *   S4  VRINGON 도면 생성 · 등방 대응        (V3와 동일 — 도면을 왜곡하지 않는다)
 *   S5  증거 추출 (성분별 폭·골격·교차·구멍·윤곽)
 *   S6  성분 → 표현 라우팅 (배타적) + 프리미티브·패턴 컴파일
 *   S7  VectorScene → fidelity / editable / production 세 가지 SVG
 *   S8  3-gate QA (충실도 · 편집성 · 의미)
 *
 * V3와의 차이는 S5~S8이다. V3는 잉크 전체를 한 번에 처리하고 SVG 하나를 만들었다.
 * V4는 **성분마다 표현을 먼저 정하고**, 같은 장면에서 목적별로 다른 SVG를 굽는다.
 *
 * 아직 없는 것: topology 엔진(SLD / Deep Sketch Vectorization), differentiable refinement
 * (Bézier / NURBS Splatting), dense correspondence(DINOv3). 전부 모델 가중치와 GPU가 필요하다.
 * 그 자리는 어댑터 경계로 비워 두고, 없으면 지금 경로로 돈다.
 */
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import sharp from "sharp";
import { isolateProduct, cropToSubject } from "../pipeline/prepare.js";
import { planParts, type PartPlan } from "../v3/partPlan.js";
import { generateSchematic, activeBackend, normalizeCategory, type SchematicResult } from "../v3/schematicClient.js";
import { detectSubject, similarityFit, warpMask } from "../v3/subject.js";
import { segmentSchematic, snapMasksToFaces, type SegHint } from "./segSchematic.js";
import { inkMask } from "../v3/metrics.js";
import { config } from "../config.js";
import { buildVisibleMasks } from "../v2/masks.js";
import { area } from "../v2/raster.js";
import type { LayerManifest, ManifestLayer } from "../v2/schema.js";
import { buildScene, DEFAULT_SCENE_OPTIONS } from "./scene.js";
import { exportFidelity, exportEditable, exportProduction, countByClass } from "./export.js";
import { runQa4, type QA4 } from "./qa4.js";
import { DEFAULT_THRESHOLDS } from "./router.js";
import type { PartNode, VectorScene } from "./types.js";

export type V4State =
  | "PREPROCESSING" | "PLANNING" | "SEGMENTING" | "SKETCHING"
  | "EVIDENCE" | "ROUTING" | "EXPORTING" | "VALIDATING" | "DONE" | "FAILED";

export interface V4Options {
  categoryHint?: string;
  minParts: number;
  maxParts: number;
  grayscale: boolean;
  /** 사진 전처리 캔버스 긴 변 */
  workLong: number;
  /** 벡터 작업 캔버스 목표 긴 변 */
  vectorLong: number;
  inkThreshold: number;
  localContrast: number;
  textureMode: "auto" | "tone" | "keep";
  /**
   * 파트 마스크 출처. "schematic"(기본)은 도면을 Gemini 로 직접 segment 하고 warp 는
   * 위치 힌트로만 쓴다. "photo"는 예전 방식(사진 마스크 warp) — 회귀 비교용.
   * Gemini 키가 없으면 자동으로 photo 로 떨어진다.
   */
  segMode: "schematic" | "photo";
  /** 기존 도면 재사용 (백엔드 없이 검증) */
  schematicFrom?: string;
  upscale?: boolean;
}

export const DEFAULT_V4_OPTIONS: V4Options = {
  minParts: 3,
  maxParts: 10,
  grayscale: true,
  workLong: 1400,
  vectorLong: 2200,
  inkThreshold: 170,
  localContrast: 22,
  textureMode: "auto",
  segMode: "schematic",
};

export interface V4Result {
  state: string;
  plan: PartPlan;
  scene: VectorScene;
  qa: QA4;
  counts: Record<string, number>;
  artifacts: Record<string, string>;
  timings: Record<string, number>;
}

/** V3 와 같은 매니페스트 — buildVisibleMasks 가 이 스키마를 받는다 */
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


function guessNoun(hint?: string): { noun: string; category: string } {
  const h = (hint ?? "").toLowerCase();
  if (h.includes("shoe")) return { noun: "shoe", category: "shoe" };
  if (h.includes("bag")) return { noun: "bag", category: "bag" };
  if (h.includes("jewel") || h.includes("ring")) return { noun: "jewelry", category: "jewelry" };
  return { noun: "product", category: "generic" };
}

async function chromaShare(src: string): Promise<number> {
  const { data, info } = await sharp(src).flatten({ background: "#ffffff" }).removeAlpha()
    .resize(256, 256, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels, n = info.width * info.height;
  let colored = 0;
  for (let i = 0; i < n; i++) {
    const p = i * ch;
    const mx = Math.max(data[p], data[p + 1], data[p + 2]);
    const mn = Math.min(data[p], data[p + 1], data[p + 2]);
    if (mx > 60 && mx - mn > 34) colored++;
  }
  return colored / n;
}

export async function runV4(
  inputPath: string,
  jobDir: string,
  opts: V4Options = DEFAULT_V4_OPTIONS,
  onProgress?: (s: V4State, m: string) => void,
): Promise<V4Result> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (k: string, t: number) => (timings[k] = Date.now() - t);
  const say = (s: V4State, m: string) => onProgress?.(s, m);

  await fs.mkdir(jobDir, { recursive: true });
  const sketchDir = path.join(jobDir, "schematics");
  const masksDir = path.join(jobDir, "masks");
  const workDir = path.join(jobDir, "work");
  for (const d of [sketchDir, masksDir, workDir]) await fs.mkdir(d, { recursive: true });

  // ── S1 ───────────────────────────────────────────────────
  let ts = Date.now();
  say("PREPROCESSING", "정규화 · 격리 · 크롭");
  const normalized = path.join(jobDir, "normalized.png");
  await sharp(inputPath).rotate().flatten({ background: "#ffffff" }).png().toFile(normalized);
  const isolated = path.join(jobDir, "isolated.png");
  try {
    const noun = guessNoun(opts.categoryHint);
    await isolateProduct(normalized, isolated, noun.noun, noun.category);
  } catch { await fs.copyFile(normalized, isolated); }
  const cropped = path.join(jobDir, "cropped.png");
  await cropToSubject(isolated, cropped);
  const cm = await sharp(cropped).metadata();
  const scale = Math.min(1, opts.workLong / Math.max(cm.width!, cm.height!));
  const W = Math.max(64, Math.round(cm.width! * scale));
  const H = Math.max(64, Math.round(cm.height! * scale));
  const canonical = path.join(jobDir, "canonical_input.png");
  await sharp(cropped).flatten({ background: "#ffffff" }).resize(W, H, { fit: "fill" }).png().toFile(canonical);
  mark("S1_preprocess", ts);

  // ── S2 ───────────────────────────────────────────────────
  ts = Date.now();
  say("PLANNING", "GPT 구성품 분해");
  const planPath = path.join(jobDir, "part_plan.json");
  let plan: PartPlan;
  try {
    plan = JSON.parse(await fs.readFile(planPath, "utf8"));
    const sha = crypto.createHash("sha256").update(await fs.readFile(canonical)).digest("hex");
    if (plan.provenance?.inputSha256 !== sha) throw new Error("입력이 바뀜");
  } catch {
    plan = await planParts(canonical, {
      categoryHint: opts.categoryHint, minParts: opts.minParts, maxParts: opts.maxParts,
    }, (m) => say("PLANNING", m));
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
  }
  mark("S2_plan", ts);

  // ── S3 ───────────────────────────────────────────────────
  ts = Date.now();
  say("SEGMENTING", "파트별 가시 마스크");
  const vm = await buildVisibleMasks(canonical, toManifest(plan), masksDir);
  const photoSubject = await detectSubject(canonical);
  mark("S3_masks", ts);

  // ── S4 도면 ──────────────────────────────────────────────
  ts = Date.now();
  say("SKETCHING", "VRINGON 도면");
  let sketch: SchematicResult | null = null;
  let raw: string;
  if (opts.schematicFrom) {
    raw = path.join(sketchDir, "reuse.png");
    await sharp(opts.schematicFrom).flatten({ background: "#ffffff" }).png().toFile(raw);
  } else {
    if (!activeBackend()) throw new Error("schematic 백엔드가 없습니다 (REPLICATE_API_TOKEN 등)");
    sketch = await generateSchematic(canonical, sketchDir, {
      category: normalizeCategory(plan.category), grayscale: opts.grayscale, upscale: opts.upscale,
    }, (m) => say("SKETCHING", m));
    raw = sketch.pngPath;
  }
  const geomPath = (!opts.grayscale && sketch?.monoPath) ? sketch.monoPath : raw;
  let colorFrom = (!opts.grayscale && sketch?.monoPath) ? raw : undefined;
  let sampleFill = !opts.grayscale;
  let corrNote = "";
  if (opts.grayscale) {
    const chroma = await chromaShare(geomPath);
    if (chroma > 0.03) {
      sampleFill = true;
      colorFrom = geomPath;
      corrNote = `도면이 컬러로 생성됨 (채도 ${(chroma * 100).toFixed(0)}%) — 색면을 그대로 옮긴다`;
    }
  }

  // 도면 좌표계로 파트 마스크를 옮긴다 (등방 — 도면은 건드리지 않는다)
  const sm = await sharp(geomPath).metadata();
  const sketchSubject = await detectSubject(geomPath);
  const supersample = Math.max(1, Math.min(4, Math.round(opts.vectorLong / Math.max(sm.width!, sm.height!))));
  const VW = sm.width! * supersample, VH = sm.height! * supersample;
  const fit = similarityFit(photoSubject.box, {
    x: sketchSubject.box.x * supersample, y: sketchSubject.box.y * supersample,
    w: sketchSubject.box.w * supersample, h: sketchSubject.box.h * supersample,
  });
  const ordered = [...plan.parts].sort((a, b) => a.z - b.z);
  const warped = ordered
    .map((p) => ({ id: p.id, mask: vm.masks.get(p.id) }))
    .filter((x): x is { id: string; mask: Uint8Array } => !!x.mask && area(x.mask) > 0)
    .map((pm) => ({ id: pm.id, mask: warpMask(pm.mask, W, H, VW, VH, fit) }))
    .filter((pm) => area(pm.mask) > 0);

  // ── Phase B: 도면 직접 segmentation ──────────────────────
  //
  // warp 된 사진 마스크는 위치는 대강 맞지만 경계가 원리적으로 안 맞는다(도면은 모델이
  // 다시 그린 그림 — bag_1 종횡비 19.8% 불일치). 그래서 역할을 나눈다:
  // warp 마스크의 bbox 는 Gemini 에게 주는 **위치 힌트**, 실제 경계는 **도면에서 직접**.
  let partMasks = warped;
  const maskSource: Record<string, string> = {};
  for (const pm of warped) maskSource[pm.id] = "photo-warp";
  if (opts.segMode === "schematic" && config.geminiKey) {
    try {
      const hints: SegHint[] = warped.map((pm) => {
        let x0 = VW, y0 = VH, x1 = 0, y1 = 0;
        for (let y = 0; y < VH; y++) {
          for (let x = 0; x < VW; x++) {
            if (!pm.mask[y * VW + x]) continue;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
        return {
          id: pm.id,
          box: [
            Math.round((y0 / VH) * 1000), Math.round((x0 / VW) * 1000),
            Math.round((y1 / VH) * 1000), Math.round((x1 / VW) * 1000),
          ] as [number, number, number, number],
        };
      });
      const seg = await segmentSchematic(raw, plan, hints, masksDir, (m) => say("SEGMENTING", m));
      // 도면 해상도 → 작업 캔버스(supersample 배)
      const up = (m: Uint8Array): Uint8Array => {
        if (seg.width === VW && seg.height === VH) return m;
        const out = new Uint8Array(VW * VH);
        for (let y = 0; y < VH; y++) {
          const sy = Math.min(seg.height - 1, Math.floor((y / VH) * seg.height));
          for (let x = 0; x < VW; x++) {
            const sx = Math.min(seg.width - 1, Math.floor((x / VW) * seg.width));
            out[y * VW + x] = m[sy * seg.width + sx];
          }
        }
        return out;
      };
      const byId = new Map(seg.parts.map((sp) => [sp.id, up(sp.mask)]));
      // 파트별 선택: Gemini 마스크가 있고 warp 와 자리가 겹치면(IoU ≥ 0.1) 채택.
      // 자리가 아예 다르면 모델이 엉뚱한 곳을 잡은 것이므로 warp 를 유지한다.
      const blended: { id: string; mask: Uint8Array }[] = [];
      for (const pm of warped) {
        const g = byId.get(pm.id);
        if (!g) { blended.push(pm); continue; }
        let inter = 0, uni = 0;
        for (let i = 0; i < g.length; i++) {
          const a = g[i], b = pm.mask[i];
          if (a && b) inter++;
          if (a || b) uni++;
        }
        const iou = uni ? inter / uni : 0;
        if (iou >= 0.1) { blended.push({ id: pm.id, mask: g }); maskSource[pm.id] = "gemini-schematic"; }
        else { blended.push(pm); maskSource[pm.id] = `photo-warp (gemini 불일치 IoU ${iou.toFixed(2)})`; }
      }
      // warp 가 아예 없던 파트도 Gemini 가 찾았으면 쓴다
      for (const sp of seg.parts) {
        if (!blended.some((b) => b.id === sp.id)) {
          blended.push({ id: sp.id, mask: up(sp.mask) });
          maskSource[sp.id] = "gemini-schematic (warp 없음)";
        }
      }
      const zOf = new Map(ordered.map((o2, i) => [o2.id, i]));
      blended.sort((a2, b2) => (zOf.get(a2.id) ?? 99) - (zOf.get(b2.id) ?? 99));
      for (const n of seg.notes) say("SEGMENTING", "! " + n);

      // **혼용 금지.** Gemini 마스크와 warp 마스크는 좌표 정합이 다르다 — 절반씩 섞으면
      // 이웃 파트끼리 기준이 어긋나 배분이 무너진다(실측: bag_3 가중 IoU 0.708 → 0.435,
      // jewelry_3 0.651 → 0.588). 채택률 80% 이상일 때만 통째로 쓰고, 아니면 전부 warp.
      const nGem = Object.values(maskSource).filter((v) => v.startsWith("gemini")).length;
      if (nGem >= blended.length * 0.8) {
        partMasks = blended;
        say("SEGMENTING", `도면 직접 seg 채택: ${nGem}/${blended.length} 파트가 Gemini 마스크`);
      } else {
        for (const k of Object.keys(maskSource)) maskSource[k] = `photo-warp (표결 ${nGem}/${blended.length} 미달)`;
        say("SEGMENTING", `도면 seg 기각 (${nGem}/${blended.length} < 80%) — warp 마스크로 통일`);
      }
    } catch (e) {
      say("SEGMENTING", `도면 seg 실패 — warp 마스크로 진행: ${(e as Error).message.slice(0, 80)}`);
    }
    // **면 스냅은 마스크 출처와 무관하게 항상.** warp 마스크도 닫힌 면 단위로 스냅하면
    // 경계가 도면 선으로 정리된다(실측: shoe_3 는 Gemini 2/8 뿐인데도 스냅만으로
    // 가중 IoU 0.495 → 0.628). 경계는 도면에 이미 그려져 있다 — 그걸 쓰는 것뿐이다.
    {
      const inkV = await inkMask(raw, VW, VH, opts.inkThreshold);
      partMasks = snapMasksToFaces(partMasks, inkV.data, VW, VH);
    }
  }
  mark("S4_schematic", ts);

  // ── S5~S6 증거 · 라우팅 ──────────────────────────────────
  ts = Date.now();
  say("EVIDENCE", "성분별 증거 · 배타적 라우팅");
  const partNodes: PartNode[] = ordered.map((p) => ({
    id: p.id, label: p.label, z: p.z, kind: p.kind, confidence: p.confidence, occludedBy: p.occludedBy,
  }));
  const { scene, evidence } = await buildScene(geomPath, {
    ...DEFAULT_SCENE_OPTIONS,
    inkThreshold: opts.inkThreshold,
    localContrast: opts.localContrast,
    workLong: opts.vectorLong,
    textureMode: opts.textureMode,
    sampleFill,
    colorFrom,
    workDir,
    thresholds: DEFAULT_THRESHOLDS,
    parts: partMasks,
    partNodes,
  }, (m) => say("ROUTING", m));
  const usedGemini = Object.values(maskSource).some((v) => v.startsWith("gemini"));
  scene.correspondence = {
    method: usedGemini ? "schematic-direct-seg" : "global-similarity",
    aspectRatio: fit.aspectRatio,
    confident: photoSubject.confident && sketchSubject.confident,
    note: corrNote,
  };
  scene.provenance.schematic = {
    backend: sketch?.backend ?? "reuse",
    prompt: sketch?.prompt ?? "(재사용)",
    seed: sketch?.seed ?? null,
  };
  mark("S5_evidence", ts);

  // ── S7 export ────────────────────────────────────────────
  ts = Date.now();
  say("EXPORTING", "fidelity · editable · production");
  const svgs = {
    fidelity: exportFidelity(scene),
    editable: exportEditable(scene),
    production: exportProduction(scene),
  };
  await fs.writeFile(path.join(jobDir, "fidelity.svg"), svgs.fidelity, "utf8");
  await fs.writeFile(path.join(jobDir, "editable.svg"), svgs.editable, "utf8");
  await fs.writeFile(path.join(jobDir, "production.svg"), svgs.production, "utf8");
  await fs.writeFile(path.join(jobDir, "scene.json"), JSON.stringify(scene, null, 2), "utf8");
  mark("S7_export", ts);

  // ── S8 QA ────────────────────────────────────────────────
  ts = Date.now();
  say("VALIDATING", "3-gate QA");
  const qa = await runQa4(scene, geomPath, svgs, {
    texture: evidence.textureKept ? undefined : evidence.texture,
    partMasks,
    aspectRatio: fit.aspectRatio,
  });
  mark("S8_qa", ts);

  await sharp(Buffer.from(svgs.fidelity), { density: 96 })
    .resize(Math.min(1400, scene.canvas.width), undefined)
    .flatten({ background: "#ffffff" }).png()
    .toFile(path.join(jobDir, "preview.png"));

  const counts = countByClass(scene);
  const report = {
    job: { state: qa.state, canvas: scene.canvas, totalMs: Date.now() - t0, createdAt: new Date().toISOString() },
    options: opts, plan, counts, qa, timings,
    // 해프톤 삭제에서 구제한 디테일 — [개수, px]. 0이 아니면 그만큼의 스티치·로고가
    // 질감으로 오인돼 사라질 뻔했다는 뜻이다.
    rescued: { stitch: evidence.rescuedStitch, detail: evidence.rescuedDetail },
    maskSource,
    correspondence: scene.correspondence,
  };
  await fs.writeFile(path.join(jobDir, "qa_v4.json"), JSON.stringify(report, null, 2), "utf8");
  say("DONE", qa.state);

  return {
    state: qa.state, plan, scene, qa, counts, timings,
    artifacts: {
      "fidelity.svg": "fidelity.svg",
      "editable.svg": "editable.svg",
      "production.svg": "production.svg",
      "scene.json": "scene.json",
      "qa_v4.json": "qa_v4.json",
      "preview.png": "preview.png",
    },
  };
}
