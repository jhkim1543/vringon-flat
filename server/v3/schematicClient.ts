/**
 * VRINGON 플랫 스케치(schematic) 생성 어댑터.
 *
 * 사내 워커 `generate_schematic_image`의 레시피를 그대로 재현한다.
 * (RebuilderAI/vringon-ai-workers-services → src/services/features/generate_schematic_image)
 *
 *   입력 → 1024×1024 stretch resize(bilinear, divisible_by 2)
 *        → qwen-image-edit i2i + 사내 schematic LoRA(strength 1.2)
 *          prompt = 카테고리별 베이크 프롬프트, seed = 484861632801927
 *        → 원본 해상도로 stretch resize back(divisible_by 1)
 *
 * 백엔드 3종. 계약은 동일하므로 접근 가능한 것으로 env만 바꾸면 된다.
 *
 *  1. `vringon`   — 사내 엔드포인트 `POST /v2/edit/generate_schematic_image`
 *                   (Server-Vringon-Lib의 SchematicClient와 같은 계약:
 *                    {category, image, is_grayscale} → jobId → 폴링)
 *  2. `replicate` — `qwen/qwen-image-edit-2511` + 공개 LoRA URL.
 *                   워커가 실제로 도는 경로(common.qwen-image-edit 'auto' provider)와 같다.
 *  3. `fal`       — fal의 qwen-image-edit 계열 + 같은 LoRA.
 *
 * LoRA는 공개 버킷에 있어 별도 배포가 필요 없다(실측: HTTP 200).
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { config } from "../config.js";
import { withRetry } from "../clients/retry.js";

// ── 워커에서 그대로 가져온 상수 (pipeline_constants.py) ──────

/** #211 카테고리별 베이크 프롬프트 */
export const CATEGORY_PROMPTS: Record<string, string> = {
  shoe: "convert this shoe to a schematic",
  bag: "convert this bag to a schematic",
  jewelry: "convert this ornament to a schematic",
};
export const DEFAULT_PROMPT = "Create a schematic";

export function resolvePrompt(category: string): string {
  return CATEGORY_PROMPTS[category] ?? DEFAULT_PROMPT;
}

/** #191 생성측 작업 해상도 */
export const QWEN_INPUT_SIZE = 1024;
export const QWEN_INPUT_DIVISIBLE_BY = 2;
export const OUTPUT_DIVISIBLE_BY = 1;
/** #192 KSampler 고정 시드 */
export const SAMPLER_SEED = 484861632801927;
/** #124 Lora Loader Stack slot 1 */
export const LORA_NAME = "sbj_qwen_image_edit_schematic_20260213.safetensors";
export const LORA_STRENGTH = 1.2;
export const DEFAULT_LORA_URL =
  `https://vringon-ai-lora-public.s3.ap-northeast-2.amazonaws.com/${LORA_NAME}`;

/** 워커 contract.py가 받는 카테고리 */
export const SCHEMATIC_CATEGORIES = [
  "shoe", "bag", "top", "bottom", "outer", "jewelry", "glasses", "cosmetic",
] as const;
export type SchematicCategory = (typeof SCHEMATIC_CATEGORIES)[number];

export type SchematicBackend = "vringon" | "replicate" | "fal";

export interface SchematicOptions {
  category: string;
  /** true면 모노톤 도식, false면 컬러 플랫 (사내 Lib의 is_grayscale와 같은 의미) */
  grayscale: boolean;
  /** 후보 다양화용. 미지정이면 워커와 동일한 고정 시드 */
  seed?: number;
  loraScale?: number;
}

export interface SchematicResult {
  pngPath: string;
  backend: SchematicBackend;
  prompt: string;
  seed: number | null;
  loraUrl: string | null;
  loraScale: number;
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
 * 한 장을 도식화한다. 결과는 원본과 같은 크기의 PNG.
 *
 * 캐시 키는 입력 해시 + 프롬프트 + 시드 + LoRA + 백엔드다.
 * 같은 파트를 여러 번 시도해도 재과금되지 않는다.
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
  const prompt = resolvePrompt(opts.category);
  const seed = opts.seed ?? SAMPLER_SEED;
  const loraScale = opts.loraScale ?? LORA_STRENGTH;
  const loraUrl = config.schematicLoraUrl || DEFAULT_LORA_URL;

  const src = await fs.readFile(imagePath);
  const key = crypto
    .createHash("sha256")
    .update(src)
    .update(JSON.stringify({ prompt, seed, loraScale, loraUrl, backend, gray: opts.grayscale }))
    .digest("hex")
    .slice(0, 16);
  const dest = path.join(outDir, `schematic_${key}.png`);
  try {
    await fs.access(dest);
    return { pngPath: dest, backend, prompt, seed, loraUrl, loraScale, cached: true, ms: 0 };
  } catch { /* 캐시 미스 */ }

  // 원본 크기 기억 (#213 GetImageSize+)
  const meta = await sharp(src).metadata();
  const origW = meta.width!, origH = meta.height!;

  // #191 stretch resize → 1024×1024 (divisible_by 2)
  const sized = divisible(QWEN_INPUT_SIZE, QWEN_INPUT_DIVISIBLE_BY);
  const resized = await sharp(src)
    .flatten({ background: "#ffffff" })
    .resize(sized, sized, { fit: "fill", kernel: "cubic" })
    .png()
    .toBuffer();

  onProgress?.(`schematic(${backend}) ${opts.category}${opts.grayscale ? "/gray" : "/color"} seed=${seed}`);

  let outPng: Buffer;
  switch (backend) {
    case "vringon":
      outPng = await callVringon(resized, opts, onProgress);
      break;
    case "replicate":
      outPng = await callReplicate(resized, prompt, seed, loraUrl, loraScale);
      break;
    case "fal":
      outPng = await callFal(resized, prompt, seed, loraUrl, loraScale);
      break;
  }

  // #214 원본 해상도로 되돌린다 (divisible_by 1)
  await sharp(outPng)
    .resize(divisible(origW, OUTPUT_DIVISIBLE_BY), divisible(origH, OUTPUT_DIVISIBLE_BY), {
      fit: "fill",
      kernel: "cubic",
    })
    .png()
    .toFile(dest);

  return { pngPath: dest, backend, prompt, seed, loraUrl, loraScale, cached: false, ms: Date.now() - t0 };
}

const divisible = (v: number, by: number) => (by <= 1 ? v : Math.max(by, Math.round(v / by) * by));

// ── 백엔드 1: 사내 워커 ──────────────────────────────────────

/**
 * Server-Vringon-Lib의 SchematicClient와 같은 계약.
 *   POST /v2/edit/generate_schematic_image  {category, image, is_grayscale} → {jobId}
 *   GET  /v2/generate_schematic_image/{jobId} → {status, imageUrl, svgUrl}
 *
 * image는 워커가 받을 수 있는 형태여야 한다. 공개 URL을 못 주는 환경을 위해
 * data URI를 먼저 시도하고, 거부되면 VRINGON_SCHEMATIC_UPLOAD로 올린 URL을 쓴다.
 */
async function callVringon(
  resized: Buffer,
  opts: SchematicOptions,
  onProgress?: (m: string) => void,
): Promise<Buffer> {
  const base = config.vringonSchematicUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.vringonSchematicAuth) headers.Authorization = config.vringonSchematicAuth;

  const body = {
    category: normalizeCategory(opts.category),
    image: `data:image/png;base64,${resized.toString("base64")}`,
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

  // 폴링 — 워커는 GPU 큐를 타므로 수십 초 걸린다
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await fetch(`${base}/v2/generate_schematic_image/${jobId}`, { headers });
    if (!st.ok) continue;
    const j = (await st.json()) as { status?: string; imageUrl?: string; image_url?: string; details?: string };
    const status = (j.status ?? "").toUpperCase();
    const url = j.imageUrl ?? j.image_url;
    if (url) return Buffer.from(await (await fetch(url)).arrayBuffer());
    if (status.includes("FAIL") || status.includes("ERROR")) throw new Error(`vringon schematic 실패: ${j.details ?? status}`);
    if (i % 10 === 9) onProgress?.(`  대기 ${(i + 1) * 3}s (${status || "…"})`);
  }
  throw new Error("vringon schematic: 폴링 시간 초과");
}

/** 워커 contract가 받는 카테고리로 정규화 */
export function normalizeCategory(c: string): SchematicCategory {
  const s = c.toLowerCase();
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

// ── 백엔드 2: Replicate (워커가 실제로 도는 경로) ────────────

async function callReplicate(
  resized: Buffer,
  prompt: string,
  seed: number,
  loraUrl: string,
  loraScale: number,
): Promise<Buffer> {
  const token = config.replicateToken;
  const model = config.replicateQwenModel; // 기본 qwen/qwen-image-edit-2511
  const input: Record<string, unknown> = {
    prompt,
    image: `data:image/png;base64,${resized.toString("base64")}`,
    output_format: "png",
    seed,
  };
  if (loraUrl) {
    input.lora_weights = loraUrl;
    input.lora_scale = loraScale;
  }

  const created = await withRetry(
    async () => {
      const r = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
        body: JSON.stringify({ input }),
      });
      if (!r.ok) throw new Error(`replicate ${r.status}: ${(await r.text()).slice(0, 300)}`);
      return r.json() as Promise<{ status: string; output?: unknown; urls?: { get: string }; error?: string }>;
    },
    { label: "replicate-qwen" },
  );

  let pred = created;
  for (let i = 0; i < 120 && pred.status !== "succeeded"; i++) {
    if (pred.status === "failed" || pred.status === "canceled")
      throw new Error(`replicate 실패: ${pred.error ?? pred.status}`);
    await new Promise((r) => setTimeout(r, 2000));
    const r = await fetch(pred.urls!.get, { headers: { Authorization: `Bearer ${token}` } });
    pred = (await r.json()) as typeof pred;
  }
  const url = firstUrl(pred.output);
  if (!url) throw new Error("replicate: 출력 URL 없음");
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

// ── 백엔드 3: fal ───────────────────────────────────────────

async function callFal(
  resized: Buffer,
  prompt: string,
  seed: number,
  loraUrl: string,
  loraScale: number,
): Promise<Buffer> {
  const model = config.falQwenEditModel;
  const payload: Record<string, unknown> = {
    prompt,
    image_url: `data:image/png;base64,${resized.toString("base64")}`,
    num_images: 1,
    output_format: "png",
    seed,
  };
  if (loraUrl) payload.loras = [{ path: loraUrl, scale: loraScale }];

  const j = await withRetry(
    async () => {
      const r = await fetch(`https://fal.run/${model}`, {
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
