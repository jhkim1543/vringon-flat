/**
 * 각인 글자·로고 **인식** — 기하로 추측하지 않고 비전 모델에게 묻는다.
 *
 * 라인 모드는 잉크를 중심선으로 접는데, 각인 글자는 선이 아니라 **채워진 글리프**라
 * 골격만 남으면 뼈대 낙서가 된다(실측 jewelry_1 "ANTISM").
 *
 * 굵기·분기·세장비로 글자를 가리려는 시도는 **세 번 다 실패**했다:
 *   · 균일 굵기 볼드체는 어느 기하 지표에도 안 걸린다
 *   · 걸리게 문턱을 조이면 굵은 몸통 선이 같이 걸려 다른 샘플이 회귀한다
 *     (jewelry_2 골격 F@3 0.991 → 0.967)
 *   · 성분 단위 판정은 글자가 밴드 선과 한 성분으로 붙으면 무력하다
 *
 * "글자인가"는 기하 질문이 아니라 **의미 질문**이다. 그래서 도면을 비전 모델에 보여
 * 주고 글자 영역의 상자를 받는다. 응답은 도면 sha 로 캐시한다 — 재실행 시 무과금.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { detectLetterBoxes } from "../clients/openaiClient.js";

/** 정규화 상자 [x0, y0, x1, y1] (0~1) */
export type LetterBox = [number, number, number, number];

export async function findLetterRegions(
  schematicPath: string,
  cacheDir: string,
  say?: (m: string) => void,
): Promise<LetterBox[]> {
  const png = await fs.readFile(schematicPath);
  const sha = crypto.createHash("sha256").update(png).digest("hex").slice(0, 16);
  const cacheFile = path.join(cacheDir, `letters_${sha}.json`);
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, "utf8")) as LetterBox[];
    say?.(`각인 인식 — 캐시 재사용 (${cached.length}곳)`);
    return cached;
  } catch { /* 없음 */ }

  const boxes = await detectLetterBoxes(schematicPath);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(boxes));
  say?.(`각인 인식 — ${boxes.length}곳`);
  return boxes;
}

/**
 * 상자들을 글리프 픽셀 마스크로.
 *
 * 성분 단위 판정은 실패한다 — 각인은 밴드 윤곽선과 잉크가 이어져 **한 성분**이라
 * "성분의 3분의 2가 상자 안" 조건에 안 걸린다(실측 jewelry_1: 최대 성분이 도면 전체).
 * 그래서 픽셀 단위로 자르되, 상자 안에서도 **선이 아니라 글리프인 픽셀**만 취한다:
 * 상자 안 잉크의 굵기 중앙값보다 두꺼운 심부를 씨앗으로 잡고 되불린다. 글자 획은
 * 도면의 윤곽선보다 두껍기 때문에 이 안에서는 굵기가 확실한 신호다 — 상자가 범위를
 * 좁혀 준 덕분에 전역에서 실패했던 굵기 기준이 여기서는 통한다.
 */
export function letterMaskFromBoxes(
  boxes: LetterBox[],
  ink: Uint8Array,
  W: number,
  H: number,
  dist: Float32Array,
): Uint8Array {
  const out = new Uint8Array(W * H);
  const allowed = new Uint8Array(W * H);
  if (!boxes.length) return out;

  for (const [bx0, by0, bx1, by1] of boxes) {
    const x0 = Math.max(0, Math.floor(bx0 * W)), y0 = Math.max(0, Math.floor(by0 * H));
    const x1 = Math.min(W - 1, Math.ceil(bx1 * W)), y1 = Math.min(H - 1, Math.ceil(by1 * H));
    const halves: number[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        allowed[i] = 1;
        if (ink[i] && dist[i] > 0) halves.push(dist[i]);
      }
    }
    if (!halves.length) continue;
    halves.sort((a, b) => a - b);
    // 상자 안 잉크 두께의 상위 25% 지점 — 글자 획은 이 위, 윤곽선은 아래
    const cut = halves[Math.floor(halves.length * 0.75)];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        if (ink[i] && dist[i] >= cut) out[i] = 1;
      }
    }
  }

  // 씨앗을 되불려 글자 획 전체를 덮는다 (씨앗은 획의 속심이라 얇다)
  const grow = new Uint8Array(out);
  for (let it = 0; it < 6; it++) {
    const nx = new Uint8Array(grow);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (grow[i] || !ink[i] || !allowed[i]) continue;
        if (grow[i - 1] || grow[i + 1] || grow[i - W] || grow[i + W]) nx[i] = 1;
      }
    }
    grow.set(nx);
  }
  return grow;
}
