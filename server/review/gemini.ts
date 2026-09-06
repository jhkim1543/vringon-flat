/**
 * Gemini 호출 — 텍스트와 이미지를 함께 보낸다.
 *
 * 키는 저장소에 두지 않는다. 이웃 프로젝트의 `.env` 에서 읽고, 어디에도 다시 쓰지 않는다.
 */
import fs from "node:fs/promises";
import path from "node:path";

const ENV_CANDIDATES = [
  path.join("..", "blueocean-agent", ".env"),
  ".env",
];

let cached: Record<string, string> | null = null;

export async function env(): Promise<Record<string, string>> {
  if (cached) return cached;
  const out: Record<string, string> = {};
  for (const p of ENV_CANDIDATES) {
    let txt: string;
    try { txt = await fs.readFile(p, "utf8"); } catch { continue; }
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const v = m[2].trim().replace(/^["']|["']$/g, "");
      if (v && !out[m[1]]) out[m[1]] = v;
    }
  }
  cached = out;
  return out;
}

export interface Part {
  text?: string;
  image?: string;   // 파일 경로
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

/**
 * @param parts 텍스트와 이미지를 **보낸 순서 그대로** 모델이 읽는다.
 * @param opts.json true 면 JSON 만 내도록 강제한다.
 */
export async function gemini(
  parts: Part[],
  opts: { model?: string; json?: boolean; temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const e = await env();
  const key = e.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY 를 못 찾았다");
  const model = opts.model ?? e.GEMINI_RESEARCH_MODEL ?? "gemini-3.1-pro-preview";

  const body: Record<string, unknown> = {
    contents: [{
      role: "user",
      parts: await Promise.all(parts.map(async (p) => {
        if (p.text !== undefined) return { text: p.text };
        const ext = path.extname(p.image!).toLowerCase();
        return {
          inline_data: {
            mime_type: MIME[ext] ?? "image/png",
            data: (await fs.readFile(p.image!)).toString("base64"),
          },
        };
      })),
    }],
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxTokens ?? 32768,
      ...(opts.json ? { responseMimeType: "application/json" } : {}),
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  // 과부하·일시 오류는 재시도한다 — 20명을 도는 중에 한 번 끊기면 전부 다시 돌려야 한다
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const j = await res.json() as {
        candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      };
      const c = j.candidates?.[0];
      const txt = (c?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      if (txt.trim()) return txt;
      lastErr = `빈 응답 (finishReason=${c?.finishReason ?? "?"})`;
    } else {
      lastErr = `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
      if (res.status === 400 || res.status === 403) break;   // 재시도해도 같다
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`Gemini 실패: ${lastErr}`);
}

/** ```json 울타리를 벗겨 파싱한다 */
export function parseJson<T>(txt: string): T {
  let s = txt.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
  if (fence) s = fence[1];
  const a = s.indexOf("{"), b = s.indexOf("[");
  const start = a < 0 ? b : b < 0 ? a : Math.min(a, b);
  if (start > 0) s = s.slice(start);
  const endA = s.lastIndexOf("}"), endB = s.lastIndexOf("]");
  const end = Math.max(endA, endB);
  if (end >= 0 && end < s.length - 1) s = s.slice(0, end + 1);
  return JSON.parse(s) as T;
}
