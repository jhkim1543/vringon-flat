/**
 * S02 레이어 계획 — GPT-5.6 image input + Structured Outputs로 Layer Manifest 생성.
 * 개발계획서 §6, §7.1.
 *
 * planner는 "무엇을 분리할지와 관계"만 정한다(P1). 픽셀 경계는 S04가, 형상 생성은
 * S06이 맡는다. 그래서 여기서 bbox는 대략적인 seed로만 쓰이고 정밀도를 요구하지 않는다.
 */
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { config } from "../config.js";
import { withRetry } from "../clients/retry.js";
import {
  MANIFEST_JSON_SCHEMA,
  PLANNER_PROMPT_VERSION,
  SCHEMA_VERSION,
  validateManifestShape,
  type LayerManifest,
  type TargetMode,
} from "./schema.js";

const API = "https://api.openai.com/v1";

/** 예시 2. GPT-5.6 Layer Planner 시스템 프롬프트 (계획서 원문) */
export const PLANNER_SYSTEM_PROMPT = `You are a layer-planning engine for editable vector reconstruction.
Analyze exactly one foreground product. Return only JSON matching the supplied schema.

Rules:
1. Define semantic parts, not disconnected visible color fragments.
2. Order all layers from back to front and provide pairwise occlusion relations.
3. Separate structural parts from optional appearance effects.
4. Describe the complete hidden geometry required when a layer is isolated.
5. Exclude the background and unrelated cast shadows unless explicitly requested.
6. Prefer 3-8 editable layers; merge visually inseparable micro-parts.
7. For each layer, provide an English extraction prompt, negative prompt,
   material class, vectorization profile, spatial hint, and confidence.
8. Mark uncertainty instead of inventing hidden details.
9. Do not output markdown or prose outside the JSON object.`;

export interface PlanOptions {
  targetMode: TargetMode;
  strictVector: boolean;
  minLayers: number;
  maxLayers: number;
  categoryHint?: string;
  includeAppearanceLayers: boolean;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  targetMode: "clean_flat",
  strictVector: true,
  minLayers: 3,
  maxLayers: 8,
  includeAppearanceLayers: true,
};

async function postChat(body: Record<string, unknown>): Promise<any> {
  const send = async (b: Record<string, unknown>) =>
    withRetry(
      async () => {
        const res = await fetch(`${API}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.openaiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(b),
        });
        if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 400)}`);
        return res.json();
      },
      { label: "planner" },
    );
  try {
    return await send(body);
  } catch (e) {
    // 일부 모델은 샘플링 파라미터를 거부한다 (실측: temperature 0 → 400 unsupported_value)
    if (!/unsupported_value|does not support|Unrecognized request argument/i.test((e as Error).message)) throw e;
    const { temperature, seed, top_p, ...rest } = body;
    void temperature; void seed; void top_p;
    return send(rest);
  }
}

/**
 * S02 실행. 실패하면 던진다 — 부록 A: 스키마를 통과하지 않으면 downstream으로 보내지 않는다.
 * 대신 §22.3에 따라 schema repair를 최대 2회 시도한다.
 */
export async function planLayers(
  imagePath: string,
  opts: PlanOptions = DEFAULT_PLAN_OPTIONS,
  onProgress?: (m: string) => void,
): Promise<LayerManifest> {
  const buf = await fs.readFile(imagePath);
  const b64 = buf.toString("base64");
  const inputSha = crypto.createHash("sha256").update(buf).digest("hex");

  const userText = [
    opts.categoryHint ? `Category hint: ${opts.categoryHint}.` : "",
    `Target output mode: ${opts.targetMode}. strict_vector=${opts.strictVector}.`,
    `Produce between ${opts.minLayers} and ${opts.maxLayers} layers.`,
    opts.includeAppearanceLayers
      ? "Include appearance sublayers (highlight, shadow-on-part, engraving) when they are independently editable."
      : "Do not create appearance sublayers; structural parts only.",
    "Set schema_version to \"1.0\" and policy.layer_order to \"back_to_front\".",
    "z_index must start at 0 for the backmost layer and increase toward the front.",
  ]
    .filter(Boolean)
    .join(" ");

  const body: Record<string, unknown> = {
    model: config.openaiModel,
    temperature: 0,
    seed: 7,
    messages: [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "layer_manifest", strict: true, schema: MANIFEST_JSON_SCHEMA },
    },
  };

  let manifest: LayerManifest | null = null;
  let lastIssues: string[] = [];

  // §22.3 schema repair 최대 2회, 그 이후엔 NEEDS_REVIEW로 전환(호출자 책임)
  for (let attempt = 0; attempt < 3; attempt++) {
    const json = await postChat(
      attempt === 0
        ? body
        : {
            ...body,
            messages: [
              ...(body.messages as unknown[]),
              {
                role: "user",
                content:
                  `The previous JSON violated these constraints: ${lastIssues.join("; ")}. ` +
                  `Return corrected JSON only.`,
              },
            ],
          },
    );
    const parsed = JSON.parse(json.choices[0].message.content) as LayerManifest;
    const issues = validateManifestShape(parsed).filter((i) => i.severity === "error");
    if (!issues.length) {
      manifest = parsed;
      break;
    }
    lastIssues = issues.map((i) => `${i.code}${i.layerId ? `(${i.layerId})` : ""}: ${i.message}`);
    onProgress?.(`manifest 스키마 위반 ${issues.length}건 → repair 시도 ${attempt + 1}`);
  }
  if (!manifest) throw new Error(`Layer Manifest 검증 실패: ${lastIssues.join("; ")}`);

  manifest.schema_version = SCHEMA_VERSION;
  manifest.policy = {
    ...manifest.policy,
    target_mode: opts.targetMode,
    strict_vector: opts.strictVector,
    max_layers: opts.maxLayers,
    layer_order: "back_to_front",
  };
  manifest.provenance = {
    planner_prompt_version: PLANNER_PROMPT_VERSION,
    model: config.openaiModel,
    input_sha256: inputSha,
    created_at: new Date().toISOString(),
  };
  onProgress?.(
    `manifest: ${manifest.object.category} / ${manifest.layers.length} layers / ` +
      `관계 ${manifest.relations.length}개`,
  );
  return manifest;
}
