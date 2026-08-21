/**
 * S2 구성품 분해 — GPT 비전으로 "이 제품을 이루는 부품"을 나눈다.
 *
 * V2의 Layer Manifest보다 단순하다. V3에서는 재질·벡터 프로파일을 몰라도 되기 때문이다 —
 * 파트를 나누고 나면 각 파트를 VRINGON schematic으로 도면화하고, 도면의 **라인**을 기준으로
 * 벡터를 뽑으므로 재질별 분기가 필요 없다. GPT가 정해야 할 것은 딱 세 가지다:
 *
 *   · 어떤 부품으로 나눌 것인가 (의미 단위, 보이는 색조각이 아니라)
 *   · 각 부품이 화면 어디에 있는가 (마스크 seed용 대략 bbox)
 *   · 무엇이 무엇을 가리는가 (z-order)
 */
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { config } from "../config.js";
import { withRetry } from "../clients/retry.js";

export interface ProductPart {
  /** snake_case 영문 id — SVG 그룹 id가 된다 */
  id: string;
  /** 사람이 읽을 이름 (한국어 허용) */
  label: string;
  /** 영문 설명 — schematic 프롬프트·마스크 판단에 쓴다 */
  description: string;
  /** [x0,y0,x1,y1] 0~1 정규화 */
  bbox: [number, number, number, number];
  /** 0이 가장 뒤 */
  z: number;
  /** 이 부품을 가리는 부품 id들 */
  occludedBy: string[];
  /** 독립 부품인가, 표면 효과(로고·스티치)인가 */
  kind: "component" | "marking";
  confidence: number;
}

export interface PartPlan {
  /** schematic 워커가 받는 카테고리 */
  category: string;
  objectNoun: string;
  view: string;
  parts: ProductPart[];
  provenance: {
    model: string;
    promptVersion: string;
    inputSha256: string;
    createdAt: string;
  };
}

export const PART_PROMPT_VERSION = "v3.parts.v1.0.0";

const SYSTEM_PROMPT = `You split a product photo into the physical components it is made of.

Rules:
1. Split by manufactured component, not by visible color patch. A single part keeps one id even
   if light and shadow break it into several visible pieces.
2. Order components back to front and state which components occlude which.
3. Give each component an approximate normalized bounding box [x0,y0,x1,y1] in 0..1,
   where x0 is left and y0 is top. The box only seeds segmentation; it need not be exact.
4. Use "component" for real parts and "marking" for surface graphics (logo, stitching, print)
   that sit on a component.
5. Prefer 3-10 components. Merge parts that a manufacturer would not make separately.
6. ids must be snake_case ascii and unique.
7. Return only JSON matching the schema. No prose.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["category", "objectNoun", "view", "parts"],
  properties: {
    category: {
      type: "string",
      enum: ["shoe", "bag", "jewelry", "top", "bottom", "outer", "glasses", "cosmetic"],
      description: "schematic worker category",
    },
    objectNoun: { type: "string" },
    view: { type: "string" },
    parts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "description", "bbox", "z", "occludedBy", "kind", "confidence"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
          bbox: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
          z: { type: "integer" },
          occludedBy: { type: "array", items: { type: "string" } },
          kind: { type: "string", enum: ["component", "marking"] },
          confidence: { type: "number" },
        },
      },
    },
  },
} as const;

async function postChat(body: Record<string, unknown>): Promise<any> {
  const send = (b: Record<string, unknown>) =>
    withRetry(
      async () => {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${config.openaiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(b),
        });
        if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 300)}`);
        return r.json();
      },
      { label: "part-plan" },
    );
  try {
    return await send(body);
  } catch (e) {
    // 일부 모델은 샘플링 파라미터를 거부한다 (실측: temperature 0 → 400)
    if (!/unsupported_value|does not support|Unrecognized request argument/i.test((e as Error).message)) throw e;
    const { temperature, seed, ...rest } = body;
    void temperature; void seed;
    return send(rest);
  }
}

export async function planParts(
  imagePath: string,
  opts: { categoryHint?: string; minParts?: number; maxParts?: number } = {},
  onProgress?: (m: string) => void,
): Promise<PartPlan> {
  const buf = await fs.readFile(imagePath);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const minP = opts.minParts ?? 3;
  const maxP = opts.maxParts ?? 10;

  const userText = [
    opts.categoryHint ? `Category hint: ${opts.categoryHint}.` : "",
    `Return between ${minP} and ${maxP} components.`,
    "z must start at 0 for the backmost component and increase toward the viewer.",
  ]
    .filter(Boolean)
    .join(" ");

  const json = await postChat({
    model: config.openaiModel,
    temperature: 0,
    seed: 7,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: `data:image/png;base64,${buf.toString("base64")}` } },
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: { name: "part_plan", strict: true, schema: SCHEMA } },
  });

  const parsed = JSON.parse(json.choices[0].message.content) as Omit<PartPlan, "provenance">;
  const plan = normalize(parsed);
  plan.provenance = {
    model: config.openaiModel,
    promptVersion: PART_PROMPT_VERSION,
    inputSha256: sha,
    createdAt: new Date().toISOString(),
  };
  onProgress?.(
    `구성품 ${plan.parts.length}개: ${plan.parts.map((p) => p.label || p.id).join(", ")}`,
  );
  return plan;
}

/** id 정규화·중복 제거·z 재계산·가림 관계 정리 */
function normalize(raw: Omit<PartPlan, "provenance">): PartPlan {
  const taken = new Set<string>();
  const remap = new Map<string, string>();
  for (const p of raw.parts) {
    let id = (p.id || p.label || "part")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "part";
    let out = id, n = 2;
    while (taken.has(out)) out = `${id}_${n++}`;
    taken.add(out);
    remap.set(p.id, out);
    p.id = out;
  }
  for (const p of raw.parts) {
    p.occludedBy = (p.occludedBy ?? []).map((x) => remap.get(x) ?? x).filter((x) => taken.has(x) && x !== p.id);
    const [x0, y0, x1, y1] = p.bbox ?? [0, 0, 1, 1];
    p.bbox = [
      Math.max(0, Math.min(1, Math.min(x0, x1))),
      Math.max(0, Math.min(1, Math.min(y0, y1))),
      Math.max(0, Math.min(1, Math.max(x0, x1))),
      Math.max(0, Math.min(1, Math.max(y0, y1))),
    ];
    if (p.bbox[2] - p.bbox[0] < 0.02) { p.bbox[0] = Math.max(0, p.bbox[0] - 0.02); p.bbox[2] = Math.min(1, p.bbox[2] + 0.02); }
    if (p.bbox[3] - p.bbox[1] < 0.02) { p.bbox[1] = Math.max(0, p.bbox[1] - 0.02); p.bbox[3] = Math.min(1, p.bbox[3] + 0.02); }
  }
  // marking은 항상 component 위에 온다
  raw.parts.sort((a, b) => (a.kind === b.kind ? a.z - b.z : a.kind === "marking" ? 1 : -1));
  raw.parts.forEach((p, i) => (p.z = i));
  return raw as PartPlan;
}
