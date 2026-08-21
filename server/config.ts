import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env") });

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export const config = {
  root: ROOT,
  outputsDir: path.join(ROOT, "outputs"),
  apiPort: Number(env("API_PORT", "5201")),
  version: "1.0.0",

  // ── 공개 API 운영 설정 ────────────────────────────────────
  /** 콤마로 구분한 API 키 목록. 비어 있으면 인증 없이 열린다(로컬 개발용) */
  apiKeys: env("API_KEYS").split(",").map((s) => s.trim()).filter(Boolean),
  /** 동시에 돌릴 잡 수. 외부 모델 레이트리밋·비용 때문에 낮게 잡는다 */
  maxConcurrentJobs: Number(env("MAX_CONCURRENT_JOBS", "2")),
  maxUploadMb: Number(env("MAX_UPLOAD_MB", "30")),
  /** 콤마로 구분한 허용 오리진. 비어 있으면 모두 허용 */
  corsOrigins: env("CORS_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean),

  openaiKey: env("OPENAI_API_KEY"),
  geminiKey: env("GEMINI_API_KEY"),
  falKey: env("FAL_KEY"),
  vectorizerId: env("VECTORIZER_API_ID"),
  vectorizerSecret: env("VECTORIZER_API_SECRET"),
  adobeClientId: env("ADOBE_CLIENT_ID"),
  adobeClientSecret: env("ADOBE_CLIENT_SECRET"),

  openaiModel: env("OPENAI_MODEL", "gpt-5.6"),
  openaiImageModel: env("OPENAI_IMAGE_MODEL", "gpt-image-2"),
  geminiImageModel: env("GEMINI_IMAGE_MODEL", "gemini-3-pro-image"),
  // segmentation mask 페인팅은 2.5 세대 기능 — 3.x flash는 빈 마스크를 반환함
  geminiVisionModel: env("GEMINI_VISION_MODEL", "gemini-2.5-flash"),
  geminiImageSize: env("GEMINI_IMAGE_SIZE", "2K"),

  candidatesPerModel: Number(env("CANDIDATES_PER_MODEL", "2")),
  /** Adobe Image Trace는 공개 URL 입력만 받는다 (localhost 불가) */
  publicBaseUrl: env("PUBLIC_BASE_URL"),
  /**
   * 선 레이어 패스 상한 (폭주 방지용 안전장치).
   * 낮추면 Illustrator가 가벼워지지만 선 충실도가 떨어진다 — 실측: 600으로
   * 두었을 때 메시 가방 선 충실도가 IoU 44.7%까지 하락했다.
   */
  lineBudget: Number(env("LINE_BUDGET", "20000")),
  /**
   * 질감 억제 임계 — 제품 최소변 대비 이 비율보다 짧은 선은 버린다.
   * 0.006(기본에 가까운 값)이면 질감이 거의 다 남고, 0.04면 구조선만 남는다.
   * 테크팩은 질감을 그리지 않으므로 기본을 크게 잡았다.
   */
  textureMinLen: Number(env("TEXTURE_MIN_LEN", "0.035")),
  // ── V3 (VRINGON 플랫스케치 기반) ─────────────────────────
  /**
   * 사내 schematic 워커 엔드포인트 (Server-Vringon-Lib의 client.schematic.host와 같은 것).
   * POST {url}/v2/edit/generate_schematic_image, GET {url}/v2/generate_schematic_image/{jobId}
   */
  vringonSchematicUrl: env("VRINGON_SCHEMATIC_URL"),
  vringonSchematicAuth: env("VRINGON_SCHEMATIC_AUTH"),
  /**
   * 사내 schematic LoRA. 공개 버킷에 있어 그대로 쓸 수 있다(실측: HTTP 200).
   * 워커의 GENERATE_SCHEMATIC_IMAGE_QWEN_LORA_WEIGHTS와 같은 값.
   */
  schematicLoraUrl: env(
    "SCHEMATIC_LORA_URL",
    "https://vringon-ai-lora-public.s3.ap-northeast-2.amazonaws.com/sbj_qwen_image_edit_schematic_20260213.safetensors",
  ),
  /** Replicate — 워커의 common.qwen-image-edit가 실제로 도는 경로 */
  replicateToken: env("REPLICATE_API_TOKEN"),
  replicateQwenModel: env("REPLICATE_QWEN_MODEL", "qwen/qwen-image-edit-2511"),
  /** 컬러 도식용 컬러화 모델 (워커의 common.image-edit 경로) */
  replicateColorizeModel: env("REPLICATE_COLORIZE_MODEL", "google/nano-banana"),
  /** 업스케일 (워커의 common.upscale 경로). 실패는 무시된다 */
  replicateUpscaleModel: env("REPLICATE_UPSCALE_MODEL", "prunaai/p-image-upscale"),
  /** fal 대체 경로 */
  falQwenEditModel: env("FAL_QWEN_EDIT_MODEL", "fal-ai/qwen-image-edit-plus-lora"),

  // ── V2 (레이어 분리 벡터 SVG) ────────────────────────────
  /**
   * 자체 호스팅 Qwen-Image-Layered-Control 엔드포인트.
   * 개발계획서 §17.1: 이 모델은 공개 inference provider가 없어 자체 호스팅이 전제다
   * (80GB급 GPU 1장 권장). 설정하면 레이어별 프롬프트 추출 경로로 전환되고,
   * 없으면 fal의 qwen-image-layered로 같은 계약을 채운다.
   */
  qwenLayeredControlUrl: env("QWEN_LC_URL"),
  qwenLayeredControlKey: env("QWEN_LC_KEY"),
  qwenModelRevision: env("QWEN_MODEL_REVISION"),

  /** Vectorizer.AI는 품질 문제로 기본 비활성 — 1로 두면 강제 사용 */
  forceVectorizerAI: env("VECTORIZER_FORCE") === "1",

  get hasSam3() {
    return !!this.falKey;
  },
  get hasVectorizerAI() {
    return !!(this.vectorizerId && this.vectorizerSecret);
  },
  get hasAdobe() {
    return !!(this.adobeClientId && this.adobeClientSecret);
  },
};

export function assertBaseKeys() {
  const missing: string[] = [];
  if (!config.openaiKey) missing.push("OPENAI_API_KEY");
  if (!config.geminiKey) missing.push("GEMINI_API_KEY");
  if (missing.length)
    throw new Error(`.env에 키가 없습니다: ${missing.join(", ")}`);
}
