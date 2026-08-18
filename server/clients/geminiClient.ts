import fs from "node:fs/promises";
import { config } from "../config.js";
import { withRetry } from "./retry.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

async function generateContent(model: string, body: unknown) {
  return withRetry(
    async () => {
      const res = await fetch(`${BASE}/${model}:generateContent?key=${config.geminiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gemini ${res.status}: ${text.slice(0, 500)}`);
      }
      return res.json();
    },
    { label: `Gemini ${model}` },
  );
}

type Part = { inlineData?: { mimeType: string; data: string }; text?: string };

function extractImages(json: any): Buffer[] {
  const parts: Part[] = json.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => p.inlineData?.data)
    .map((p) => Buffer.from(p.inlineData!.data, "base64"));
}

/** 3단계: Gemini 이미지 편집 — flat 변환 candidate 생성 (1회 호출당 1장) */
export async function geminiImageEdit(imagePath: string, prompt: string): Promise<Buffer> {
  const b64 = (await fs.readFile(imagePath)).toString("base64");
  const contents = [
    {
      parts: [
        { inlineData: { mimeType: "image/png", data: b64 } },
        { text: prompt },
      ],
    },
  ];
  // imageConfig(해상도 지정)를 모르는 구버전 모델이면 없이 재시도
  try {
    const json = await generateContent(config.geminiImageModel, {
      contents,
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { imageSize: config.geminiImageSize },
      },
    });
    const imgs = extractImages(json);
    if (imgs.length) return imgs[0];
    throw new Error("no image in response");
  } catch {
    const json = await generateContent(config.geminiImageModel, {
      contents,
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    });
    const imgs = extractImages(json);
    if (!imgs.length) throw new Error("Gemini: 이미지 응답 없음");
    return imgs[0];
  }
}

export interface GeminiSegItem {
  label: string;
  box_2d: [number, number, number, number]; // y0,x0,y1,x1 (0~1000 정규화)
  mask?: string; // data:image/png;base64,... (box 크기 기준 확률 마스크)
}

/**
 * 2단계 폴백(안정 경로): 파트별 bounding box만 요청한다.
 * box 검출은 Gemini의 검증된 기능이고 응답이 작아 잘리지 않는다.
 * 정밀 경계는 layers.ts에서 컬러 플랫의 솔리드 색상으로 정제한다.
 */
export async function geminiBoxes(
  imagePath: string,
  labels: string[],
): Promise<GeminiSegItem[]> {
  const b64 = (await fs.readFile(imagePath)).toString("base64");
  const prompt =
    `Detect the following parts of the product: ` +
    labels.map((l) => `"${l}"`).join(", ") +
    `. Output a JSON array where each entry has the key "label" (exactly one of the given ` +
    `labels, verbatim) and the key "box_2d" ([ymin, xmin, ymax, xmax], normalized to 0-1000). ` +
    `Include every part that is visible. Do not include masks.`;
  const json = await generateContent(config.geminiVisionModel, {
    contents: [
      {
        parts: [
          { inlineData: { mimeType: "image/png", data: b64 } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192 },
  });
  const text: string =
    json.candidates?.[0]?.content?.parts?.map((p: Part) => p.text ?? "").join("") ?? "[]";
  return parseLenient(text.replace(/^```(json)?/m, "").replace(/```$/m, "").trim());
}

/**
 * 2단계 폴백: FAL_KEY가 없을 때 Gemini의 segmentation 출력으로 파트 마스크 생성.
 * Gemini 2.5+ 계열의 문서화된 segmentation JSON 포맷을 사용한다.
 * 마스크 base64가 커서 응답이 잘리지 않도록 라벨을 청크로 나눠 병렬 호출한다.
 */
export async function geminiSegment(
  imagePath: string,
  labels: string[],
): Promise<GeminiSegItem[]> {
  const b64 = (await fs.readFile(imagePath)).toString("base64");
  // 라벨당 1호출: 응답이 잘리지 않고, 반환 항목이 요청 라벨에 확정 귀속됨
  const results = await Promise.all(
    labels.map((label) =>
      segmentChunk(b64, [label])
        .then((items) => {
          // 가장 큰 박스 하나를 채택하고 라벨을 요청값으로 고정
          const best = items
            .filter((it) => it.mask && it.box_2d)
            .sort((a, b) => boxArea(b.box_2d) - boxArea(a.box_2d))[0];
          return best ? [{ ...best, label }] : [];
        })
        .catch((e) => {
          console.log(`[segment] "${label}" 실패: ${(e as Error).message.slice(0, 140)}`);
          return [] as GeminiSegItem[];
        }),
    ),
  );
  return results.flat();
}

function boxArea(b: [number, number, number, number]): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

async function segmentChunk(imageB64: string, labels: string[]): Promise<GeminiSegItem[]> {
  const prompt =
    `Give the segmentation mask for this part of the product: ` +
    labels.map((l) => `"${l}"`).join(", ") +
    `. Output a JSON list of segmentation masks where each entry contains the 2D bounding box ` +
    `in the key "box_2d" ([ymin, xmin, ymax, xmax], normalized 0-1000), the segmentation mask ` +
    `in key "mask" (base64 PNG data URI), and the text label in the key "label".`;
  const json = await generateContent(config.geminiVisionModel, {
    contents: [
      {
        parts: [
          { inlineData: { mimeType: "image/png", data: imageB64 } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 65536 },
  });
  const text: string =
    json.candidates?.[0]?.content?.parts?.map((p: Part) => p.text ?? "").join("") ?? "[]";
  const cleaned = text.replace(/^```(json)?/m, "").replace(/```$/m, "").trim();
  return parseLenient(cleaned);
}

/** 잘린 JSON 배열에서 완성된 객체까지만 회수 */
function parseLenient(text: string): GeminiSegItem[] {
  try {
    return JSON.parse(text) as GeminiSegItem[];
  } catch {
    const last = text.lastIndexOf("},");
    if (last > 0) {
      try {
        return JSON.parse(text.slice(0, last + 1) + "]") as GeminiSegItem[];
      } catch {
        /* fall through */
      }
    }
    return [];
  }
}
