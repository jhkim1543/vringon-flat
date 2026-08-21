/**
 * VRINGON `generate_schematic_image` 워커의 베이크 상수 — **qa 브랜치 기준**.
 * (RebuilderAI/vringon-ai-workers-services @ qa → src/services/features/generate_schematic_image)
 *
 * 워커의 `src/pipeline_constants.py`를 그대로 옮긴다. 문구·수치를 요약하거나 다듬으면
 * 산출물이 달라지므로 한 글자도 바꾸지 않는다.
 */

/**
 * viewpoint 절 — VO-55, ai-worker-comfyui `feadf69`에서 추가됐다.
 * 이게 없으면 모델이 입력을 **다시 포즈 잡아** 같은 제품의 각 뷰가 다른 각도로 돌아온다.
 * (그래프 JSON 포팅본에는 빠져 있었고 qa에서 복구됐다)
 */
export const VIEWPOINT_CLAUSE =
  ", preserve the exact same viewpoint and orientation as the input photo";

/** #211 카테고리별 베이크 프롬프트 */
export const CATEGORY_PROMPTS: Record<string, string> = {
  shoe: `convert this shoe to a schematic${VIEWPOINT_CLAUSE}`,
  bag: `convert this bag to a schematic${VIEWPOINT_CLAUSE}`,
  jewelry: `convert this ornament to a schematic${VIEWPOINT_CLAUSE}`,
};
export const DEFAULT_PROMPT = "Create a schematic";

export function resolvePrompt(category: string): string {
  return CATEGORY_PROMPTS[category] ?? DEFAULT_PROMPT;
}

/** #191 생성측 작업 해상도 / #214 복원 */
export const QWEN_INPUT_SIZE = 1024;
export const QWEN_INPUT_DIVISIBLE_BY = 2;
export const OUTPUT_DIVISIBLE_BY = 1;
/** 워커는 bilinear를 쓴다 — cubic으로 바꾸면 선 굵기가 미묘하게 달라진다 */
export const RESIZE_UPSCALE_METHOD = "bilinear" as const;

/**
 * capability contract(QwenImageEditRequest)의 기본값. schematic 워커가 끄지 않으므로
 * 운영도 이 값으로 돈다. go_fast=true는 fp8 양자화 경로다.
 */
export const QWEN_GO_FAST = true;
export const QWEN_OUTPUT_QUALITY = 95;

/** #192 KSampler 고정 시드 */
export const SAMPLER_SEED = 484861632801927;

/** #124 Lora Loader Stack slot 1 */
export const LEGACY_LORA_NAME = "sbj_qwen_image_edit_schematic_20260213.safetensors";
export const LORA_STRENGTH = 1.2;
export const DEFAULT_LORA_URL =
  `https://vringon-ai-lora-public.s3.ap-northeast-2.amazonaws.com/${LEGACY_LORA_NAME}`;

/** 레거시 로컬 모델 (참고용 — 공통 워커가 대체한다) */
export const LEGACY_UNET_NAME = "Qwen-Rapid-AIO-SFW-v18.safetensors";
export const LEGACY_VAE_NAME = "qwen_image_vae.safetensors";
export const LEGACY_CLIP_NAME = "qwen_2.5_vl_7b_fp8_scaled.safetensors";

// ── 컬러 후처리 (레거시 IDC worker.py: color_sketch_then_upscale) ────────────

/** 컬러화 모델. image-edit은 provider 값이 모델 선택자라 "auto"면 openai로 떨어진다 */
export const COLORIZE_MODEL = "google/nano-banana";

/**
 * nano-banana 컬러화 프롬프트.
 * Image 1 = 모노톤 도식(구조 원본), Image 2 = 원본 사진(색·소재 레퍼런스).
 * 프롬프트가 두 이미지를 **순서로** 참조하므로 입력 순서를 바꾸면 결과가 무너진다.
 * 레거시 worker.py의 상수 전문이며 한 글자도 바꾸지 않는다.
 */
export const COLOR_SKETCH_PROMPT = `This is an image-editing and colorization task, not a new design generation task.

Use Image 1 as the authoritative structural source drawing. Preserve Image 1 exactly: keep the same silhouette, proportions, viewing angle, canvas framing, outer contours, internal construction lines, seam lines, panel divisions, stitching, hardware, fastenings, straps, trims, and every existing line in its original position.

Use Image 2 only as the color, material, and design reference. Transfer the color palette, material-region logic, panel color relationships, trim colors, lining colors, zipper/hardware colors, and any flat pattern or print treatment from Image 2 onto the corresponding regions of Image 1. Do not copy Image 2’s silhouette, pose, perspective, proportions, shadows, background, labels, logos, or any structural details that are not already present in Image 1.

Colorize the grayscale schematic in Image 1 into the visual style of a professional fashion tech pack flat sketch: a crisp flat-color vector-style technical illustration. All original linework from Image 1 must remain visible and clean.

Strict structural preservation requirements:
- Do not add, remove, reposition, redraw, simplify, or reinterpret any structural element from Image 1.
- Do not introduce new seams, panels, straps, trims, hardware, decorations, logos, labels, or text.
- Keep all stitching exactly as shown in Image 1, rendered as evenly spaced dashed lines in the same locations and rhythm.
- If a color or material mapping from Image 2 is ambiguous, choose the closest corresponding region in Image 1 while preserving Image 1’s panel boundaries.

Rendering style:
- Clean, uniform black outlines with consistent stroke weight on every edge, seam, stitching line, and panel division.
- Solid flat fill colors only, applied evenly inside each closed shape.
- Use distinct flat colors for separate material regions so the main body, secondary panels, base, lining, trims, zippers, and hardware read clearly as different materials.
- Render hardware and metal parts, including buckles, zipper teeth, zipper pulls, rings, rivets, and eyelets, in flat solid metallic gray unless Image 2 clearly indicates another metal color.
- Render printed or patterned areas from Image 2 as flat, evenly applied tonal fills or simplified flat pattern fills, while keeping all underlying Image 1 linework fully visible.

Strictly avoid:
gradients, soft shading, cel-shading, color ramps, drop shadows, cast shadows, ambient occlusion, bevels, embossing, highlights, glossy effects, photographic texture, fabric texture, 3D lighting, volumetric lighting, or any realistic rendering. The fills must be completely flat.

Background:
pure solid white, fully empty, with no shadow beneath the object.

Output:
a clean, sharp, print-ready vector-style technical flat illustration based on Image 1’s exact drawing, colorized using Image 2’s color and material reference only.`;

/** 레거시가 nano-banana에 고정으로 넘기던 값. 비정방 입력도 1:1로 강제된다 */
export const COLOR_SKETCH_ASPECT_RATIO = "1:1";

// ── 업스케일 (prunaai/p-image-upscale). 흑백·컬러 공통 단계 ─────────────────
export const UPSCALE_MODEL = "prunaai/p-image-upscale";
/** 배율이 아니라 **목표 4메가픽셀** (capability README 기준) */
export const UPSCALE_MODE = "target";
export const UPSCALE_TARGET = 4;
export const UPSCALE_FACTOR = 2;
export const UPSCALE_OUTPUT_QUALITY = 100;

// ── 벡터화 (src/vector.py) ──────────────────────────────────────────────────
/**
 * 모노톤은 binary로 선만 따므로 배경 도형이 생기지 않는다.
 * 컬러는 color로 떠야 색이 남는다 — binary로 뜨면 fill이 단색으로 붕괴해
 * 컬러 산출물도 흑백으로 보인다.
 */
export const VTRACER_MONO = { colormode: "binary", mode: "polygon", filter_speckle: 1 } as const;
export const VTRACER_COLOR = {
  colormode: "color", mode: "polygon", filter_speckle: 1, color_precision: 8,
} as const;

/** 워커 contract가 받는 카테고리 */
export const SCHEMATIC_CATEGORIES = [
  "shoe", "bag", "top", "bottom", "outer", "jewelry", "glasses", "cosmetic",
] as const;
export type SchematicCategory = (typeof SCHEMATIC_CATEGORIES)[number];
