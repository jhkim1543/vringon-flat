import fs from "node:fs/promises";
import { config } from "../config.js";
import { withRetry } from "./retry.js";
import type { LayerPlan } from "../types.js";

const API = "https://api.openai.com/v1";

async function post(url: string, body: BodyInit, headers: Record<string, string> = {}) {
  return withRetry(
    async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.openaiKey}`, ...headers },
        body,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI ${res.status}: ${text.slice(0, 500)}`);
      }
      return res.json();
    },
    { label: "OpenAI" },
  );
}

const LAYER_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["category", "objectNoun", "view", "parts"],
  properties: {
    category: {
      type: "string",
      enum: [
        "footwear",
        "jewelry",
        "bag",
        "apparel",
        "eyewear",
        "watch",
        "headwear",
        "furniture",
        "electronics",
        "packaging",
        "other",
      ],
    },
    // SAM 3은 단일 일반 명사에만 반응한다 (실측: shoe .98 / vamp 0개).
    // 배경 격리·경계 보정에 쓸 가장 흔한 영어 명사 하나.
    objectNoun: { type: "string" },
    view: { type: "string" },
    parts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "parent", "kind", "segPrompt"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          parent: { type: "string" },
          kind: { type: "string", enum: ["fill", "line", "logo"] },
          segPrompt: { type: "string" },
        },
      },
    },
  },
} as const;

const CATEGORY_GUIDE = `
Category conventions (use these parent group names and part vocabularies):
- footwear → parents: UPPER, SOLE, CONSTRUCTION, BRANDING.
  parts e.g. Vamp, Quarter, Eyestay, Tongue, Heel Counter, Collar, Toe Cap,
  Midsole, Outsole, Laces, Stitch, Perforation, Logo.
- jewelry → parents: STRUCTURE, SETTING, STONES, DETAILS.
  parts e.g. Shank, Head, Prong, Bezel, Gallery, Center Stone, Side Stone,
  Pave, Engraving, Hallmark.
- bag → parents: BODY, CLOSURE, HANDLES, HARDWARE, CONSTRUCTION.
  parts e.g. Front Panel, Gusset, Flap, Base, Handle, Strap, Zipper,
  Buckle, D-ring, Stitch, Piping, Logo.
- apparel → parents: BODY, SLEEVES, COLLAR, CLOSURE, CONSTRUCTION, BRANDING.
- eyewear → parents: FRAME, LENSES, TEMPLES, HARDWARE.
- watch → parents: CASE, DIAL, STRAP, HARDWARE.
- headwear → parents: CROWN, BRIM, CLOSURE, BRANDING.
- any other product → invent 2-5 uppercase parent groups that a designer
  would use for that object, ordered back-to-front, and put every visible
  part under one of them. Never leave parent empty.

objectNoun must be a single common English noun for the whole product that a
general-purpose segmentation model would know (e.g. "shoe", "bag", "watch",
"chair"), NOT a part name and NOT a brand or technical term.
`;

/** 1단계: 이미지 이해 → Layer Plan (Structured Outputs) */
export async function understandImage(
  imagePath: string,
  layerDetail: string,
  categoryHint?: string,
): Promise<LayerPlan> {
  const b64 = (await fs.readFile(imagePath)).toString("base64");
  const detailNote =
    layerDetail === "simple"
      ? "Return only 4-6 major parts."
      : layerDetail === "detailed"
        ? "Return every visually distinguishable part, seam, stitch line and branding element (10-18 parts)."
        : "Return 6-10 meaningful parts.";

  const body = {
    model: config.openaiModel,
    // 결정론: 같은 입력이면 같은 명명이 나와야 재빌드 비교가 의미 있다
    temperature: 0,
    seed: 7,
    messages: [
      {
        role: "system",
        content:
          "You are a technical-drawing analyst for product design (footwear / jewelry / bags). " +
          "Given a product photo or render, produce a layer plan for a flat technical sketch: " +
          "which parts must be separated into layers, and a short text prompt per part usable by " +
          "a segmentation model. segPrompt must be a SHORT noun phrase of 2-5 English words " +
          "naming the visible region with its color/material (e.g. 'red crossing stripes', " +
          "'white foam midsole') — never a full sentence. " +
          CATEGORY_GUIDE +
          detailNote +
          " ids must be snake_case ascii.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: categoryHint
              ? `Category hint: ${categoryHint}. Analyze this image.`
              : "Analyze this image.",
          },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "layer_plan", strict: true, schema: LAYER_PLAN_SCHEMA },
    },
  };

  const json = await post(`${API}/chat/completions`, JSON.stringify(body), {
    "Content-Type": "application/json",
  });
  return JSON.parse(json.choices[0].message.content) as LayerPlan;
}

const ASSIGN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["assignments"],
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "partId"],
        properties: {
          index: { type: "integer" },
          // 매칭되는 파트가 없으면 빈 문자열
          partId: { type: "string" },
        },
      },
    },
  },
} as const;

export interface ComponentInfo {
  index: number;
  areaPct: number;
  cx: number;
  cy: number;
  color: string;
}

/**
 * 분해된 조각(연결요소)에 Layer Plan의 파트 이름을 배정한다.
 * 조각 이미지는 번호 순서대로 배치된 그리드 한 장으로 전달한다.
 */
export async function nameComponents(
  sheetPath: string,
  plan: LayerPlan,
  comps: ComponentInfo[],
): Promise<{ index: number; partId: string }[]> {
  const b64 = (await fs.readFile(sheetPath)).toString("base64");
  const partList = plan.parts
    .map((p) => `  ${p.id} — ${p.name} (${p.parent})`)
    .join("\n");
  const compList = comps
    .map(
      (c) =>
        `  #${c.index}: area ${c.areaPct}% of canvas, center (x=${c.cx}, y=${c.cy}) ` +
        `where x=0 is left and y=0 is top, color ${c.color}`,
    )
    .join("\n");

  const body = {
    model: config.openaiModel,
    // 결정론: 같은 입력이면 같은 명명이 나와야 재빌드 비교가 의미 있다
    temperature: 0,
    seed: 7,
    messages: [
      {
        role: "system",
        content:
          "You match shape fragments from a decomposed product drawing to named parts. " +
          "The image is a grid of fragments in index order (row-major, left to right). " +
          "Each fragment is one black silhouette on white. Assign each fragment the id of " +
          "the part it represents. Use geometry and color to disambiguate: e.g. for a shoe " +
          "in lateral view, a small dark shape at the front-bottom is the toe cap, the same " +
          "color at the back is the heel counter. Each partId may be used at most once. " +
          "If a fragment matches no part, return an empty string for partId. " +
          "Return an entry for every fragment index.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Product: ${plan.category}, view: ${plan.view}\n\n` +
              `Available parts:\n${partList}\n\nFragments:\n${compList}`,
          },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "assignments", strict: true, schema: ASSIGN_SCHEMA },
    },
  };

  const json = await post(`${API}/chat/completions`, JSON.stringify(body), {
    "Content-Type": "application/json",
  });
  const parsed = JSON.parse(json.choices[0].message.content) as {
    assignments: { index: number; partId: string }[];
  };
  // 중복 배정 제거 — 먼저 나온 것 우선
  const used = new Set<string>();
  return parsed.assignments.filter((a) => {
    if (!a.partId) return false;
    if (used.has(a.partId)) return false;
    used.add(a.partId);
    return true;
  });
}

/** 3단계: GPT Image 편집 — flat 변환 candidate 생성 */
export async function gptImageEdit(
  imagePath: string,
  prompt: string,
  n: number,
): Promise<Buffer[]> {
  const form = new FormData();
  const bytes = await fs.readFile(imagePath);
  form.append("model", config.openaiImageModel);
  form.append("image", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "input.png");
  form.append("prompt", prompt);
  form.append("n", String(n));
  form.append("size", "auto");
  const json = await post(`${API}/images/edits`, form);
  return json.data.map((d: { b64_json: string }) => Buffer.from(d.b64_json, "base64"));
}
