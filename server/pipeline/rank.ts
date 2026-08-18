import sharp from "sharp";
import type { FlatCandidate, CandidateScore } from "../types.js";

/**
 * 4단계: Candidate QA — "예쁜 그림"이 아니라 "벡터화하기 좋은 그림"을 고른다.
 *  - silhouetteIoU: 원본 실루엣 대비 형태 보존 (45%)
 *  - edgeQuality:   경계 선명도 — 중간톤 없이 경계가 급격한가 (30%)
 *  - bilevelPurity: 순수 흑/백/솔리드 비율 — 회색·그라데이션 오염 감지 (25%)
 * FAL_KEY가 있으면 여기에 SAM3 re-segmentation IoU를 더해 고도화할 수 있다
 * (segment.ts와 동일 경로 재사용).
 */

const SIZE = 256;

interface Profile {
  silhouette: Uint8Array; // 1 = 전경
  edgeRate: number;
  purity: number;
  colorfulness: number; // 전경 픽셀 평균 채도 0~1 (lineart 무채색 검증용)
}

async function profile(imagePath: string): Promise<Profile> {
  const { data } = await sharp(imagePath)
    .flatten({ background: "#ffffff" })
    .resize(SIZE, SIZE, { fit: "contain", background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const sil = new Uint8Array(SIZE * SIZE);
  let edge = 0;
  let pure = 0;
  let satSum = 0;
  let fg = 0;
  const lum = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    lum[i] = (r * 299 + g * 587 + b * 114) / 1000;
  }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const v = lum[i];
      if (v < 245) {
        sil[i] = 1;
        const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
        satSum += (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
        fg++;
      }
      if (v < 40 || v > 215) pure++;
      if (x > 0 && Math.abs(v - lum[i - 1]) > 90) edge++;
      if (y > 0 && Math.abs(v - lum[i - SIZE]) > 90) edge++;
    }
  }
  return {
    silhouette: sil,
    edgeRate: edge / (SIZE * SIZE),
    purity: pure / (SIZE * SIZE),
    colorfulness: fg ? satSum / fg : 0,
  };
}

function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter++;
    if (a[i] || b[i]) union++;
  }
  return union === 0 ? 0 : inter / union;
}

export async function rankCandidates(
  originalPath: string,
  candidates: FlatCandidate[],
): Promise<{ lineart?: FlatCandidate; colorflat?: FlatCandidate }> {
  const orig = await profile(originalPath);

  for (const c of candidates) {
    try {
      const p = await profile(c.imagePath);
      const silhouetteIoU = iou(orig.silhouette, p.silhouette);
      // 원본 대비 에지 비율: 플랫은 원본보다 에지가 적되 0에 가깝지 않아야 함
      const edgeQuality = Math.max(0, 1 - Math.abs(p.edgeRate - orig.edgeRate * 0.6) / 0.15);
      const bilevelPurity = p.purity;
      let total =
        0.45 * silhouetteIoU + 0.3 * Math.min(1, edgeQuality) + 0.25 * bilevelPurity;
      // lineart는 무채색이어야 함 — 채도가 높을수록 강한 감점
      if (c.kind === "lineart" && p.colorfulness > 0.03) {
        total *= Math.max(0.1, 1 - p.colorfulness * 8);
      }
      c.score = {
        total: round3(total),
        silhouetteIoU: round3(silhouetteIoU),
        edgeQuality: round3(Math.min(1, edgeQuality)),
        bilevelPurity: round3(bilevelPurity),
      } satisfies CandidateScore;
    } catch {
      c.score = { total: 0, silhouetteIoU: 0, edgeQuality: 0, bilevelPurity: 0 };
    }
  }

  const best = (kind: FlatCandidate["kind"]) =>
    candidates
      .filter((c) => c.kind === kind && c.score)
      .sort((a, b) => b.score!.total - a.score!.total)[0];

  return { lineart: best("lineart"), colorflat: best("colorflat") };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
