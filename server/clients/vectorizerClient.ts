import fs from "node:fs/promises";
import { config } from "../config.js";

/**
 * Vectorizer.AI 클라이언트 (공식 REST API).
 * VECTORIZER_API_ID / VECTORIZER_API_SECRET 발급 후 .env에 넣으면
 * vectorize.ts가 potrace 대신 이 경로를 사용한다.
 * https://vectorizer.ai/api/documentation
 */
const ENDPOINT = "https://api.vectorizer.ai/api/v1/vectorize";

export async function vectorizeAI(pngPath: string): Promise<string> {
  const auth = Buffer.from(`${config.vectorizerId}:${config.vectorizerSecret}`).toString("base64");
  const bytes = await fs.readFile(pngPath);

  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "layer.png");
  form.append("output.file_format", "svg");
  // 레이어 PNG는 단색 영역이므로 도형 위주 설정
  form.append("processing.max_colors", "8");
  form.append("output.group_by", "color");

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vectorizer.AI ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.text(); // SVG 문자열
}
