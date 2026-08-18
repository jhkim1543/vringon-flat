import path from "node:path";
import fs from "node:fs/promises";
import { config } from "../config.js";
import { gptImageEdit } from "../clients/openaiClient.js";
import { geminiImageEdit } from "../clients/geminiClient.js";
import type { FlatCandidate, LayerPlan } from "../types.js";

/**
 * 3단계: 플랫 표현 생성.
 * 사용자 선택과 무관하게 내부적으로 Line Art와 Color Flat을 둘 다 만든다
 * (선·경계 복원과 면·색 복원의 역할이 다르기 때문).
 * Gemini 3 Pro Image + GPT Image 2 양쪽에서 candidate를 생성한다.
 */

const CATEGORY_KO: Record<string, string> = {
  footwear: "footwear product",
  jewelry: "jewelry piece",
  bag: "bag / leather goods product",
  other: "product",
};

function partList(plan: LayerPlan): string {
  return plan.parts.map((p) => p.name).join(", ");
}

export function lineArtPrompt(plan: LayerPlan): string {
  return (
    `Convert this ${CATEGORY_KO[plan.category]} photo into a professional black-and-white ` +
    `technical flat sketch (vector-style line art) as used in tech packs. ` +
    `STRICT rules: pure white background; draw ONLY the product itself — ` +
    `omit any cast shadow, mirror reflection, ground plane, stand, prop or backdrop ` +
    `present in the source photo; ` +
    // 테크팩 관행: 반복 질감은 전부 그리지 않고 대표 조각만 표시한다.
    // 전부 그리면 벡터화 후 패스가 수백~수천 개로 폭주해 편집이 불가능해진다
    // (실측: 메시 가방 3945패스, 비즈 파우치 8660패스).
    `render every surface as a completely smooth flat panel — do NOT draw ` +
    `surface texture of any kind (mesh, netting, knit, weave, beading, sequins, ` +
    `perforation, quilting, embossing, grain, fabric weave). Replace a textured ` +
    `area with a single plain fill bounded by its outline, exactly as a tech pack ` +
    `does before a material callout is added;uniform clean black outlines only; ` +
    `no shading, no gradients, no gray tones, no texture, no hatching; ` +
    `preserve the exact silhouette, proportions and view of the original; ` +
    `clearly draw every part boundary and construction line for: ${partList(plan)}; ` +
    `draw stitching as fine dashed lines; keep lines continuous and closed; ` +
    `do not add, move or remove any design element.`
  );
}

export function colorFlatPrompt(plan: LayerPlan): string {
  return (
    `Convert this ${CATEGORY_KO[plan.category]} photo into a professional flat color ` +
    `technical drawing (flat sketch) as used in tech packs. ` +
    `STRICT rules: pure white background; draw ONLY the product itself — ` +
    `omit any cast shadow, mirror reflection, ground plane, stand, prop or backdrop ` +
    `present in the source photo; ` +
    // 테크팩 관행: 반복 질감은 전부 그리지 않고 대표 조각만 표시한다.
    // 전부 그리면 벡터화 후 패스가 수백~수천 개로 폭주해 편집이 불가능해진다
    // (실측: 메시 가방 3945패스, 비즈 파우치 8660패스).
    `render every surface as a completely smooth flat panel — do NOT draw ` +
    `surface texture of any kind (mesh, netting, knit, weave, beading, sequins, ` +
    `perforation, quilting, embossing, grain, fabric weave). Replace a textured ` +
    `area with a single plain fill bounded by its outline, exactly as a tech pack ` +
    `does before a material callout is added;completely flat solid color fills with ` +
    `clean black outlines; no shading, no gradients, no highlights, no texture, no 3D effects; ` +
    `each part must be one uniform solid color sampled from the original: ${partList(plan)}; ` +
    `preserve the exact silhouette, proportions and view of the original; ` +
    `keep part boundaries crisp; do not add, move or remove any design element.`
  );
}

export async function generateFlats(
  imagePath: string,
  plan: LayerPlan,
  outDir: string,
  onProgress?: (msg: string) => void,
): Promise<FlatCandidate[]> {
  await fs.mkdir(outDir, { recursive: true });
  const n = config.candidatesPerModel;
  const kinds = [
    { kind: "lineart" as const, prompt: lineArtPrompt(plan) },
    { kind: "colorflat" as const, prompt: colorFlatPrompt(plan) },
  ];

  const candidates: FlatCandidate[] = [];
  const save = async (buf: Buffer, model: FlatCandidate["model"], kind: FlatCandidate["kind"], i: number) => {
    const id = `${model === "gemini" ? "G" : "O"}_${kind}_${i}`;
    const imagePath = path.join(outDir, `${id}.png`);
    await fs.writeFile(imagePath, buf);
    candidates.push({ id, model, kind, imagePath });
  };

  // 모델·종류별 병렬 생성 (실패한 레그는 건너뛰고 성공한 쪽으로 진행)
  const jobs: Promise<void>[] = [];
  for (const { kind, prompt } of kinds) {
    jobs.push(
      (async () => {
        try {
          const bufs = await gptImageEdit(imagePath, prompt, n);
          for (let i = 0; i < bufs.length; i++) await save(bufs[i], "gpt-image", kind, i);
          onProgress?.(`GPT Image ${kind} ${bufs.length}장 완료`);
        } catch (e) {
          onProgress?.(`GPT Image ${kind} 실패: ${(e as Error).message.slice(0, 120)}`);
        }
      })(),
    );
    for (let i = 0; i < n; i++) {
      jobs.push(
        (async () => {
          try {
            const buf = await geminiImageEdit(imagePath, prompt);
            await save(buf, "gemini", kind, i);
            onProgress?.(`Gemini ${kind} #${i} 완료`);
          } catch (e) {
            onProgress?.(`Gemini ${kind} #${i} 실패: ${(e as Error).message.slice(0, 120)}`);
          }
        })(),
      );
    }
  }
  await Promise.all(jobs);

  if (!candidates.some((c) => c.kind === "lineart") || !candidates.some((c) => c.kind === "colorflat"))
    throw new Error("플랫 이미지 생성 실패: lineart/colorflat 중 한 종류도 만들지 못했습니다.");
  return candidates;
}
