/**
 * VRINGON 플랫 스케치(schematic) 생성 어댑터 — **qa 브랜치 구현을 그대로 재현**한다.
 * (RebuilderAI/vringon-ai-workers-services @ qa → generate_schematic_image/handler.py)
 *
 * 워커의 파이프라인 형태:
 *
 *   image → load(#209/#210) → 원본 크기 기록(#213)
 *         → 1024×1024 stretch(#191, bilinear, divisible_by 2)
 *         → common.qwen-image-edit 1회 (schematic LoRA i2i, 카테고리 프롬프트, 고정 시드)
 *         → 원본 크기로 stretch back(#214, divisible_by 1) → PNG 저장(#212)
 *         → [is_grayscale=false] nano-banana 컬러화 (Image1=도식, Image2=원본) → 종횡비 복원
 *         → 업스케일 (흑백·컬러 공통, 실패는 무시)
 *         → vtracer로 SVG (mono=binary / color=color)
 *
 * `is_grayscale`는 그래프에 들어가지 않는다 — **후처리 단계를 고르는 스위치**다.
 * 그래프 자체는 언제나 모노톤 선화만 만든다.
 *
 * 백엔드 3종. 계약이 같으므로 접근 가능한 것으로 env만 바꾸면 된다.
 *  1. `vringon`   — 사내 엔드포인트 `/v2/edit/generate_schematic_image` (Lib의 SchematicClient와 동일)
 *  2. `replicate` — 공통 워커가 실제로 도는 경로를 직접 호출 (qwen-image-edit / nano-banana / p-image-upscale)
 *  3. `fal`       — fal의 qwen-image-edit 계열 (컬러화·업스케일은 미지원 → 모노톤만)
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { config } from "../config.js";
import { withRetry } from "../clients/retry.js";
import {
  COLORIZE_MODEL, COLOR_SKETCH_ASPECT_RATIO, COLOR_SKETCH_PROMPT,
  DEFAULT_LORA_URL, LORA_STRENGTH, OUTPUT_DIVISIBLE_BY,
  QWEN_INPUT_DIVISIBLE_BY, QWEN_INPUT_SIZE, SAMPLER_SEED,
  QWEN_GO_FAST, QWEN_OUTPUT_QUALITY,
  UPSCALE_FACTOR, UPSCALE_MODE, UPSCALE_MODEL, UPSCALE_OUTPUT_QUALITY, UPSCALE_TARGET,
  resolvePrompt, type SchematicCategory,
} from "./schematicConstants.js";

export * from "./schematicConstants.js";

export type SchematicBackend = "vringon" | "replicate" | "fal";

export interface SchematicOptions {
  category: string;
  /** true면 모노톤 도식(기본). false면 컬러화 호출이 추가로 붙는다 */
  grayscale: boolean;
  /** 후보 다양화용. 미지정이면 워커와 동일한 고정 시드 */
  seed?: number;
  loraScale?: number;
  /** 업스케일 단계를 돌릴 것인가 (워커 기본은 켬, 실패는 무시) */
  upscale?: boolean;
  /**
   * 워커와 **픽셀 단위로 같은** 산출물이 필요할 때 켠다. 기본은 꺼짐 — 종횡비만 되돌리고
   * 해상도는 모델 캔버스(1024) 아래로 내리지 않는다. 이유는 #214 복원 단계의 주석 참조.
   */
  matchWorkerResolution?: boolean;
}

export interface SchematicResult {
  pngPath: string;
  /**
   * 컬러 모드에서 컬러화 **직전**의 모노톤 도식. 컬러 도식은 선이 색면과 같은 검정이라
   * 밝기 임계로 선을 못 뽑는다(실측: 검정 가방 컬러 도식 → 패스 6개, 실루엣 IoU 0.002).
   * 컬러화는 모노 도식의 선을 그대로 보존하도록 프롬프트돼 있으므로, **기하는 모노에서
   * 뽑고 색만 컬러본에서 샘플링**하면 둘 다 살아난다.
   */
  monoPath?: string;
  backend: SchematicBackend;
  prompt: string;
  seed: number | null;
  loraUrl: string | null;
  loraScale: number;
  /** 실제로 거친 단계 — 재현·과금 추적용 */
  stages: string[];
  cached: boolean;
  ms: number;
}

export function activeBackend(): SchematicBackend | null {
  if (config.vringonSchematicUrl) return "vringon";
  if (config.replicateToken) return "replicate";
  if (config.falKey) return "fal";
  return null;
}

/**
 * 워커의 RESIZE_UPSCALE_METHOD="bilinear"에 대응하는 커널.
 * sharp 런타임에는 "linear"(=bilinear)가 있지만 타입 정의에 빠져 있어 캐스팅한다.
 * mitchell 등으로 바꾸면 리샘플 특성이 달라져 선 굵기가 미묘하게 어긋난다.
 */
const BILINEAR = "linear" as unknown as keyof import("sharp").KernelEnum;

const divisible = (v: number, by: number) => (by <= 1 ? Math.round(v) : Math.max(by, Math.round(v / by) * by));

/**
 * 한 장을 도식화한다. 결과는 원본과 같은 크기의 PNG.
 * 캐시 키 = 입력 해시 + 프롬프트 + 시드 + LoRA + 백엔드 + 컬러 여부.
 */
export async function generateSchematic(
  imagePath: string,
  outDir: string,
  opts: SchematicOptions,
  onProgress?: (m: string) => void,
): Promise<SchematicResult> {
  const t0 = Date.now();
  const backend = activeBackend();
  if (!backend) {
    throw new Error(
      "schematic 백엔드가 없습니다. VRINGON_SCHEMATIC_URL / REPLICATE_API_TOKEN / FAL_KEY 중 하나를 설정하세요",
    );
  }

  await fs.mkdir(outDir, { recursive: true });
  const prompt = resolvePrompt(normalizeCategory(opts.category));
  const seed = opts.seed ?? SAMPLER_SEED;
  const loraScale = opts.loraScale ?? LORA_STRENGTH;
  const loraUrl = config.schematicLoraUrl || DEFAULT_LORA_URL;
  const wantUpscale = opts.upscale ?? true;

  const src = await fs.readFile(imagePath);
  const key = crypto
    .createHash("sha256")
    .update(src)
    .update(JSON.stringify({ prompt, seed, loraScale, loraUrl, backend, gray: opts.grayscale, up: wantUpscale, native: !opts.matchWorkerResolution }))
    .digest("hex")
    .slice(0, 16);
  const dest = path.join(outDir, `schematic_${key}.png`);
  const monoDest = path.join(outDir, `schematic_${key}.mono.png`);
  const monoIfExists = async (): Promise<string | undefined> => {
    try { await fs.access(monoDest); return monoDest; } catch { return undefined; }
  };
  try {
    await fs.access(dest);
    return {
      pngPath: dest, monoPath: await monoIfExists(), backend, prompt, seed, loraUrl, loraScale,
      stages: ["cached"], cached: true, ms: 0,
    };
  } catch { /* 캐시 미스 */ }

  // #213 원본 크기
  const meta = await sharp(src).metadata();
  const origW = meta.width!, origH = meta.height!;
  const stages: string[] = [];
  let monoOut: string | undefined;

  // 사내 워커는 전 단계를 자기가 돈다 — 우리가 나눌 필요가 없다
  if (backend === "vringon") {
    const png = await callVringon(src, opts, onProgress);
    await sharp(png).png().toFile(dest);
    stages.push("vringon:all");
    return { pngPath: dest, backend, prompt, seed, loraUrl, loraScale, stages, cached: false, ms: Date.now() - t0 };
  }

  // #191 stretch → 1024×1024 (bilinear)
  const sized = divisible(QWEN_INPUT_SIZE, QWEN_INPUT_DIVISIBLE_BY);
  const qwenInput = await sharp(src)
    .flatten({ background: "#ffffff" })
    .resize(sized, sized, { fit: "fill", kernel: BILINEAR })
    .png()
    .toBuffer();

  onProgress?.(`schematic(${backend}) ${normalizeCategory(opts.category)}${opts.grayscale ? "/mono" : "/color"} seed=${seed}`);

  // 도식 생성 (그래프는 언제나 모노톤)
  let current =
    backend === "replicate"
      ? await replicateQwenEdit(qwenInput, prompt, seed, loraUrl, loraScale)
      : await falQwenEdit(qwenInput, prompt, seed, loraUrl, loraScale);
  stages.push(`${backend}:qwen-image-edit`);

  // #214 종횡비 복원.
  //
  // 워커는 정확히 origW×origH로 되돌린다. 그런데 우리 쪽은 이 그림을 **벡터화**하므로
  // 그대로 따라 하면 모델이 1024²에 그린 획을 그 자리에서 버리게 된다 — 사진 크롭이 작을수록
  // 손해가 크다(bag_1은 304×433이라 모델 픽셀의 12.6%만 남는다. 같은 도면을 0.297배로 내려
  // 벡터화하면 면 -86% · 노드 -77% · 잉크 F1 -0.076).
  //
  // 그래서 **종횡비만 되돌리고 해상도는 모델 캔버스 아래로 내리지 않는다**. 늘리는 것이
  // 아니라 덜 줄이는 것이므로 새 정보를 지어내지 않는다. 워커와 픽셀 단위로 같은 산출물이
  // 필요하면 `matchWorkerResolution: true`로 예전 동작을 그대로 쓴다.
  {
    const long = Math.max(origW, origH);
    const keep = opts.matchWorkerResolution ? 1 : Math.max(1, QWEN_INPUT_SIZE / long);
    current = await sharp(current)
      .resize(
        divisible(Math.round(origW * keep), OUTPUT_DIVISIBLE_BY),
        divisible(Math.round(origH * keep), OUTPUT_DIVISIBLE_BY),
        { fit: "fill", kernel: BILINEAR },
      )
      .png()
      .toBuffer();
  }

  // 컬러 분기 — 모노톤 도식 + 원본 사진을 nano-banana에 넘긴다
  if (!opts.grayscale) {
    if (backend !== "replicate") {
      onProgress?.("컬러화는 Replicate 경로에서만 지원됩니다 — 모노톤으로 진행");
    } else {
      onProgress?.("nano-banana 컬러화");
      await sharp(current).png().toFile(monoDest);
      monoOut = monoDest;
      const colorized = await replicateColorize(current, src);
      // nano-banana는 aspect_ratio를 강제해 비정방 입력이 정방으로 눌린다.
      // 워커와 같게, 가로폭은 두고 세로만 원본 비율로 되돌린다(해상도 손실 방지).
      const cm = await sharp(colorized).metadata();
      const targetH = Math.max(1, Math.round((cm.width! * origH) / origW));
      current =
        targetH === cm.height!
          ? colorized
          : await sharp(colorized)
              .resize(cm.width!, divisible(targetH, OUTPUT_DIVISIBLE_BY), { fit: "fill", kernel: BILINEAR })
              .png()
              .toBuffer();
      stages.push("replicate:nano-banana");
    }
  }

  // 업스케일 — 흑백·컬러 공통. 실패해도 잡을 죽이지 않는다(레거시 copy fallback).
  if (wantUpscale && backend === "replicate") {
    try {
      onProgress?.("업스케일");
      current = await replicateUpscale(current);
      stages.push("replicate:p-image-upscale");
    } catch (e) {
      onProgress?.(`업스케일 실패 — 원본 유지 (${(e as Error).message.slice(0, 60)})`);
    }
  }

  await sharp(current).png().toFile(dest);
  return {
    pngPath: dest, monoPath: monoOut, backend, prompt, seed, loraUrl, loraScale,
    stages, cached: false, ms: Date.now() - t0,
  };
}

/** 워커 contract가 받는 카테고리로 정규화 */
export function normalizeCategory(c: string): SchematicCategory {
  const s = (c ?? "").toLowerCase();
  if (s.includes("shoe") || s.includes("footwear") || s.includes("sneaker")) return "shoe";
  if (s.includes("bag") || s.includes("purse") || s.includes("backpack")) return "bag";
  if (s.includes("jewel") || s.includes("ring") || s.includes("earring") || s.includes("necklace")) return "jewelry";
  if (s.includes("glass") || s.includes("eyewear")) return "glasses";
  if (s.includes("cosmetic")) return "cosmetic";
  if (s.includes("outer") || s.includes("coat") || s.includes("jacket")) return "outer";
  if (s.includes("bottom") || s.includes("pants") || s.includes("skirt")) return "bottom";
  if (s.includes("top") || s.includes("shirt") || s.includes("apparel")) return "top";
  return "shoe";
}

// ── 백엔드 1: 사내 워커 ──────────────────────────────────────

async function callVringon(
  src: Buffer,
  opts: SchematicOptions,
  onProgress?: (m: string) => void,
): Promise<Buffer> {
  const base = config.vringonSchematicUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.vringonSchematicAuth) headers.Authorization = config.vringonSchematicAuth;

  const body = {
    category: normalizeCategory(opts.category),
    image: `data:image/png;base64,${src.toString("base64")}`,
    is_grayscale: opts.grayscale,
  };

  const submit = await withRetry(
    async () => {
      const r = await fetch(`${base}/v2/edit/generate_schematic_image`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`vringon schematic ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<{ jobId?: string; job_id?: string }>;
    },
    { label: "vringon-schematic" },
  );
  const jobId = submit.jobId ?? submit.job_id;
  if (!jobId) throw new Error("vringon schematic: jobId 없음");

  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await fetch(`${base}/v2/generate_schematic_image/${jobId}`, { headers });
    if (!st.ok) continue;
    const j = (await st.json()) as { status?: string; image_url?: string; imageUrl?: string; details?: string };
    const url = j.image_url ?? j.imageUrl;
    if (url) return Buffer.from(await (await fetch(url)).arrayBuffer());
    const status = (j.status ?? "").toUpperCase();
    if (status.includes("FAIL") || status.includes("ERROR")) throw new Error(`vringon schematic 실패: ${j.details ?? status}`);
    if (i % 10 === 9) onProgress?.(`  대기 ${(i + 1) * 3}s (${status || "…"})`);
  }
  throw new Error("vringon schematic: 폴링 시간 초과");
}

// ── 백엔드 2: Replicate (공통 워커가 실제로 도는 경로) ───────

async function replicateRun(model: string, input: Record<string, unknown>): Promise<Buffer> {
  const token = config.replicateToken;
  const created = await withRetry(
    async () => {
      const r = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "wait" },
        body: JSON.stringify({ input }),
      });
      if (!r.ok) throw new Error(`replicate ${model} ${r.status}: ${(await r.text()).slice(0, 300)}`);
      return r.json() as Promise<{ status: string; output?: unknown; urls?: { get: string }; error?: string }>;
    },
    { label: `replicate:${model}` },
  );

  let pred = created;
  for (let i = 0; i < 150 && pred.status !== "succeeded"; i++) {
    if (pred.status === "failed" || pred.status === "canceled")
      throw new Error(`replicate ${model} 실패: ${pred.error ?? pred.status}`);
    await new Promise((r) => setTimeout(r, 2000));
    const r = await fetch(pred.urls!.get, { headers: { Authorization: `Bearer ${token}` } });
    pred = (await r.json()) as typeof pred;
  }
  const url = firstUrl(pred.output);
  if (!url) throw new Error(`replicate ${model}: 출력 URL 없음`);
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

const dataUri = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;

/**
 * common.qwen-image-edit → Replicate `qwen/qwen-image-edit-2511`.
 *
 * 페이로드는 사내 provider의 `_qwen_image_edit_2511_input()`을 그대로 따른다.
 * 주의할 점 둘:
 *  · **`image`는 배열이다.** 문자열 하나를 주면 스키마가 맞지 않는다
 *    (provider의 `_qwen_image_sources()`가 input_image/reference_images를 모아 리스트로 넘긴다).
 *  · `go_fast`는 capability contract의 기본값이 true라 그대로 전달된다(fp8 양자화 경로).
 *    schematic 워커가 따로 끄지 않으므로 운영도 true다.
 * `mode`/`normal_mode`는 provider 내부에서 프롬프트·이미지 조립에만 쓰이고
 * Replicate로는 넘어가지 않으므로 여기서는 보내지 않는다.
 */
async function replicateQwenEdit(
  image: Buffer,
  prompt: string,
  seed: number,
  loraUrl: string,
  loraScale: number,
): Promise<Buffer> {
  const input: Record<string, unknown> = {
    prompt,
    image: [dataUri(image)],
    go_fast: QWEN_GO_FAST,
    seed,
    disable_safety_checker: false,
    output_format: "png",
    output_quality: QWEN_OUTPUT_QUALITY,
  };
  if (loraUrl) {
    input.lora_weights = loraUrl;
    input.lora_scale = loraScale;
  }
  return replicateRun(config.replicateQwenModel, input);
}

/**
 * common.image-edit — nano-banana 컬러화.
 * 프롬프트가 Image 1(구조) / Image 2(색)를 **순서로** 참조하므로 도식이 먼저, 원본이 뒤.
 */
async function replicateColorize(schematic: Buffer, original: Buffer): Promise<Buffer> {
  return replicateRun(config.replicateColorizeModel || COLORIZE_MODEL, {
    prompt: COLOR_SKETCH_PROMPT,
    image_input: [dataUri(schematic), dataUri(original)],
    aspect_ratio: COLOR_SKETCH_ASPECT_RATIO,
    output_format: "png",
  });
}

/** common.upscale — target=4는 배율이 아니라 목표 4메가픽셀 */
async function replicateUpscale(image: Buffer): Promise<Buffer> {
  return replicateRun(config.replicateUpscaleModel || UPSCALE_MODEL, {
    image: dataUri(image),
    upscale_mode: UPSCALE_MODE,
    target: UPSCALE_TARGET,
    factor: UPSCALE_FACTOR,
    enhance_details: false,
    enhance_realism: false,
    output_format: "png",
    output_quality: UPSCALE_OUTPUT_QUALITY,
    no_op: false,
  });
}

// ── 백엔드 3: fal (모노톤만) ────────────────────────────────

async function falQwenEdit(
  image: Buffer,
  prompt: string,
  seed: number,
  loraUrl: string,
  loraScale: number,
): Promise<Buffer> {
  const payload: Record<string, unknown> = {
    prompt,
    image_url: dataUri(image),
    num_images: 1,
    output_format: "png",
    seed,
  };
  if (loraUrl) payload.loras = [{ path: loraUrl, scale: loraScale }];

  const j = await withRetry(
    async () => {
      const r = await fetch(`https://fal.run/${config.falQwenEditModel}`, {
        method: "POST",
        headers: { Authorization: `Key ${config.falKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`fal ${r.status}: ${(await r.text()).slice(0, 250)}`);
      return r.json() as Promise<{ images?: { url: string }[]; image?: { url: string } }>;
    },
    { label: "fal-qwen-edit" },
  );
  const url = j.images?.[0]?.url ?? j.image?.url;
  if (!url) throw new Error("fal: 출력 URL 없음");
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

function firstUrl(out: unknown): string | null {
  if (typeof out === "string") return out;
  if (Array.isArray(out)) {
    for (const o of out) {
      const u = firstUrl(o);
      if (u) return u;
    }
  }
  if (out && typeof out === "object" && "url" in out) return String((out as { url: string }).url);
  return null;
}
