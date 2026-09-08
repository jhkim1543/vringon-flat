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
import { segmentSam3 } from "./segSam3.js";
import { assignResidualInk } from "./residualAssign.js";
import { segmentWithVringon, type VringonSegResult } from "./segVringon.js";

/** 마스크 내부의 배경까지 chamfer 거리 — SAM 점 프롬프트용 봉우리 찾기 */
function distanceInsideMask(mask: Uint8Array, W: number, H: number): Float32Array {
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = mask[i] ? 1e6 : 0;
  const A = 1, B = 1.414;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!mask[i]) continue;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + A);
    if (y > 0) v = Math.min(v, d[i - W] + A);
    if (x > 0 && y > 0) v = Math.min(v, d[i - W - 1] + B);
    if (x < W - 1 && y > 0) v = Math.min(v, d[i - W + 1] + B);
    d[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x;
    if (!mask[i]) continue;
    let v = d[i];
    if (x < W - 1) v = Math.min(v, d[i + 1] + A);
    if (y < H - 1) v = Math.min(v, d[i + W] + A);
    if (x < W - 1 && y < H - 1) v = Math.min(v, d[i + W + 1] + B);
    if (x > 0 && y < H - 1) v = Math.min(v, d[i + W - 1] + B);
    d[i] = v;
  }
  return d;
}
import { inkMask } from "../v3/metrics.js";
import { config } from "../config.js";
import { buildVisibleMasks } from "../v2/masks.js";
import { area } from "../v2/raster.js";
import type { LayerManifest, ManifestLayer } from "../v2/schema.js";
import { buildScene, DEFAULT_SCENE_OPTIONS } from "./scene.js";
import { exportFidelity, exportEditable, exportProduction, countByClass } from "./export.js";
import { exportAi, sceneToAiDoc } from "./aiExport.js";
import { buildJsx } from "../writers/jsxWriter.js";
import type { VectorIR } from "../types.js";

/**
 * 파이프라인 코드 판. **손으로 올린다** — 실행에 영향을 주는 변경을 했으면 여기도 올린다.
 * 산출물에 박혀서, 나중에 "같은 사진인데 결과가 다르다"를 짚을 근거가 된다.
 */
const CODE_VERSION = "v7.6";
import { lineartRecompose } from "./lineartRecompose.js";
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
  /** 라인 모드 — 중심선 스트로크 전용, 면 없음 */
  lineMode?: boolean;
  /** 선을 라이브 스트로크로 (면은 유지) */
  strokeLines?: boolean;
  /** 선 굵기를 몇 등급으로 통일할지 (0 = 실측값 유지) */
  widthGrades?: number;
  thinFinish?: boolean;
  /**
   * 파트 마스크 출처. "schematic"(기본)은 도면을 Gemini 로 직접 segment 하고 warp 는
   * 위치 힌트로만 쓴다. "photo"는 예전 방식(사진 마스크 warp) — 회귀 비교용.
   * Gemini 키가 없으면 자동으로 photo 로 떨어진다.
   */
  segMode: "schematic" | "photo";
  /** 기존 도면 재사용 (백엔드 없이 검증) */
  schematicFrom?: string;
  /** 도면을 선화 변형 프롬프트로 생성한다 (--lineart) */
  lineartSchematic?: boolean;
  upscale?: boolean;
  /**
   * **세그 우선.** 사내 SAM 3.1 패키지가 있는 카테고리(신발·가방·주얼리·상의·하의)는 사진을
   * 먼저 파트로 나누고 그 파트를 레이어로 삼는다 — GPT 파트 계획을 쓰지 않는다. 패키지가
   * 없는 카테고리·워커 미설정이면 자동으로 기존 경로(GPT 계획 + 일반 SAM)로 간다.
   * 기본 켬. false 면 회귀 비교용으로 끈다.
   */
  segFirst?: boolean;
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

/**
 * Gemini 마스크 채택 표결 하한. 원래 0.8 이었다 — 절반씩 섞으면 좌표 정합이 달라
 * 무너졌기 때문이다(bag_3 0.708→0.435). 그 측정은 **잉크 분할 이전**이었다.
 * 분할 후에 다시 실측했다 — **여전히 0.8 이 맞다.** 혼용을 허용하면 jewelry_3 의
 * 가중 IoU 가 0.871 → 0.713, 마스크 정합이 0.926 → 0.681 로 떨어진다.
 */
const MIX_VOTE_MIN = Number(process.env.V4_MIX_VOTE ?? 0.8);

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
    const iso = await isolateProduct(normalized, isolated, noun.noun, noun.category);
    // **격리 결과를 말한다.** 여태 반환값을 버려서, 배경이 안 지워진 채로 도면 모델에
    // 들어가도 아무도 몰랐다(실측: fal 잔액 잠금 → 검은 배경 그대로 → 선 일치 0.21).
    say("PREPROCESSING", `${iso.isolated ? "배경 격리" : "격리 못 함"} — ${iso.note}`);
  } catch (e) {
    say("PREPROCESSING", `격리 실패(무시) — ${(e as Error).message?.slice(0, 120)}`);
    await fs.copyFile(normalized, isolated);
  }
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
  const inputSha = crypto.createHash("sha256").update(await fs.readFile(canonical)).digest("hex");
  // **파트 계획은 사진 해시로 공유 캐시한다.**
  //
  // 잡 폴더에만 캐시했더니 잡 이름을 바꿀 때마다 GPT 를 다시 불렀고, **매번 다른 파트가
  // 나왔다**(실측 jewelry_1: engraved_lettering → brand_engraving → engraved_side_text).
  // 글리프 판정이 파트 이름으로 갈리므로 파트가 바뀌면 획·앵커가 통째로 달라진다 —
  // 같은 사진에서 앵커가 449 → 562 로 튀었다. 실무자는 결정성을 신뢰의 조건으로 본다.
  const sharedPlan = path.join(".cache", "plan", `${inputSha}_${opts.categoryHint ?? "generic"}.json`);
  let plan: PartPlan;
  // ── 세그 우선 — 사내 SAM 3.1 패키지로 사진을 먼저 파트로 나눈다 ──
  // 파트 목록이 학습된 고정 어휘라 결정적이고, 사내 다른 기능과 같은 이름을 쓴다.
  let vseg: VringonSegResult | null = null;
  if (opts.segFirst !== false) {
    try {
      vseg = await segmentWithVringon(canonical, opts.categoryHint, path.join(".cache", "vseg"), (m) => say("SEGMENTING", m));
    } catch (e) {
      say("SEGMENTING", `사내 세그 실패 — GPT 파트 계획으로 진행: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  if (vseg) {
    plan = vseg.plan;
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
  } else try {
    plan = JSON.parse(await fs.readFile(planPath, "utf8"));
    if (plan.provenance?.inputSha256 !== inputSha) throw new Error("입력이 바뀜");
    if (plan.provenance?.model?.startsWith("vringon-sam3.1")) throw new Error("세그 우선 계획은 재사용하지 않는다");
  } catch {
    try {
      plan = JSON.parse(await fs.readFile(sharedPlan, "utf8"));
      if (plan.provenance?.inputSha256 !== inputSha) throw new Error("해시 불일치");
      say("PLANNING", `파트 계획 캐시 재사용 (${plan.parts.length}개)`);
    } catch {
      plan = await planParts(canonical, {
        categoryHint: opts.categoryHint, minParts: opts.minParts, maxParts: opts.maxParts,
      }, (m) => say("PLANNING", m));
      await fs.mkdir(path.dirname(sharedPlan), { recursive: true });
      await fs.writeFile(sharedPlan, JSON.stringify(plan, null, 2), "utf8");
    }
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
  }
  mark("S2_plan", ts);

  // ── S3 ───────────────────────────────────────────────────
  ts = Date.now();
  say("SEGMENTING", vseg ? "파트별 가시 마스크 — 사내 세그 마스크 그대로" : "파트별 가시 마스크");
  const vm = vseg
    ? { masks: vseg.masks }
    : await buildVisibleMasks(canonical, toManifest(plan), masksDir);
  if (vseg) {
    // 마스크를 파일로도 남긴다 — 눈으로 검증할 수 있게 (buildVisibleMasks 와 같은 자리)
    for (const [id, m] of vseg.masks) {
      const buf = Buffer.alloc(W * H);
      for (let i = 0; i < buf.length; i++) buf[i] = m[i] ? 255 : 0;
      await sharp(buf, { raw: { width: W, height: H, channels: 1 } }).png()
        .toFile(path.join(masksDir, `${id}.png`)).catch(() => {});
    }
  }
  const photoSubject = await detectSubject(canonical);
  if (vseg && (vseg.reflectionsRemoved > 0 || process.env.V4_VSEG_BOX === "1")) {
    // **반사상을 지운 경우에만** 정합 기준 상자를 세그 전경으로 바꾼다. 배경 검출 상자는
    // 반사상을 전경으로 세어 정합이 반사만큼 어긋난다(실측 jewelry_2: 마스크 정합 0.48 → 0.87).
    // 반사가 없을 때는 바꾸지 않는다 — 도면 쪽 상자도 배경 검출로 재므로 **같은 잣대**여야
    // 한다. 사진 쪽만 세그 상자로 재면 잣대가 어긋나 오히려 나빠진다(실측 9종 재실행: bag_1
    // 앵커 742 → 1,259 · jewelry_1 360 → 568 · bag_2 정합 0.89 → 0.74).
    photoSubject.box = vseg.foregroundBox;
    photoSubject.confident = true;
    say("SEGMENTING", "정합 기준 상자 — 반사상을 지운 세그 전경으로 교체");
  }
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
    // **선화 모드는 도면을 두 장 만든다(선화 + 표준). 둘 다 같은 사진에서 독립이라 동시에 부른다.**
    // 순차로 부르면 Replicate 왕복이 두 번 쌓인다(실측 운영: 회당 107~187초). 결과는 같다.
    const needStd = !!opts.lineartSchematic && activeBackend() !== "vringon";
    const stdPromise = needStd
      ? generateSchematic(canonical, sketchDir, {
          category: normalizeCategory(plan.category), grayscale: opts.grayscale, upscale: opts.upscale,
        }, (m) => say("SKETCHING", `[표준] ${m}`))
      : null;
    sketch = await generateSchematic(canonical, sketchDir, {
      category: normalizeCategory(plan.category), grayscale: opts.grayscale, upscale: opts.upscale,
      lineart: opts.lineartSchematic,
    }, (m) => say("SKETCHING", m));
    raw = sketch.pngPath;
    if (stdPromise) {
      // 선화 변형의 두 드리프트(크기 이동·글자 뭉갬)를 표준 도면으로 바로잡는다.
      const std = await stdPromise;
      const spliced = path.join(sketchDir, "lineart_recomposed.png");
      await lineartRecompose(raw, std.pngPath, spliced, path.join(".cache", "letters"),
        (m) => say("SKETCHING", m));
      raw = spliced;
    } else if (opts.lineartSchematic) {
      // 사내 워커는 프롬프트를 못 받으므로 선화 변형·재합성이 성립하지 않는다.
      // 두 번 부르지 않고 그대로 쓴다 — 워커 자체가 이미 도면 전용으로 학습돼 있다.
      say("SKETCHING", "사내 워커 — 선화 프롬프트를 받지 않아 --lineart 는 무시한다");
    }
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
  for (const pm of warped) maskSource[pm.id] = vseg ? "vringon-sam3.1 warp" : "photo-warp";
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
      // **캐시는 잡 폴더 밖에 둔다.** 캐시 키는 (도면 sha × 파트 목록)이라 내용이 같으면
      // 같은 답이 나와야 하는데, 잡 폴더 안에 두면 **잡 이름만 바꿔도 캐시를 못 찾고**
      // Gemini 를 다시 불러 다른 답을 받는다(실측 jewelry_1: terminal_hallmark 가 한 번은
      // 영역 0개, 한 번은 1개 — 그 탓에 같은 사진에서 패스 3개가 달라졌다).
      const segCache = path.join(".cache", "seg");
      // Gemini 폴리곤과 SAM 박스 프롬프트는 서로 독립이다 — Gemini 를 먼저 띄워 두고 SAM 을 돈다.
      const segPromise = segmentSchematic(raw, plan, hints, segCache, (m) => say("SEGMENTING", m));
      let seg!: Awaited<typeof segPromise>;
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
      // ── SAM 3 (fal.ai) — 있으면 폴리곤보다 우선 ─────────
      // 폴리곤은 점 목록을 "말로" 불러 주다 조밀한 형상을 일부만 훑는 실패가 잦았다.
      // SAM 은 픽셀 마스크라 그 실패 양식이 없다. 같은 가드(자리 IoU·크기 온전성)를
      // 통과한 파트만 폴리곤 대신 쓴다.
      const samById = new Map<string, Uint8Array>();
      if (config.falKey) {
        try {
          const boxHints = new Map<string, {
            box: [number, number, number, number];
            points: [number, number][];
            warpPng: Buffer;
          }>();
          for (const hpm of warped) {
            let x0 = VW, y0 = VH, x1 = 0, y1 = 0;
            for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) {
              if (!hpm.mask[y * VW + x]) continue;
              if (x < x0) x0 = x; if (x > x1) x1 = x;
              if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
            if (x1 <= x0) continue;
            // 내부 점 — 거리변환 봉우리에서 최대 5개 (가는 파트는 박스만으로 무너진다)
            const dt = distanceInsideMask(hpm.mask, VW, VH);
            const pts: [number, number][] = [];
            const taken: [number, number][] = [];
            const minGap = Math.max(12, Math.round(Math.min(x1 - x0, y1 - y0) / 3));
            const cand: { x: number; y: number; d: number }[] = [];
            for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) {
              const d = dt[y * VW + x];
              if (d >= 2) cand.push({ x, y, d });
            }
            cand.sort((p1, p2) => p2.d - p1.d);
            for (const c of cand) {
              if (pts.length >= 5) break;
              if (taken.some(([tx, ty]) => Math.hypot(tx - c.x, ty - c.y) < minGap)) continue;
              taken.push([c.x, c.y]);
              pts.push([c.x / VW, c.y / VH]);
            }
            const buf = Buffer.alloc(VW * VH);
            for (let i = 0; i < VW * VH; i++) buf[i] = hpm.mask[i] ? 255 : 0;
            const warpPng = await sharp(buf, { raw: { width: VW, height: VH, channels: 1 } }).png().toBuffer();
            boxHints.set(hpm.id, { box: [x0 / VW, y0 / VH, x1 / VW, y1 / VH], points: pts, warpPng });
          }
          const sam = await segmentSam3(
            raw, ordered.map((p) => ({ id: p.id, label: p.label })), VW, VH,
            path.join(".cache", "seg"), (m) => say("SEGMENTING", m), boxHints,
          );
          for (const sp of sam) samById.set(sp.id, sp.mask);
        } catch (e) {
          say("SEGMENTING", `SAM 3 실패 — 폴리곤으로 진행: ${(e as Error).message.slice(0, 80)}`);
        }
      }
      seg = await segPromise;
      const byId = new Map(seg.parts.map((sp) => [sp.id, up(sp.mask)]));
      // 파트별 선택: Gemini 마스크가 있고 warp 와 자리가 겹치면(IoU ≥ 0.1) 채택.
      // 자리가 아예 다르면 모델이 엉뚱한 곳을 잡은 것이므로 warp 를 유지한다.
      const blended: { id: string; mask: Uint8Array }[] = [];
      for (const pm of warped) {
        const g = samById.get(pm.id) ?? byId.get(pm.id);
        const src = samById.has(pm.id) ? "sam3-schematic" : "gemini-schematic";
        if (!g) { blended.push(pm); continue; }
        let inter = 0, uni = 0;
        for (let i = 0; i < g.length; i++) {
          const a = g[i], b = pm.mask[i];
          if (a && b) inter++;
          if (a || b) uni++;
        }
        const iou = uni ? inter / uni : 0;
        // **크기 온전성도 본다.** 폴리곤이 대상의 일부만 훑고 끝나면 IoU 는 통과해도
        // 그 파트가 쪼그라든다 — 실측: bag_1 top_handle 폴리곤이 캔버스의 0.42% 뿐이라
        // 손잡이 면이 전부 이웃에게 넘어갔다(마스크 0.03%, precision 0.118).
        // warp 는 경계는 못 믿어도 **넓이**는 대체로 맞다. 절반도 안 되면 폴리곤을 버린다.
        let gA = 0, wA = 0;
        for (let i = 0; i < g.length; i++) { gA += g[i]; wA += pm.mask[i]; }
        const ratio = wA ? gA / wA : 1;
        say("SEGMENTING", `  · ${pm.id}: ${src.slice(0, 4)} IoU ${iou.toFixed(2)} · 크기비 ${ratio.toFixed(2)}`);
        // 크기 온전성은 **양쪽**으로 본다. 하한만 두면 부푼 마스크가 그대로 통과해
        // 이웃의 잉크까지 흡수한다(실측 jewelry_2 string_set: 워프의 1.76배 마스크가
        // 하프 줄 파트에 면 33개를 몰아줘 정밀도 0.31, semantic 게이트 붕괴).
        // 상한 1.6 은 실측 분포에서 정상(0.84~0.95)과 과대(1.76~2.48)를 가른다.
        if (iou >= 0.1 && ratio >= 0.5 && ratio <= 1.6) { blended.push({ id: pm.id, mask: g }); maskSource[pm.id] = src; }
        else if (iou < 0.1) { blended.push(pm); maskSource[pm.id] = `photo-warp (${src} 자리 불일치 IoU ${iou.toFixed(2)})`; }
        else { blended.push(pm); maskSource[pm.id] = `photo-warp (${src} 마스크 크기비 ${ratio.toFixed(2)})`; }
      }
      // warp 가 아예 없던 파트도 Gemini 가 찾았으면 쓴다
      for (const sp of seg.parts) {
        if (!blended.some((b) => b.id === sp.id)) {
          const m2 = samById.get(sp.id) ?? up(sp.mask);
          blended.push({ id: sp.id, mask: m2 });
          maskSource[sp.id] = `${samById.has(sp.id) ? "sam3" : "gemini"}-schematic (warp 없음)`;
        }
      }
      const zOf = new Map(ordered.map((o2, i) => [o2.id, i]));
      blended.sort((a2, b2) => (zOf.get(a2.id) ?? 99) - (zOf.get(b2.id) ?? 99));
      for (const n of seg.notes) say("SEGMENTING", "! " + n);

      // **혼용 금지.** Gemini 마스크와 warp 마스크는 좌표 정합이 다르다 — 절반씩 섞으면
      // 이웃 파트끼리 기준이 어긋나 배분이 무너진다(실측: bag_3 가중 IoU 0.708 → 0.435,
      // jewelry_3 0.651 → 0.588). 채택률 80% 이상일 때만 통째로 쓰고, 아니면 전부 warp.
      // **SAM 마스크는 표결 없이 파트별 혼용을 허용한다.** 혼용 금지의 근거는 Gemini
      // 폴리곤과 warp 의 좌표 정합이 달라 이웃 기준이 어긋난다는 것이었는데, SAM 은
      // warp 와 같은 도면 픽셀 위에서 자른 마스크라 그 문제가 없다(실측 bag_3: 3/4
      // 채택이 표결에 걸려 통째 기각 — strap 0.85·stones 0.86 개선분까지 버려졌다).
      const nSam = Object.values(maskSource).filter((v) => v.startsWith("sam3")).length;
      const nGem = Object.values(maskSource).filter((v) => v.startsWith("gemini") || v.startsWith("sam3")).length;
      if (nSam > 0 || nGem >= blended.length * MIX_VOTE_MIN) {
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
      // 퇴화 마스크 파트(워프가 무효였던 것)에 주인 없는 잉크 성분을 승계 — 정체만 LLM
      if (config.openaiKey) {
        try {
          await assignResidualInk({
            ink: inkV.data, W: VW, H: VH, partMasks,
            partLabels: ordered.map((p) => ({ id: p.id, label: p.label })),
            tmpDir: jobDir, say: (m) => say("SEGMENTING", m),
          });
        } catch (e) {
          say("SEGMENTING", `잔여 승계 실패(무시): ${(e as Error).message.slice(0, 80)}`);
        }
      }
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
    lineMode: opts.lineMode,
    strokeLines: opts.strokeLines,
    widthGrades: opts.widthGrades,
    thinFinish: opts.thinFinish,
    schematicPath: raw,
    workLong: opts.vectorLong,
    textureMode: opts.textureMode,
    sampleFill,
    colorFrom,
    workDir,
    thresholds: DEFAULT_THRESHOLDS,
    parts: partMasks,
    partNodes,
    category: plan.category,
  }, (m) => say("ROUTING", m));
  // **마스크가 도면을 실제로 설명하는가.** 파트 마스크가 잉크를 직접 덮은 비율이다.
  // 낮으면 마스크가 도면 위 엉뚱한 자리에 있다는 뜻 — 그때는 배분이 추측이 된다.
  // (BFS 로 이웃에게서 물려받은 잉크는 "덮었다"로 세지 않는다.)
  let inkOwned = 0, inkTotal = 0;
  {
    const cover = new Uint8Array(VW * VH);
    for (const pm of partMasks) for (let i = 0; i < cover.length; i++) if (pm.mask[i]) cover[i] = 1;
    for (let i = 0; i < evidence.ink.length; i++) {
      if (!evidence.ink[i]) continue;
      inkTotal++;
      if (cover[i]) inkOwned++;
    }
  }
  const maskFit = inkTotal ? inkOwned / inkTotal : 0;
  say("VALIDATING", `마스크 정합 — 도면 잉크의 ${(maskFit * 100).toFixed(1)}% 를 파트 마스크가 직접 덮는다`);

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
  // **같은 사진에서 같은 결과가 나온다는 근거를 남긴다.**
  // 백엔드·프롬프트·시드만으로는 부족하다 — 파이프라인 코드가 바뀌면 같은 도면에서도
  // 다른 벡터가 나온다. 실행에 영향을 주는 설정과 코드 판을 함께 적어 둔다.
  scene.provenance.run = {
    codeVersion: CODE_VERSION,
    options: {
      lineMode: !!opts.lineMode,
      strokeLines: !!opts.strokeLines,
      widthGrades: opts.widthGrades ?? 0,
      inkThreshold: opts.inkThreshold,
      localContrast: opts.localContrast,
      vectorLong: opts.vectorLong,
      textureMode: opts.textureMode,
    },
    // 실행을 바꾸는 환경변수만 — 값이 아니라 **설정됐는지**와 값 자체를 남긴다
    env: Object.fromEntries(
      Object.entries(process.env)
        .filter(([k]) => k.startsWith("V4_") || k === "SAM3_SSH_HOST")
        .map(([k, v]) => [k, k.endsWith("_KEY") ? "(설정됨)" : v ?? ""]),
    ),
    inputSha256: inputSha,
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

  // **`.ai` 도 여기서 낸다.** 예전에는 SVG 세 종류만 쓰고 `.ai` 는 rebuild-exports 를
  // 따로 돌려야 나왔다 — README 의 실행 설명과 실제 동작이 어긋났고, 한 번만 돌린
  // 사람은 정작 최종 산출물을 못 받았다(외부 검토 지적).
  // **세 프리셋을 다 낸다.** 레이어를 무엇 단위로 나눌지는 직군마다 요구가 배타적이라
  // 하나로 못 정한다 — 고르는 것은 쓰는 쪽의 몫이다.
  await fs.writeFile(path.join(jobDir, "layered.ai"), exportAi(scene, "function"));
  await fs.writeFile(path.join(jobDir, "layered-bypart.ai"), exportAi(scene, "part"));
  await fs.writeFile(path.join(jobDir, "layered-bycolor.ai"), exportAi(scene, "color"));
  {
    const doc = sceneToAiDoc(scene);
    const ir: VectorIR = {
      width: doc.width, height: doc.height,
      layers: doc.layers.map((l) => ({
        name: l.name,
        groups: l.groups.map((g) => ({
          name: g.name,
          paths: g.paths.map((p) => ({
            d: p.d, fill: p.fill, stroke: p.stroke,
            strokeWidth: p.strokeWidth, vectorizer: "vtracer" as const,
          })),
        })),
      })),
    };
    await fs.writeFile(path.join(jobDir, "native-layers.jsx"), buildJsx(ir, `${path.basename(jobDir).replace(/^v4_/, "")}.ai`), "utf8");
  }
  // ── 실루엣 전용 산출물 ───────────────────────────────────
  // 촘촘한 질감 제품의 앵커는 줄일 수 없다 — 대신 **쓸 수 있는 최소 산출물**을 따로 낸다.
  try {
    const { buildSilhouette, silhouetteSvg } = await import("./silhouette.js");
    const sil = await buildSilhouette(
      partMasks.map((b) => b.mask),
      { width: VW, height: VH, workDir, simplifyPx: 2 },
    );
    if (sil.paths.length) {
      await fs.writeFile(
        path.join(jobDir, "silhouette.svg"),
        silhouetteSvg(sil.paths, VW, VH), "utf8",
      );
      say("EXPORTING", `실루엣 ${sil.paths.length}개 · 앵커 ${sil.anchors}`);
    }
  } catch (e) {
    say("EXPORTING", `실루엣 생성 건너뜀: ${(e as Error).message.slice(0, 60)}`);
  }
  mark("S7_export", ts);

  // ── S8 QA ────────────────────────────────────────────────
  ts = Date.now();
  say("VALIDATING", "3-gate QA");
  const qa = await runQa4(scene, geomPath, svgs, {
    // 해프톤 톤 치환 + 보석 반사 제거는 **의도한 치환**이다. 둘 다 제외 영역에 넣지
    // 않으면 지표가 옳은 동작을 손실로 센다(실측: 반사를 지우자 jewelry_3 선 F@2 가
    // 0.869 → 0.842 로 "떨어졌다" — 지운 것이 기준에는 남아 있기 때문이다).
    texture: await (async () => {
      const t = evidence.textureKept ? undefined : evidence.texture;
      const g = evidence.gemFlatten?.removedMask;
      let out: Uint8Array | undefined;
      if (!g) out = t;
      else {
        out = new Uint8Array(g.length);
        for (let i = 0; i < g.length; i++) out[i] = (t?.[i] ? 1 : 0) | g[i];
      }
      // 제외 영역을 파일로 남긴다 — "지웠으니 빼고 쟀다"는 주장을 눈으로 검증할 수 있게
      if (out) {
        const buf = Buffer.alloc(out.length, 255);
        for (let i = 0; i < out.length; i++) if (out[i]) buf[i] = 0;
        await sharp(buf, { raw: { width: scene.canvas.width, height: scene.canvas.height, channels: 1 } })
          .png().toFile(path.join(jobDir, "qa_excluded.png")).catch(() => {});
      }
      return out;
    })(),
    partMasks,
    aspectRatio: fit.aspectRatio,
    maskFit,
    // 얇은 마감은 여기서 우회하지 않는다 — QA 가 qaWidth(누르기 전 폭)로 다시
    // 그려 재므로 질량 자가 그대로 유효하다(qa4.ts 첫머리).
    lineMode: opts.lineMode,
    // 얇은 마감은 면을 안 만든다(로고·글씨 예외) — 파트 판정만 thin 기준으로.
    noFaces: opts.thinFinish,
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
    maskFit: +maskFit.toFixed(4),
    correspondence: scene.correspondence,
    // 파트를 누가 정했나 — 사내 세그(고정 어휘) 인지 GPT 계획인지. 결과를 읽는 사람이
    // 파트 이름의 출처를 알아야 한다.
    segFirst: vseg
      ? { engine: vseg.engine, package: vseg.package, category: vseg.category, parts: vseg.detail }
      : null,
  };
  await fs.writeFile(path.join(jobDir, "qa_v4.json"), JSON.stringify(report, null, 2), "utf8");
  say("DONE", qa.state);

  return {
    state: qa.state, plan, scene, qa, counts, timings,
    artifacts: {
      "fidelity.svg": "fidelity.svg",
      "editable.svg": "editable.svg",
      "production.svg": "production.svg",
      "layered.ai": "layered.ai",
      "layered-bypart.ai": "layered-bypart.ai",
      "layered-bycolor.ai": "layered-bycolor.ai",
      "silhouette.svg": "silhouette.svg",
      "native-layers.jsx": "native-layers.jsx",
      "scene.json": "scene.json",
      "qa_v4.json": "qa_v4.json",
      "preview.png": "preview.png",
    },
  };
}
