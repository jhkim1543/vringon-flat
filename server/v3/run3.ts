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
import { vectorizeByLines, type LineMode, type LineVectorResult, type VecPath } from "./lineVector.js";
import { detectSubject, similarityFit, warpMask } from "./subject.js";
import { inkMask, svgInkMask, fidelity, detailRecall, topology } from "./metrics.js";
import { buildVisibleMasks } from "../v2/masks.js";
import { alignToBox } from "../pipeline/layers.js";
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
  /** 사진 전처리 캔버스 긴 변 (파트 마스크가 만들어지는 해상도) */
  workLong: number;
  /**
   * **벡터 작업 캔버스**의 목표 긴 변. 도면을 이 크기로 키워서 추적한다.
   * 확대 자체가 정보를 만들지는 않지만 이진화 경계가 부드러워져 tracer가 더 적은 패스로
   * 더 정확한 곡선을 낸다(bag_1 실측: 302패스 F@2px 0.968 → 279패스 0.994).
   */
  vectorLong: number;
  /** 선을 어떻게 표현할 것인가 — hybrid(기본) / outline(최고 충실도) / centerline(최고 편집성) */
  vectorMode: LineMode;
  /** 해프톤 처리 — auto(기본) / tone(항상 톤 면) / keep(항상 유지) */
  textureMode: "auto" | "tone" | "keep";
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
  schematicScope: "whole",
  grayscale: true,
  workLong: 1400,
  vectorLong: 2200,
  vectorMode: "hybrid",
  textureMode: "auto",
  // 도면 배경은 순백이 아니라 RGB 235 근처다. 190은 그 배경을 잉크로 잡지는 않지만
  // 옅은 회색 톤 면까지 잉크로 끌어들인다. 170이 선만 남긴다.
  inkThreshold: 170,
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
    /** 하위호환 — rawF2 와 같은 값 */
    boundaryF: number;
    /**
     * **사용자가 보는 도면** 대비 양방향 F1. 허용오차 0/1/2px.
     * 예전 지표는 기준을 파이프라인이 스스로 축소·왜곡한 aligned 입력으로 잡아서
     * "자기가 망가뜨린 입력을 얼마나 잘 따라 그렸나"만 쟀다(9종 평균 보고 0.872 vs
     * raw 대비 0.620, bag_1 은 0.939 vs 0.465).
     */
    rawF0: number;
    rawF1: number;
    rawF2: number;
    /**
     * 해프톤 질감 영역을 뺀 **선** 충실도. 그 영역은 점 대신 톤 면으로 그리는 것이 의도이므로
     * 전체 지표에 넣으면 "선이 빠졌다"로 집계돼 실제 결함이 묻힌다
     * (shoe_1 실측: 잉크비 0.757 · p95 19.6px가 거의 전부 메시 때문). 합격 판정은 이 값으로 한다.
     */
    lineF1: number;
    lineF2: number;
    /** 도면 잉크 중 해프톤이 차지하는 비율 */
    textureShare: number;
    /** 벡터 잉크 / 도면 잉크. 1보다 크면 선이 굵어진 것이다 */
    inkRatio: number;
    /** 대칭 chamfer 거리(px)와 그 95 백분위 */
    chamfer: number;
    p95: number;
    /** 스티치·로고·하드웨어 같은 작은 성분의 보존율 */
    detailRecall: number;
    /** 큰 연결성분 개수 (도면 / 벡터) */
    majorComponents: [number, number];
    /** 등방 정합 뒤에도 남은 종횡비 불일치 — 1.02 이하가 목표 */
    aspectRatio: number;
    partCoverage: number;
    /**
     * 파트별 **실측** 배분. precision 은 그 파트로 배정된 그림이 실제로 그 파트 영역 안에
     * 있는 비율이다. -1 은 마스크가 없어 잴 수 없었다는 뜻(전역값을 복제하지 않는다).
     */
    perPart: { id: string; paths: number; coverage: number; precision: number; recall: number; iou: number }[];
    /** 잴 수 있었던 파트들의 평균 precision */
    partPrecision: number;
    /** precision 이 0.5 미만인 파트 — 배분이 틀렸을 가능성 */
    misassignedParts: string[];
    /** 보이는데 패스가 0이고 공유 경계도 없는 파트 — 있으면 자동 검토 */
    emptyVisibleParts: string[];
    /** 자기 패스는 없지만 이웃이 소유한 공유 경계로 그려진 파트 — 결함이 아니다 */
    sharedOnlyParts: string[];
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

  // 사진 쪽 피사체. 도면과 맞출 때의 출발점이다.
  //
  // 예전에는 여기서 얻은 bbox에 **도면을 억지로 끼워 넣었다**(alignToBox, fit:"fill").
  // 두 가지가 잘못됐다.
  //   · fgBBox는 루미넌스 <245를 전경으로 봤는데 도면 배경은 RGB 235 근처라
  //     9종 중 5종에서 캔버스 전체가 전경으로 판정됐다(shoe_1·2·3, bag_1, bag_2).
  //   · fit:"fill"이 x·y를 다른 배율로 늘렸다. 생성 도면은 사진을 **다시 그린 것**이라
  //     종횡비가 애초에 다르고(bag_1 실측 21%), 억지로 맞추면 손잡이 곡률·스트랩 폭·
  //     버클 위치가 전부 바뀐다.
  // 결과: 배포된 벡터가 사용자에게 보이는 도면과 F@2px 0.40밖에 안 맞았다.
  // 이제 **도면을 건드리지 않는다**. 벡터는 도면 좌표계에서 만들고, 사진에서 온 파트
  // 마스크 쪽을 등방 상사변환으로 도면 좌표계에 옮긴다(정합 오차는 파트 배분에만 영향).
  const photoSubject = await detectSubject(canonical);

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
  /** 벡터가 사는 좌표계 — 도면 해상도 × supersample */
  let vectorCanvas = { w: W, h: H };
  let aspectRatio = 1;
  let alignNote = "";
  /** 도면 좌표계로 옮긴 파트 마스크 — QA가 파트별 배분을 실제로 검사한다 */
  let qaPartMasks: { id: string; mask: Uint8Array }[] = [];

  const partMasks = ordered
    .map((p) => ({ id: p.id, mask: vm.masks.get(p.id) }))
    .filter((x): x is { id: string; mask: Uint8Array } => !!x.mask && area(x.mask) > 0);

  const singleSketch = opts.schematicFrom || wholeSketch;
  if (singleSketch) {
    // ── 도면 1장 경로 ────────────────────────────────────────
    // 파트마다 clip해서 따로 벡터화하면 clip 경계가 외곽선을 잘라 면이 새어나간다
    // (실측: 가방 파트 커버리지 83.8%). 한 번 벡터화하고 파트에 배분한다.
    const st = Date.now();
    const raw = opts.schematicFrom
      ? await resolveExistingSketch(opts.schematicFrom, "_whole", canonical, W, H, sketchDir)
      : wholeSketch!.pngPath;

    // 컬러 모드: 선은 컬러화 **전** 모노 도식에서 뽑는다. 컬러본은 색면과 선이 같은
    // 검정이라 밝기 임계가 제품 전체를 잉크로 잡는다(실측: 검정 가방 → 패스 6개).
    const geomPath = (!opts.grayscale && wholeSketch?.monoPath) ? wholeSketch.monoPath : raw;
    let colorFrom = (!opts.grayscale && wholeSketch?.monoPath) ? raw : undefined;

    // 모노톤을 요청해도 모델이 **컬러로 그려 보내는 경우**가 있다(실측: jewelry_3은 금색 테와
    // 파란 보석으로 그려졌다). 그걸 흑백 선화로 취급하면 색면이 잡음 덩어리로 이진화돼
    // 보석이 얼룩이 된다. 채도가 뚜렷하면 색면을 그대로 샘플링해 평면 색으로 옮긴다.
    let sampleFill = !opts.grayscale;
    let neutralInkOnly = false;
    if (opts.grayscale) {
      const chroma = await chromaShare(geomPath);
      if (chroma > 0.03) {
        sampleFill = true;
        colorFrom = geomPath;
        // neutralInkOnly 는 켜지 않는다. 이런 도면은 **윤곽선 자체가 짙은 금색**이라
        // 채도로 거르면 진짜 선이 지워진다(실측: jewelry_3 선 일치 F@2px 0.866 → 0.789,
        // 잉크비 0.752 → 0.525, 작은 디테일 100% → 8.3%).
        alignNote = `도면이 컬러로 생성됨 (채도 화면의 ${(chroma * 100).toFixed(0)}%) — 색면을 그대로 옮긴다`;
      }
    }
    // QA 기준 = 벡터가 실제로 따라 그린 그림. 정합하지 않으므로 raw 그대로다.
    alignedSketches.push(geomPath);

    // 파트 마스크를 도면 좌표계로 옮긴다 (등방 — 확대·이동만)
    const sm = await sharp(geomPath).metadata();
    const sketchSubject = await detectSubject(geomPath);
    const supersample = Math.max(1, Math.min(4, Math.round(opts.vectorLong / Math.max(sm.width!, sm.height!))));
    const VW = sm.width! * supersample, VH = sm.height! * supersample;
    const fit = similarityFit(photoSubject.box, {
      x: sketchSubject.box.x * supersample, y: sketchSubject.box.y * supersample,
      w: sketchSubject.box.w * supersample, h: sketchSubject.box.h * supersample,
    });
    aspectRatio = fit.aspectRatio;
    if (!photoSubject.confident || !sketchSubject.confident) {
      alignNote = `피사체 검출 실패 — 캔버스 중심 정렬로 대체 (사진 ${(photoSubject.fill * 100).toFixed(0)}% · 도면 ${(sketchSubject.fill * 100).toFixed(0)}%)`;
    }
    const warpedParts = partMasks.map((pm) => ({
      id: pm.id,
      mask: warpMask(pm.mask, W, H, VW, VH, fit),
    })).filter((pm) => area(pm.mask) > 0);
    // QA가 파트별 배분을 실제로 검사할 수 있게 넘긴다 — 마스크는 도면 좌표계다
    qaPartMasks = warpedParts;
    sketchMs += Date.now() - st;

    const vt = Date.now();
    say("VECTORIZING", `도면 좌표계 ${VW}×${VH} (×${supersample}) · ${opts.vectorMode}`);
    const lv = await vectorizeByLines(geomPath, {
      inkThreshold: opts.inkThreshold,
      mode: opts.vectorMode,
      textureMode: opts.textureMode,
      workLong: opts.vectorLong,
      workDir,
      sampleFill,
      neutralInkOnly,
      colorFrom,
      parts: warpedParts,
    });
    vectorCanvas = { w: lv.width, h: lv.height };
    vecMs += Date.now() - vt;

    for (const p of ordered) {
      const regions = lv.regions.filter((r) => r.partId === p.id);
      const strokes = lv.strokes.filter((r) => r.partId === p.id);
      vectors.set(p.id, { ...lv, regions, strokes });
      layers.push({
        partId: p.id, label: p.label, z: p.z,
        regions: regions.length, strokes: strokes.length,
        nodes: [...regions, ...strokes].reduce((n, x) => n + (x.d.match(/[LCQSTA]/g) ?? []).length, 0),
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
    // ── 파트별 도면 경로 (실험용) ─────────────────────────────
    //
    // 파트를 크롭해 도면 모델에 따로 넣는 흐름. 이론상 레이어 분리가 가장 깔끔해야
    // 하지만 실제로는 무너진다 — schematic LoRA는 **제품 전체 사진**으로 학습돼
    // 있어서 조각을 주면 그 조각을 단서로 완성품 하나를 지어낸다.
    // (실측: 반지 "검은 인레이" 크롭 → 목걸이 펜던트가 나옴. 조각마다 자기 외곽선을
    //  갖게 되어 어셈블하면 윤곽이 겹치고 어긋난다.)
    // 기본 경로는 whole이며, 이 분기는 모델을 파트로 파인튜닝할 때를 위해 남겨 둔다.
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
      // 파트별 경로는 실험용이라 예전 정합을 유지한다 — 조각 도면끼리 좌표계를 맞출
      // 방법이 bbox 말고 없기 때문이다. 이 경로 자체가 권장되지 않는다(위 주석 참조).
      const alignedPath = path.join(workDir, `${p.id}.aligned.png`);
      await fs.writeFile(alignedPath, await alignToBox(r.pngPath, photoSubject.box, W, H));
      alignedSketches.push(alignedPath);
      sketchMs += Date.now() - st;

      // 파트 도면은 그 파트만 그려져 있으므로 clip이 필요 없다 — 선이 잘리지 않는다
      const vt = Date.now();
      say("VECTORIZING", `${p.label || p.id} 라인 벡터화`);
      const lv = await vectorizeByLines(alignedPath, {
        inkThreshold: opts.inkThreshold, mode: opts.vectorMode, textureMode: opts.textureMode,
        workLong: opts.vectorLong,
        workDir, sampleFill: !opts.grayscale,
      });
      vectorCanvas = { w: lv.width, h: lv.height };
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
  const svg = assemble(plan, ordered, vectors, vectorCanvas.w, vectorCanvas.h);
  const svgPath = path.join(jobDir, "layered.svg");
  await fs.writeFile(svgPath, svg, "utf8");
  mark("S7_assemble", ts);

  // ── S8 재합성 QA ──────────────────────────────────────────
  ts = Date.now();
  say("VALIDATING", "SVG 래스터화 후 원본 대조");
  // 기준은 **사용자가 화면에서 보는 도면**이다. 예전에는 파이프라인이 스스로 축소·왜곡한
  // aligned 입력을 기준으로 삼아, 자기가 망가뜨린 그림을 얼마나 잘 따라 그렸는지만 쟀다.
  const qa = await validate(svg, alignedSketches, vectors, ordered, {
    aspectRatio, alignNote, canvas: vectorCanvas, partMasks: qaPartMasks,
  });
  mark("S8_qa", ts);

  await sharp(Buffer.from(svg), { density: 96 })
    .resize(Math.min(1400, vectorCanvas.w), undefined)
    .flatten({ background: "#ffffff" })
    .png()
    .toFile(path.join(jobDir, "preview.png"));

  const state: V3State = qa.pass ? "SUCCEEDED" : "NEEDS_REVIEW";
  const report = {
    job: {
      state,
      canvas: { width: W, height: H },
      vectorCanvas: { width: vectorCanvas.w, height: vectorCanvas.h },
      totalMs: Date.now() - t0,
      createdAt: new Date().toISOString(),
    },
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

/** layered.svg 에서 한 파트의 <g> 만 떼어내 독립 SVG 로 만든다 (파트별 QA용) */
function extractLayer(svg: string, partId: string): string | null {
  const open = svg.indexOf(`<g id="layer-${partId}"`);
  if (open < 0) return null;
  const end = svg.indexOf("</g>", open);
  if (end < 0) return null;
  const head = svg.slice(0, svg.indexOf(">", svg.indexOf("<svg")) + 1)
    .replace(/^[sS]*?<svg/, "<svg");
  return `${head}
${svg.slice(open, end + 4)}
</svg>
`;
}

/**
 * 화면에서 채도가 뚜렷한 픽셀의 비율. 모노톤을 요청했는데 모델이 컬러로 그려 보냈는지
 * 판정한다 — 흑백 선화로 취급하면 색면이 잡음으로 이진화된다.
 */
async function chromaShare(src: string): Promise<number> {
  const { data, info } = await sharp(src)
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .resize(256, 256, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const n = info.width * info.height;
  let colored = 0;
  for (let i = 0; i < n; i++) {
    const p = i * ch;
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    // 밝고 채도 있는 픽셀만 — 검은 선의 JPEG 색번짐은 세지 않는다
    if (mx > 60 && mx - mn > 34) colored++;
  }
  return colored / n;
}

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
      ...v.regions.map((r) => pathTag(r)),
      ...v.strokes.map((s) => pathTag(s)),
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

/**
 * 패스를 SVG 태그로. **위치가 아니라 `kind`로 갈라야 한다.**
 *
 * outline 방식의 선은 채워진 리본이라 `fill`로 그려야 한다. 예전에는 "regions면 fill,
 * strokes면 stroke"라는 위치 기반 분기여서 리본의 **테두리만** 2px stroke로 그렸다.
 * 그 결과 선이 얇아지고 이중선처럼 보였다(실측: 잉크비 0.457, F@2px 0.714).
 */
function pathTag(p: VecPath): string {
  // 파트 경계선은 이웃 파트도 함께 쓴다. 소유자는 하나로 정하되 공유 관계를 남겨
  // 편집 도구가 "이 파트를 끄면 이웃 외곽선도 사라진다"를 알 수 있게 한다.
  const shared = p.shared?.length ? ` data-shared="${p.shared.join(" ")}"` : "";
  if (p.kind === "centerline") {
    return (
      `      <path d="${p.d}" fill="none" stroke="${p.stroke ?? "#111111"}" ` +
      `stroke-width="${p.strokeWidth ?? 2}" stroke-linecap="round" stroke-linejoin="round"${shared}/>`
    );
  }
  return `      <path d="${p.d}" fill="${p.fill ?? "#111111"}" fill-rule="evenodd"${shared}/>`;
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

/**
 * 산출된 SVG를 **사용자가 보는 도면**과 대조한다.
 *
 * 예전 QA의 결함:
 *   · 기준이 `whole.aligned.png` — 파이프라인이 스스로 축소하고 비등방으로 늘린 입력이었다.
 *     자기가 망가뜨린 그림을 얼마나 잘 따라 그렸는지만 재게 된다.
 *     (9종 평균 보고 F 0.872 · aligned 대비 0.917 · **raw 대비 0.620**)
 *   · 허용오차 2px 하나만 봤다. 선이 굵어지거나 1px 밀린 것이 전부 통과한다.
 *   · `partCoverage`가 파트별이 아니라 전역 통계의 복제였다. 보이는 파트에 패스가
 *     0개여도 통과했다(bag_1 top_handle).
 *   · 작은 디테일(스티치·로고·하드웨어) 손실을 재는 지표가 아예 없었다. 픽셀 수가 적어
 *     F1을 거의 못 움직이므로 전체 지표에 묻힌다.
 */
async function validate(
  svg: string,
  sketchPaths: string[],
  vectors: Map<string, LineVectorResult>,
  ordered: ProductPart[],
  ctx: {
    aspectRatio: number;
    alignNote: string;
    canvas: { w: number; h: number };
    /** 도면 좌표계의 파트 마스크. 있으면 파트별 IoU를 실제로 잰다. */
    partMasks: { id: string; mask: Uint8Array }[];
  },
): Promise<V3Result["qa"]> {
  const notes: string[] = [];
  const W = ctx.canvas.w, H = ctx.canvas.h;

  // ── 기준: 도면 원본 ──────────────────────────────────────
  const ref = sketchPaths.length
    ? await inkMask(sketchPaths[0], W, H)
    : { data: new Uint8Array(W * H), width: W, height: H };

  // ── 선 충실도 ────────────────────────────────────────────
  // centerline 모드에서는 면까지 칠한 렌더로 재면 면 전체가 잉크가 되어 선 일치도가
  // 무의미해진다(컬러 모드는 면 색 자체가 어두워 더 심하다). 그래서 fill을 지운다.
  // 다만 outline 방식의 **선은 fill로 그려지므로** 그때는 지우면 안 된다.
  const hasOutline = [...vectors.values()].some((v) => v.strokes.some((s) => s.kind === "outline"));
  const lineSvg = hasOutline ? svg : svg.replace(/fill="#[0-9a-fA-F]{3,6}"/g, 'fill="none"');
  const vec = await svgInkMask(lineSvg, W, H);

  const fid = fidelity(ref, vec, [0, 1, 2]);
  const small = Math.max(6, Math.round(W * H * 0.00008));

  // 해프톤 자리를 톤 면으로 바꾼 것은 **의도**다. 그 영역을 그대로 두고 재면 "선이 빠졌다"로
  // 집계돼 실제 결함이 묻힌다(shoe_1 실측: 잉크비 0.757 · p95 19.6px 가 거의 전부 메시 때문).
  // 그래서 질감 영역을 뺀 **선 충실도**를 따로 내고, 합격 판정은 이쪽으로 한다.
  const texMask = [...vectors.values()][0]?.texture;
  const detail = detailRecall(ref, vec, small, 2, texMask);
  let fidLine = fid;
  let textureShare = 0;
  if (texMask) {
    const cut = (m: { data: Uint8Array; width: number; height: number }) => {
      const d = new Uint8Array(m.data.length);
      for (let i = 0; i < d.length; i++) d[i] = m.data[i] && !texMask[i] ? 1 : 0;
      return { data: d, width: m.width, height: m.height };
    };
    let inTex = 0, tot = 0;
    for (let i = 0; i < ref.data.length; i++) if (ref.data[i]) { tot++; if (texMask[i]) inTex++; }
    textureShare = tot ? inTex / tot : 0;
    if (textureShare > 0.01) fidLine = fidelity(cut(ref), cut(vec), [0, 1, 2]);
  }
  const topo = topology(ref, vec);

  // ── 실루엣 ───────────────────────────────────────────────
  // 라인 드로잉의 전경은 "흰색이 아닌 픽셀"이 아니다 — 내부가 흰색이므로 그렇게 재면
  // 선만 전경이 되어 IoU가 구조적으로 낮게 나온다. 바깥에서 flood fill 해서
  // **외곽선이 막아 준 안쪽**을 전경으로 본다.
  const filledSvg = svg.replace(/fill="#[0-9a-fA-F]{3,6}"/g, 'fill="#000000"');
  const rendered = await sharp(Buffer.from(filledSvg), { density: 192 })
    .resize(W, H, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const raster = { data: rendered.data, channels: rendered.info.channels, width: W, height: H };
  const fg = enclosedForeground(raster, backgroundMask(raster, W, H, 246), W, H);

  let refFg: Uint8Array<ArrayBufferLike> = new Uint8Array(W * H);
  if (sketchPaths.length) {
    const sk = await sharp(sketchPaths[0]).flatten({ background: "#ffffff" })
      .resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const r2 = { data: sk.data, channels: sk.info.channels, width: W, height: H };
    refFg = enclosedForeground(r2, backgroundMask(r2, W, H, 246), W, H);
  }
  const silhouetteIou = area(refFg) ? iou(fg, refFg) : 0;

  // ── 패스 위생 ────────────────────────────────────────────
  let totalPaths = 0, totalNodes = 0, invalid = 0;
  const margin = Math.max(W, H) * 0.5;
  for (const v of vectors.values()) {
    for (const q of [...v.regions, ...v.strokes]) {
      totalPaths++;
      totalNodes += (q.d.match(/[LCQSTA]/g) ?? []).length;
      const nums = (q.d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
      if (nums.some((n) => !Number.isFinite(n))) { invalid++; continue; }
      for (let i = 0; i + 1 < nums.length; i += 2) {
        if (nums[i] < -margin || nums[i] > W + margin || nums[i + 1] < -margin || nums[i + 1] > H + margin) {
          invalid++;
          break;
        }
      }
    }
  }

  // ── 파트별 진짜 배분 검사 ────────────────────────────────
  //
  // 예전에는 `v.stats.coverage`(전역 통계)를 파트마다 복제해 넣었다. whole 경로에서는
  // 모든 파트가 같은 `lv`를 공유하므로 값이 전부 똑같이 나왔고(bag_1 8개 파트가 전부
  // 0.9996), 파트 배분이 맞는지는 아예 재지 않은 셈이었다.
  //
  // 이제 파트 레이어를 **하나씩 따로 래스터화**해 그 파트의 마스크와 대조한다.
  //   precision — 그 파트로 배정된 그림이 실제로 그 파트 영역 안에 있는가 (배분 정확도)
  //   recall    — 그 파트 영역을 그 파트의 그림이 덮는가
  // 선은 파트 **경계**에 놓이므로 마스크를 조금 넓혀서 잰다. 그리고 marking 류(로고·각인)는
  // 면을 채우지 않으므로 recall이 구조적으로 낮다 — 합격 판정은 **precision으로만** 한다.
  const perPart: { id: string; paths: number; coverage: number; precision: number; recall: number; iou: number }[] = [];
  const emptyVisibleParts: string[] = [];
  const maskById = new Map(ctx.partMasks.map((m) => [m.id, m.mask]));
  // 어떤 파트가 다른 패스의 공유 대상으로 지목됐는가
  const sharedWith = new Set<string>();
  for (const v of vectors.values()) {
    for (const q of [...v.regions, ...v.strokes]) for (const id of q.shared ?? []) sharedWith.add(id);
  }
  const sharedOnlyParts: string[] = [];
  const tol = Math.max(2, Math.round(Math.min(W, H) * 0.01));

  for (const part of ordered) {
    const v = vectors.get(part.id);
    const paths = v ? v.regions.length + v.strokes.length : 0;
    if (!paths) {
      // 자기 패스가 없어도 **이웃이 소유한 공유 경계**로 그려져 있을 수 있다.
      // 파트 경계선은 두 파트가 함께 쓰는데 소유자는 하나뿐이라, 몸통처럼 외곽선을
      // 전부 이웃에게 내준 파트가 생긴다(실측: bag_1 main_compartment_shell).
      // 그것까지 "안 그려졌다"로 실패시키면 실제 누락과 구분이 안 된다.
      // 여러 파트에 가려진 파트는 자기 선이 없을 수 있다 — 보이는 부분이 이웃과의
      // 경계선뿐이고 그 선의 소유자는 앞쪽 파트다(실측: bag_1 main_compartment_shell 은
      // front_flap·side_attachment_tab·red_stripe_trim·closure_strap 4개에 가려져 있다).
      // 그것까지 실패로 세면 진짜 누락과 구분이 안 된다.
      const buried = (part.occludedBy?.length ?? 0) >= 2;
      if (sharedWith.has(part.id) || buried) {
        sharedOnlyParts.push(part.id);
        perPart.push({ id: part.id, paths: 0, coverage: 0, precision: -1, recall: -1, iou: -1 });
      } else {
        emptyVisibleParts.push(part.id);
        perPart.push({ id: part.id, paths: 0, coverage: 0, precision: 0, recall: 0, iou: 0 });
      }
      continue;
    }
    const mask = maskById.get(part.id);
    if (!mask) {
      // 마스크가 없으면(파트별 도면 경로 등) 배분을 잴 근거가 없다 — 전역값을 쓰지 않는다
      perPart.push({ id: part.id, paths, coverage: v!.stats.coverage, precision: -1, recall: -1, iou: -1 });
      continue;
    }
    const layer = extractLayer(svg, part.id);
    if (!layer) {
      perPart.push({ id: part.id, paths, coverage: 0, precision: 0, recall: 0, iou: 0 });
      continue;
    }
    // 면을 검게 칠해 렌더한다 — 흰 fill은 배경과 구분되지 않는다
    const one = await svgInkMask(layer.replace(/fill="#[0-9a-fA-F]{3,6}"/g, 'fill="#000000"'), W, H, 200);
    const grown = dilate(mask, W, H, tol);
    let inter = 0, drawn = 0, maskN = 0, union = 0;
    for (let i = 0; i < W * H; i++) {
      const d = one.data[i], m = grown[i];
      if (d) drawn++;
      if (m) maskN++;
      if (d && m) inter++;
      if (d || m) union++;
    }
    perPart.push({
      id: part.id,
      paths,
      coverage: v!.stats.coverage,
      precision: drawn ? +(inter / drawn).toFixed(4) : 0,
      recall: maskN ? +(inter / maskN).toFixed(4) : 0,
      iou: union ? +(inter / union).toFixed(4) : 0,
    });
  }

  const measured = perPart.filter((p) => p.precision >= 0 && p.paths > 0);
  const partPrecision = measured.length
    ? measured.reduce((s, p) => s + p.precision, 0) / measured.length
    : 1;
  const misassigned = measured.filter((p) => p.precision < 0.5).map((p) => p.id);
  const partCoverage = vectors.size
    ? [...vectors.values()].reduce((s, v) => s + v.stats.coverage, 0) / vectors.size
    : 0;

  // ── 메모 ─────────────────────────────────────────────────
  if (fidLine.f.f2 < 0.9) notes.push(`도면 대비 선 일치 F@2px ${fidLine.f.f2.toFixed(3)} (F@1px ${fidLine.f.f1.toFixed(3)})`);
  if (fidLine.inkRatio > 1.25) notes.push(`선이 원본보다 ${((fidLine.inkRatio - 1) * 100).toFixed(0)}% 굵다`);
  if (fidLine.inkRatio < 0.8) notes.push(`선이 원본보다 ${((1 - fidLine.inkRatio) * 100).toFixed(0)}% 얇거나 빠졌다`);
  if (detail.recall < 0.85) {
    notes.push(`작은 디테일 보존 ${(detail.recall * 100).toFixed(0)}% — ${detail.total - detail.kept}개 소실 (스티치·로고·하드웨어 확인)`);
  }
  if (ctx.aspectRatio > 1.02) {
    notes.push(`사진↔도면 종횡비 불일치 ${((ctx.aspectRatio - 1) * 100).toFixed(1)}% — 파트 배분 정확도에만 영향 (도면은 왜곡하지 않는다)`);
  }
  if (ctx.alignNote) notes.push(ctx.alignNote);
  if (misassigned.length) {
    notes.push(`파트 배분이 의심되는 레이어 ${misassigned.length}개: ${misassigned.join(", ")} (precision < 0.5)`);
  }
  if (measured.length && partPrecision < 0.7) {
    notes.push(`파트 배분 정확도 평균 ${(partPrecision * 100).toFixed(0)}% — 사진↔도면 대응이 어긋났을 수 있다`);
  }
  if (sharedOnlyParts.length) {
    notes.push(`자기 패스 없이 공유 경계로만 그려진 파트 ${sharedOnlyParts.length}개: ${sharedOnlyParts.join(", ")}`);
  }
  if (emptyVisibleParts.length) notes.push(`패스가 없는 파트 ${emptyVisibleParts.length}개: ${emptyVisibleParts.join(", ")}`);
  if (invalid) notes.push(`유효하지 않은 패스 ${invalid}개`);
  if (partCoverage < 0.95) notes.push(`파트 내부 커버리지 ${(partCoverage * 100).toFixed(1)}% — 닫히지 않은 라인 의심`);
  {
    let tex = 0;
    for (const v of vectors.values()) tex = Math.max(tex, v.stats.textureRatio ?? 0);
    if (tex > 0.005) {
      notes.push(
        `해프톤 질감을 톤 면으로 치환 — 화면의 ${(tex * 100).toFixed(1)}%, 도면 잉크의 ${(textureShare * 100).toFixed(0)}%. ` +
        `전체 F@2px ${fid.f.f2.toFixed(3)}, 이 영역을 뺀 선 충실도 ${fidLine.f.f2.toFixed(3)}`,
      );
    }
  }

  const pass =
    fidLine.f.f2 >= 0.9 &&
    fidLine.f.f1 >= 0.8 &&
    detail.recall >= 0.85 &&
    invalid === 0 &&
    emptyVisibleParts.length === 0 &&
    partCoverage >= 0.95;

  return {
    pass,
    silhouetteIou: +silhouetteIou.toFixed(4),
    boundaryF: fid.f.f2,
    rawF0: fid.f.f0,
    rawF1: fid.f.f1,
    rawF2: fid.f.f2,
    lineF1: fidLine.f.f1,
    lineF2: fidLine.f.f2,
    textureShare: +textureShare.toFixed(4),
    inkRatio: fidLine.inkRatio,
    chamfer: fidLine.chamfer,
    p95: fidLine.p95,
    detailRecall: detail.recall,
    majorComponents: [topo.refMajor, topo.vecMajor],
    aspectRatio: +ctx.aspectRatio.toFixed(3),
    partCoverage: +partCoverage.toFixed(4),
    perPart,
    partPrecision: +partPrecision.toFixed(4),
    misassignedParts: misassigned,
    emptyVisibleParts,
    sharedOnlyParts,
    invalidPaths: invalid,
    totalPaths,
    totalNodes,
    fileKb: +(Buffer.byteLength(svg) / 1024).toFixed(1),
    notes,
  };
}
