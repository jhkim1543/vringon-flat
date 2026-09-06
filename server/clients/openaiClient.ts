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

/**
 * 샘플링 파라미터를 지원하지 않는 모델이 있다. 실측: 현재 기본 모델은
 * `temperature: 0`을 400 `unsupported_value`로 거절한다("Only the default (1)
 * value is supported"). 결정론을 위해 넣은 값이 파이프라인 전체를 죽이면 안 되므로,
 * 거절당하면 그 파라미터를 빼고 한 번 더 시도한다.
 *
 * 결정론은 이것 말고도 두 겹으로 지켜진다: Structured Outputs(스키마 고정)와
 * 규칙 기반 명명 폴백(nameRules.ts). 온도를 못 낮춰도 산출물 구조는 흔들리지 않는다.
 */
async function postChat(body: Record<string, unknown>) {
  const send = (b: Record<string, unknown>) =>
    post(`${API}/chat/completions`, JSON.stringify(b), { "Content-Type": "application/json" });
  try {
    return await send(body);
  } catch (e) {
    const msg = (e as Error).message;
    const unsupported = /unsupported_value|does not support|Unrecognized request argument/i.test(msg);
    const hasSampling = "temperature" in body || "seed" in body || "top_p" in body;
    if (!unsupported || !hasSampling) throw e;
    const { temperature, seed, top_p, ...rest } = body;
    void temperature; void seed; void top_p;
    return send(rest);
  }
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

  const json = await postChat(body);
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

  const json = await postChat(body);
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

/**
 * 도면에서 **각인 글자·로고 영역**의 상자를 받는다.
 *
 * 라인 모드는 잉크를 중심선으로 접는데 글자는 채워진 글리프라 골격만 남으면 깨진다.
 * "글자인가"는 기하가 아니라 의미 질문이므로 비전 모델에게 직접 묻는다.
 * 좌표는 0~1000 정수로 받아 0~1 로 환산한다(모델이 정수 격자를 더 안정적으로 낸다).
 */
export async function detectLetterBoxes(
  imagePath: string,
): Promise<[number, number, number, number][]> {
  const b64 = (await fs.readFile(imagePath)).toString("base64");
  const body = {
    model: config.openaiModel,
    messages: [
      {
        role: "system",
        content:
          "You locate ENGRAVED TEXT, LETTERING, BRAND MARKS and LOGO GLYPHS in a " +
          "technical flat sketch of a product. These are solid filled shapes that read " +
          "as letters/characters/symbols — NOT outlines, seams, stitches or structural " +
          "lines. Return a tight bounding box around each contiguous run of text " +
          "(a whole word or logo is one box, not per letter). " +
          "Coordinates are integers 0-1000 where x=0 is left and y=0 is top. " +
          'Reply as JSON: {"regions":[{"x0":..,"y0":..,"x1":..,"y1":..,"what":"..."}]}. ' +
          "If the drawing has no text or logo, return an empty regions array.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Find engraved text / logo glyph regions." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
    response_format: { type: "json_object" as const },
  };
  const res = await postChat(body);
  let j: { regions?: unknown[] } = {};
  try { j = JSON.parse(res?.choices?.[0]?.message?.content ?? "{}"); } catch { /* 빈 응답 */ }
  const regions = (j?.regions ?? []) as { x0: number; y0: number; x1: number; y1: number }[];
  return regions
    .filter((r) => [r.x0, r.y0, r.x1, r.y1].every((v) => typeof v === "number"))
    .map((r) => [
      Math.min(r.x0, r.x1) / 1000, Math.min(r.y0, r.y1) / 1000,
      Math.max(r.x0, r.x1) / 1000, Math.max(r.y0, r.y1) / 1000,
    ] as [number, number, number, number])
    .filter(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0 && (x1 - x0) * (y1 - y0) < 0.5);
}
