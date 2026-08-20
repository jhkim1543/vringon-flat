/**
 * V2 오케스트레이터 — 개발계획서 §5.1(S00~S15), §14.3(job state machine), §13.3(재시도).
 *
 * 예시 8의 상태기계를 그대로 구현한다:
 *   RECEIVED -> PREPROCESSING -> PLANNING -> VALIDATING_PLAN
 *    -> SEGMENTING -> GENERATING_LAYERS -> REFINING_ALPHA
 *    -> SELECTING_CANDIDATES -> VECTORIZING -> ASSEMBLING
 *    -> VALIDATING_OUTPUT -> SUCCEEDED
 *   Any stage -> RETRYING_LAYER -> previous stage
 *   Any stage -> NEEDS_REVIEW
 *   Fatal error -> FAILED
 *
 * 재시도는 **레이어 단위**다(FR-09, 부록 A). 실패한 레이어만 prompt/seed/profile을
 * 바꿔 다시 만들고 나머지 후보는 재사용한다(§17.3 "한 레이어가 실패해도 다른 레이어
 * 후보를 폐기하지 않는다").
 */
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import sharp from "sharp";
import { config } from "../config.js";
import { isolateProduct, cropToSubject } from "../pipeline/prepare.js";
import { planLayers, DEFAULT_PLAN_OPTIONS, type PlanOptions } from "./planner.js";
import { validateAndRepairGraph } from "./graph.js";
import { buildVisibleMasks } from "./masks.js";
import { generateLayerCandidates, candidateConfigs, type QualityPreset, type LayerCandidate } from "./qwenWorker.js";
import { composeLayer, writeLayerPng, DEFAULT_COMPOSE, type ComposedLayer } from "./amodal.js";
import { scoreLayer, selectGlobal, type Choice } from "./scorer.js";
import { decideProfile, extractFeatures, normalizeRepresentation, type ProfileDecision } from "./profiles.js";
import { vectorizeLayerV2, type LayerVector } from "./vectorizeV2.js";
import { assembleSvg, assembleLayerSvg } from "./assemble.js";
import { runCompositeQa, type QaReportV2 } from "./qaV2.js";
import { area, loadRaster, type Raster } from "./raster.js";
import { EXTRACT_PROMPT_VERSION, type LayerManifest, type TargetMode } from "./schema.js";

/**
 * categoryHint를 SAM 3용 명사와 파이프라인 카테고리로 나눈다.
 *
 * "jewelry.ring" → {noun:"ring", category:"jewelry"}
 * "shoe"         → {noun:"shoe", category:"footwear"}
 *
 * 점 없는 한 단어를 그냥 `split(".")[1]`로 꺼내면 undefined가 되어 명사가
 * "object"로 떨어지고, SAM 3이 아무것도 못 찾아 배경 격리가 통째로 실패한다
 * (실측: shoe_1·bag_2에서 배경이 결과물에 그대로 남았다).
 */
export function parseCategoryHint(hint?: string): { noun: string; category: string } {
  const NOUN_TO_CATEGORY: Record<string, string> = {
    shoe: "footwear", sneaker: "footwear", boot: "footwear", sandal: "footwear",
    bag: "bag", purse: "bag", handbag: "bag", backpack: "bag",
    ring: "jewelry", earring: "jewelry", necklace: "jewelry", bracelet: "jewelry", brooch: "jewelry",
    watch: "watch", glasses: "eyewear", hat: "headwear", chair: "furniture",
  };
  const CATEGORY_TO_NOUN: Record<string, string> = {
    footwear: "shoe", bag: "bag", jewelry: "jewelry", apparel: "shirt",
    eyewear: "glasses", watch: "watch", headwear: "hat", furniture: "chair",
    electronics: "device", packaging: "box", other: "object",
  };
  if (!hint) return { noun: "object", category: "other" };
  const [a, b] = hint.split(".").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (b) return { noun: b, category: a };
  // 한 단어 — 카테고리명일 수도, 명사일 수도 있다
  if (CATEGORY_TO_NOUN[a]) return { noun: CATEGORY_TO_NOUN[a], category: a };
  return { noun: a, category: NOUN_TO_CATEGORY[a] ?? "other" };
}

export type JobState =
  | "RECEIVED" | "PREPROCESSING" | "PLANNING" | "VALIDATING_PLAN"
  | "SEGMENTING" | "GENERATING_LAYERS" | "REFINING_ALPHA"
  | "SELECTING_CANDIDATES" | "VECTORIZING" | "ASSEMBLING"
  | "VALIDATING_OUTPUT" | "RETRYING_LAYER" | "NEEDS_REVIEW"
  | "SUCCEEDED" | "FAILED";

export interface V2Options {
  targetMode: TargetMode;
  strictVector: boolean;
  qualityPreset: QualityPreset;
  minLayers: number;
  maxLayers: number;
  categoryHint?: string;
  includeAppearanceLayers: boolean;
  restoreOccludedRegions: boolean;
  /** 최대 레이어 재시도 라운드 */
  maxRetryRounds: number;
  /** 워크 캔버스 긴 변 (계산량 제어) */
  workLong: number;
  /** 캐시된 manifest를 무시하고 다시 계획한다 (:replan) */
  forceReplan?: boolean;
}

export const DEFAULT_V2_OPTIONS: V2Options = {
  targetMode: "clean_flat",
  strictVector: true,
  qualityPreset: "standard",
  minLayers: 3,
  maxLayers: 8,
  includeAppearanceLayers: true,
  restoreOccludedRegions: true,
  maxRetryRounds: 1,
  workLong: 1024,
};

export interface V2Result {
  state: JobState;
  manifest: LayerManifest;
  qa: QaReportV2;
  artifacts: Record<string, string>;
  stages: { id: string; state: JobState; ms: number; detail?: string }[];
  retries: { round: number; layerIds: string[]; reason: string }[];
  timings: Record<string, number>;
}

export async function runV2(
  inputPath: string,
  jobDir: string,
  opts: V2Options = DEFAULT_V2_OPTIONS,
  onProgress?: (state: JobState, msg: string) => void,
): Promise<V2Result> {
  const stages: V2Result["stages"] = [];
  const retries: V2Result["retries"] = [];
  const timings: Record<string, number> = {};
  let state: JobState = "RECEIVED";
  const t0 = Date.now();
  const mark = (id: string, s: JobState, start: number, detail?: string) => {
    const ms = Date.now() - start;
    stages.push({ id, state: s, ms, detail });
    timings[id] = ms;
  };
  const say = (s: JobState, m: string) => {
    state = s;
    onProgress?.(s, m);
  };

  await fs.mkdir(jobDir, { recursive: true });
  const layersDir = path.join(jobDir, "layers");
  const masksDir = path.join(jobDir, "visible_masks");
  const candDir = path.join(jobDir, "candidates");
  const workDir = path.join(jobDir, "work");
  for (const d of [layersDir, masksDir, candDir, workDir]) await fs.mkdir(d, { recursive: true });

  // ── S00/S01 입력 수신·정규화 ─────────────────────────────
  let ts = Date.now();
  say("PREPROCESSING", "입력 정규화");
  // S01은 "foreground 및 shadow 분리"까지가 계약이다(§5.1 산출물: normalized.png,
  // object_mask.png). 이걸 건너뛰면 반사 테이블·그라데이션 배경이 전경으로 들어가고,
  // 이후 모든 지표가 **잘못된 전경 기준**으로 자기 일관되게 높게 나온다(실측: 반사
  // 배경 반지에서 IoU 0.996인데 결과물은 배경 덩어리였다).
  const normalizedPath = path.join(jobDir, "normalized.png");
  await sharp(inputPath).rotate().flatten({ background: "#ffffff" }).png().toFile(normalizedPath);

  const isolatedPath = path.join(jobDir, "object_isolated.png");
  let isoNote = "";
  try {
    const { noun, category } = parseCategoryHint(opts.categoryHint);
    const iso = await isolateProduct(normalizedPath, isolatedPath, noun, category);
    isoNote = iso.note ?? "";
  } catch (e) {
    await fs.copyFile(normalizedPath, isolatedPath);
    isoNote = `격리 실패 → 원본 사용 (${(e as Error).message.slice(0, 60)})`;
  }
  // 제품이 작게 찍힌 사진은 크롭해야 파트가 뭉개지지 않는다
  const croppedPath = path.join(jobDir, "cropped.png");
  const crop = await cropToSubject(isolatedPath, croppedPath);

  const cmeta = await sharp(croppedPath).metadata();
  const cscale = opts.workLong / Math.max(cmeta.width!, cmeta.height!);
  const CW = Math.max(64, Math.round(cmeta.width! * Math.min(1, cscale)));
  const CH = Math.max(64, Math.round(cmeta.height! * Math.min(1, cscale)));
  const canonicalPath = path.join(jobDir, "canonical_input.png");
  await sharp(croppedPath).flatten({ background: "#ffffff" }).resize(CW, CH, { fit: "fill" }).png().toFile(canonicalPath);

  const W = CW, H = CH;
  const inputSha = crypto.createHash("sha256").update(await fs.readFile(canonicalPath)).digest("hex");
  const original = await loadRaster(canonicalPath);
  mark("S00_S01_preprocess", state, ts, [`${CW}×${CH}`, isoNote, crop.note].filter(Boolean).join(" / "));

  // ── S02 레이어 계획 ──────────────────────────────────────
  ts = Date.now();
  say("PLANNING", "Layer Manifest 생성 (GPT-5.6)");
  const planOpts: PlanOptions = {
    ...DEFAULT_PLAN_OPTIONS,
    targetMode: opts.targetMode,
    strictVector: opts.strictVector,
    minLayers: opts.minLayers,
    maxLayers: opts.maxLayers,
    categoryHint: opts.categoryHint,
    includeAppearanceLayers: opts.includeAppearanceLayers,
  };
  // 재현성(§1.1): planner 모델이 샘플링 파라미터를 거부해 실행마다 다른 manifest가
  // 나오면 결과 비교가 불가능하다. 같은 입력이면 캐시된 manifest를 재사용한다
  // (§17.3 input_hash 기반 캐시). 재계획은 :replan API로 명시적으로만 한다.
  const manifestPath = path.join(jobDir, "layer_manifest.json");
  let manifest: LayerManifest;
  let planCached = false;
  try {
    const cached = JSON.parse(await fs.readFile(manifestPath, "utf8")) as LayerManifest;
    if (!opts.forceReplan && cached.provenance?.input_sha256 === inputSha) {
      manifest = cached;
      planCached = true;
    } else throw new Error("stale");
  } catch {
    manifest = await planLayers(canonicalPath, planOpts, (m) => onProgress?.("PLANNING", m));
  }
  mark("S02_plan", state, ts, `${manifest.layers.length} layers${planCached ? " (캐시)" : ""}`);

  // ── S03 그래프 검증 ──────────────────────────────────────
  ts = Date.now();
  say("VALIDATING_PLAN", "occlusion DAG 검증·수리");
  const g = validateAndRepairGraph(manifest);
  manifest = g.manifest;
  if (g.repaired.length) onProgress?.("VALIDATING_PLAN", `수리 ${g.repaired.length}건: ${g.repaired.join(" / ")}`);
  await fs.writeFile(path.join(jobDir, "layer_manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  mark("S03_graph", state, ts, g.repaired.join(" / "));

  // ── S04 가시영역 마스크 ──────────────────────────────────
  ts = Date.now();
  say("SEGMENTING", "레이어별 가시 마스크");
  const vm = await buildVisibleMasks(canonicalPath, manifest, masksDir, (m) => onProgress?.("SEGMENTING", m));
  mark("S04_masks", state, ts, `커버리지 ${(vm.coverage * 100).toFixed(1)}%`);

  // ── S05/S06 후보 프롬프트·생성 ───────────────────────────
  ts = Date.now();
  say("GENERATING_LAYERS", `Qwen 후보 생성 (${opts.qualityPreset})`);
  const gen = await generateLayerCandidates(
    canonicalPath, manifest, vm.masks, W, H, opts.qualityPreset, candDir,
    (m) => onProgress?.("GENERATING_LAYERS", m),
  );
  await fs.writeFile(
    path.join(jobDir, "prompts.json"),
    JSON.stringify(
      {
        extract_prompt_version: EXTRACT_PROMPT_VERSION,
        backend: gen.backend,
        configs: candidateConfigs(opts.qualityPreset, manifest.layers.length),
      },
      null, 2,
    ),
    "utf8",
  );
  mark("S05_S06_candidates", state, ts, `backend=${gen.backend} 호출 ${gen.calls} 캐시 ${gen.cached}${gen.errors.length ? ` · 실패 ${gen.errors.length}` : ""}`);

  // ── S07/S08/S09: 합성 → 점수 → 전역 선택 (재시도 포함) ───
  let chosen: Choice[] = [];
  let composedMap = new Map<string, ComposedLayer>();
  let round = 0;
  let qa: QaReportV2 | null = null;
  let assembled: ReturnType<typeof assembleSvg> | null = null;
  let vectors = new Map<string, LayerVector>();
  let decisions = new Map<string, ProfileDecision>();
  let candidates = gen.candidates;

  for (;;) {
    ts = Date.now();
    say("REFINING_ALPHA", "amodal 합성 + alpha 정제");
    const perLayer = new Map<string, Choice[]>();
    const symmetryPrior = /ring|jewel|earring|watch|bag/i.test(manifest.object.category);

    for (const L of manifest.layers) {
      const visible = vm.masks.get(L.id);
      if (!visible || !area(visible)) continue;
      const cands = candidates.get(L.id) ?? [];
      const choices: Choice[] = [];

      // 후보가 없으면 visible만으로 구성 (생성 실패해도 산출물은 나온다 — §"실패해도 산출물")
      const list: (LayerCandidate | null)[] = cands.length ? cands : [null];
      for (const c of list) {
        const generated = c
          ? { raster: await loadRaster(c.rgbaPath, W, H), alpha: c.alpha }
          : null;
        const composed = await composeLayer(
          L, original, visible,
          opts.restoreOccludedRegions ? generated : null,
          W, H,
          { ...DEFAULT_COMPOSE, symmetryPrior },
        );
        const score = scoreLayer(L, composed, visible, original, W, H, manifest);
        choices.push({ layerId: L.id, candidateIndex: choices.length, score, composed });
      }
      // top-K만 남긴다 (§13.1 beam search 입력)
      choices.sort((a, b) => b.score.total - a.score.total);
      perLayer.set(L.id, choices.slice(0, 4));
    }
    mark(`S07_S08_compose_r${round}`, state, ts);

    ts = Date.now();
    say("SELECTING_CANDIDATES", "전역 조합 최적화 (beam search)");
    const order = [...manifest.layers].sort((a, b) => a.z_index - b.z_index).map((L) => L.id);
    const globalSel = selectGlobal(perLayer, order, W, H, vm.foreground, 12);
    chosen = globalSel.chosen;
    composedMap = new Map(chosen.map((c) => [c.layerId, c.composed]));
    mark(`S09_select_r${round}`, state, ts,
      `composite ${globalSel.compositeScore} · 조합 ${globalSel.evaluated}개 평가`);

    // ── S10/S11/S12 표현 정규화 → 벡터화 → 기하 정리 ───────
    ts = Date.now();
    say("VECTORIZING", "재질별 프로파일 벡터화");
    vectors = new Map();
    decisions = new Map();
    for (const c of chosen) {
      const L = manifest.layers.find((x) => x.id === c.layerId)!;
      const feats = extractFeatures(c.composed.rgb, c.composed.alpha, c.composed.mask, W, H);
      const decision = decideProfile(L.material, manifest.policy.target_mode, manifest.policy.strict_vector, feats, L.expected_color_count);
      decisions.set(L.id, decision);
      const normalized = await normalizeRepresentation(c.composed.rgb, c.composed.mask, W, H, decision);
      const v = await vectorizeLayerV2(L, normalized, c.composed.alpha, c.composed.mask, W, H, decision, workDir,
        (m) => onProgress?.("VECTORIZING", m));
      vectors.set(L.id, v);
      onProgress?.("VECTORIZING", `${L.id}: ${decision.profile} · path ${v.paths.length} · node ${v.nodes}`);
    }
    mark(`S10_S12_vectorize_r${round}`, state, ts);

    // ── S13 SVG 조립 ────────────────────────────────────────
    ts = Date.now();
    say("ASSEMBLING", "레이어 순서대로 SVG 조립");
    const opacity = new Map<string, number>();
    for (const c of chosen) {
      let sum = 0, n = 0;
      for (let i = 0; i < W * H; i++) if (c.composed.mask[i]) { sum += c.composed.alpha[i]; n++; }
      if (n) opacity.set(c.layerId, sum / n);
    }
    assembled = assembleSvg(manifest, vectors, W, H, { layerOpacity: opacity });
    mark(`S13_assemble_r${round}`, state, ts, `path ${assembled.stats.paths} · ${(assembled.stats.bytes / 1024).toFixed(0)}KB`);

    // ── S14 재합성 검증 ─────────────────────────────────────
    ts = Date.now();
    say("VALIDATING_OUTPUT", "SVG 래스터화 후 원본 대조");
    qa = await runCompositeQa(
      assembled.svg, assembled, manifest, canonicalPath,
      composedMap, vectors, vm.masks, vm.foreground, W, H,
    );
    mark(`S14_qa_r${round}`, state, ts,
      `IoU ${qa.silhouette.foregroundIou} · F ${qa.silhouette.boundaryFScore} · ΔE ${qa.color.maskedDeltaE2000}`);

    // ── S15 재시도 판단 ─────────────────────────────────────
    if (qa.pass || round >= opts.maxRetryRounds) break;

    const badLayers = [...new Set(qa.failures.map((f) => f.layerId).filter((x): x is string => !!x))];
    if (!badLayers.length) break;

    round++;
    say("RETRYING_LAYER", `레이어 ${badLayers.join(", ")} 재생성 (round ${round})`);
    retries.push({
      round,
      layerIds: badLayers,
      reason: qa.failures.filter((f) => f.layerId && badLayers.includes(f.layerId)).map((f) => `${f.layerId}:${f.signal}`).join(", "),
    });

    // 실패 레이어만 retry preset으로 후보를 **추가** 생성 — 나머지는 그대로 둔다
    const retryManifest: LayerManifest = { ...manifest, layers: manifest.layers.filter((L) => badLayers.includes(L.id)) };
    const extra = await generateLayerCandidates(
      canonicalPath, retryManifest, vm.masks, W, H, "retry", candDir,
      (m) => onProgress?.("RETRYING_LAYER", m),
    );
    const merged = new Map(candidates);
    for (const [id, cs] of extra.candidates) merged.set(id, [...(candidates.get(id) ?? []), ...cs]);
    candidates = merged;
  }

  if (!qa || !assembled) throw new Error("QA 단계에 도달하지 못했습니다");

  // ── 산출물 기록 ──────────────────────────────────────────
  ts = Date.now();
  const artifacts: Record<string, string> = {};

  await fs.writeFile(path.join(jobDir, "layered.svg"), assembled.svg, "utf8");
  artifacts["layered.svg"] = "layered.svg";

  for (const c of chosen) {
    const L = manifest.layers.find((x) => x.id === c.layerId)!;
    await writeLayerPng(c.composed, W, H, path.join(layersDir, `${L.id}.png`));
    artifacts[`layers/${L.id}.png`] = `layers/${L.id}.png`;
    const v = vectors.get(L.id);
    if (v) {
      await fs.writeFile(path.join(layersDir, `${L.id}.svg`), assembleLayerSvg(L, v, W, H), "utf8");
      artifacts[`layers/${L.id}.svg`] = `layers/${L.id}.svg`;
    }
  }

  // preview.png — 최종 SVG 렌더 결과
  await sharp(Buffer.from(assembled.svg), { density: 96 })
    .resize(Math.min(1200, W * 2), undefined, { withoutEnlargement: false })
    .flatten({ background: "#ffffff" })
    .png()
    .toFile(path.join(jobDir, "preview.png"));
  artifacts["preview.png"] = "preview.png";

  // manifest에 프로파일 결정 이유를 기록 (FR-06 완료 기준)
  for (const L of manifest.layers) {
    const d = decisions.get(L.id);
    if (d) {
      L.vector_profile = d.profile;
      (L as unknown as Record<string, unknown>).profile_reason = d.reason;
      (L as unknown as Record<string, unknown>).features = d.features;
    }
  }
  await fs.writeFile(path.join(jobDir, "layer_manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  artifacts["layer_manifest.json"] = "layer_manifest.json";

  const finalState: JobState = qa.pass ? (qa.needsReview ? "NEEDS_REVIEW" : "SUCCEEDED") : "NEEDS_REVIEW";

  const report = {
    job: {
      state: finalState,
      input_sha256: inputSha,
      canvas: { width: W, height: H },
      created_at: new Date().toISOString(),
      total_ms: Date.now() - t0,
    },
    options: opts,
    provenance: {
      ...manifest.provenance,
      extract_prompt_version: EXTRACT_PROMPT_VERSION,
      candidate_backend: gen.backend,
      candidate_errors: gen.errors,
      metric_version: qa.metricVersion,
      seed_set: candidateConfigs(opts.qualityPreset, manifest.layers.length).map((c) => c.seed),
    },
    selection: chosen.map((c) => ({
      layer_id: c.layerId,
      score: c.score,
      profile: decisions.get(c.layerId)?.profile,
      profile_reason: decisions.get(c.layerId)?.reason,
      checks: c.composed.checks,
    })),
    qa,
    retries,
    stages,
  };
  await fs.writeFile(path.join(jobDir, "qa_report.json"), JSON.stringify(report, null, 2), "utf8");
  artifacts["qa_report.json"] = "qa_report.json";

  // job_bundle.zip — 재현 가능한 모든 산출물·설정·모델 버전·seed (§ 최종 산출물)
  try {
    const { bundleJob } = await import("./bundle.js");
    await bundleJob(jobDir);
    artifacts["job_bundle.zip"] = "job_bundle.zip";
  } catch (e) {
    onProgress?.(state, `번들 생성 건너뜀: ${(e as Error).message.slice(0, 80)}`);
  }
  mark("S15_artifacts", finalState, ts);

  say(finalState, finalState === "SUCCEEDED" ? "완료" : "완료 (검토 필요)");
  return { state: finalState, manifest, qa, artifacts, stages, retries, timings };
}

export type { QaReportV2, LayerManifest };
