import fs from "node:fs/promises";
import sharp from "sharp";
import { config } from "../config.js";
import { withRetry } from "./retry.js";

/**
 * fal.ai 클라이언트 — 실측으로 스키마 확정 (2026-08).
 *
 *  · fal-ai/sam-3/image        : prompt는 **단일 명사 개념**. 서술형 문구나
 *    전문 용어(vamp/quarter/eyestay)는 마스크 0개를 반환한다.
 *    검증됨: shoe 0.98 / sneaker 0.97 / shoelace 0.96 / tongue 0.95 / sole 0.87
 *    반환 0개: stripe, logo, heel
 *
 *  · fal-ai/qwen-image-layered : 이미지를 N개 RGBA 레이어로 분해. **가려진
 *    영역까지 복원(amodal)** 하며 재질/색 단위로 묶는다. 파트 이름은 모른다.
 *    출력은 640px 고정이므로 "픽셀"이 아니라 "마스크 기하"로 사용한다.
 */

const FAL = "https://fal.run";

async function call(model: string, body: unknown): Promise<any> {
  return withRetry(
    async () => {
      const res = await fetch(`${FAL}/${model}`, {
        method: "POST",
        headers: { Authorization: `Key ${config.falKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`fal ${model} ${res.status}: ${text.slice(0, 400)}`);
      }
      return res.json();
    },
    { label: `fal ${model}` },
  );
}

async function toDataUri(imagePath: string, size: number): Promise<string> {
  const buf = await sharp(imagePath)
    .flatten({ background: "#ffffff" })
    .resize(size, size, { fit: "inside" })
    .png()
    .toBuffer();
  return `data:image/png;base64,${buf.toString("base64")}`;
}

async function fetchBuffer(url: string): Promise<Buffer> {
  if (url.startsWith("data:")) return Buffer.from(url.split(",")[1], "base64");
  const r = await fetch(url);
  if (!r.ok) throw new Error(`asset fetch ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// ── SAM 3 ────────────────────────────────────────────────────
export interface Sam3Mask {
  concept: string;
  maskPng: Buffer; // white-on-black
  score: number;
}

/** 개념 하나당 1회 호출. 인식 못 하면 결과에서 빠진다(에러 아님). */
export async function sam3Concepts(
  imagePath: string,
  concepts: string[],
): Promise<Sam3Mask[]> {
  const image = await toDataUri(imagePath, 1024);
  let firstErr: Error | null = null;
  const results = await Promise.all(
    concepts.map(async (concept) => {
      try {
        const j = await call("fal-ai/sam-3/image", {
          image_url: image,
          prompt: concept,
          apply_mask: false,
          max_masks: 1,
          include_scores: true,
          output_format: "png",
        });
        const m = j.masks?.[0];
        if (!m?.url) return null;
        return {
          concept,
          maskPng: await fetchBuffer(m.url),
          score: j.scores?.[0] ?? 1,
        } satisfies Sam3Mask;
      } catch (e) {
        // 개념 하나가 인식 안 되는 것과 **호출 자체가 죽는 것**은 다르다 — 전부 실패면
        // 첫 오류를 올려서 원인이 보이게 한다(실측: 계정 잠김 403 이 "0개 인식"으로 위장).
        firstErr = e as Error;
        return null;
      }
    }),
  );
  const ok = results.filter((r): r is Sam3Mask => r !== null);
  if (!ok.length && firstErr) throw firstErr;
  return ok;
}

export interface Sam3Instance {
  maskPng: Buffer; // white-on-black
  score: number;
  /** 정규화 bbox [x, y, w, h] (0~1) */
  box: [number, number, number, number];
}

/**
 * 같은 개념의 **인스턴스 여러 개**를 분리한다 (복수 객체 입력 대응).
 * 실측: "ring" → 링 3개 각각 0.94, "shoe" → 신발 2개 각각 0.97.
 * 점수 순으로 정렬해 돌려준다. 인식 실패면 빈 배열.
 */
export async function sam3Instances(
  imagePath: string,
  concept: string,
  maxInstances = 6,
): Promise<Sam3Instance[]> {
  const image = await toDataUri(imagePath, 1024);
  try {
    const j = await call("fal-ai/sam-3/image", {
      image_url: image,
      prompt: concept,
      apply_mask: false,
      return_multiple_masks: true,
      max_masks: maxInstances,
      include_scores: true,
      include_boxes: true,
      output_format: "png",
    });
    const masks: { url: string }[] = j.masks ?? [];
    const scores: number[] = j.scores ?? [];
    const boxes: number[][] = j.boxes ?? [];
    const out: Sam3Instance[] = [];
    for (let i = 0; i < masks.length; i++) {
      if (!masks[i]?.url) continue;
      const b = boxes[i] ?? [0, 0, 1, 1];
      out.push({
        maskPng: await fetchBuffer(masks[i].url),
        score: scores[i] ?? 1,
        box: [b[0], b[1], b[2], b[3]] as [number, number, number, number],
      });
    }
    return out.sort((a, b) => b.score - a.score);
  } catch {
    return [];
  }
}

// ── Qwen Image Layered ───────────────────────────────────────
export interface QwenLayer {
  index: number;
  rgbaPng: Buffer;
  coverage: number; // 0~1, 알파가 있는 픽셀 비율
}

/**
 * 플랫 이미지를 amodal RGBA 레이어로 분해.
 * coverage가 거의 1인 레이어(배경/전체 실루엣)는 호출자가 걸러낸다.
 */
export async function qwenLayered(
  imagePath: string,
  numLayers: number,
  caption: string,
): Promise<QwenLayer[]> {
  const j = await call("fal-ai/qwen-image-layered", {
    image_url: await toDataUri(imagePath, 1024),
    prompt: caption,
    num_layers: numLayers,
    output_format: "png",
  });
  const imgs: { url: string }[] = j.images ?? [];
  const out: QwenLayer[] = [];
  for (let i = 0; i < imgs.length; i++) {
    const rgbaPng = await fetchBuffer(imgs[i].url);
    const { data, info } = await sharp(rgbaPng)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let opaque = 0;
    for (let p = 3; p < data.length; p += info.channels) if (data[p] > 40) opaque++;
    out.push({ index: i, rgbaPng, coverage: opaque / (info.width * info.height) });
  }
  return out;
}
