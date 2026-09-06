/**
 * `.ai` 안의 **명백한 결함**만 센다 — 취향이나 표현의 거래가 아니라, 누가 봐도 잘못인 것.
 *
 *   1. 같은 레이어 안에서 겹친 앵커 (한 패스가 두 번 그려졌거나 제자리걸음)
 *   2. 1pt 미만으로 붙은 이웃 앵커 (편집할 수 없는 뭉침)
 *   3. 길이가 0 에 가까운 조각
 */
import { readAiAnchors } from "../ai-anchor-render.js";
import fs from "node:fs/promises";

const names = process.argv.slice(2);
console.log("\n샘플              앵커     겹침(0.3pt)  뭉침(1pt)  0길이조각");
for (const name of names) {
  let dots, page;
  try { ({ dots, page } = await readAiAnchors(`outputs/v4/v4_${name}/layered.ai`)); }
  catch { console.log(`  ${name}: 못 읽음`); continue; }

  // 1) 같은 레이어 안에서 0.3pt 안에 겹친 쌍
  const cell = 2;
  const grid = new Map<string, typeof dots>();
  for (const d of dots) {
    const k = `${d.layer}|${Math.floor(d.x / cell)},${Math.floor(d.y / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(d);
  }
  let overlap = 0;
  const seen = new Set<number>();
  for (let i = 0; i < dots.length; i++) {
    if (seen.has(i)) continue;
    const d = dots[i];
    const gx = Math.floor(d.x / cell), gy = Math.floor(d.y / cell);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (const o of grid.get(`${d.layer}|${gx + a},${gy + b}`) ?? []) {
          if (o === d) continue;
          if (Math.hypot(d.x - o.x, d.y - o.y) <= 0.3) { overlap++; seen.add(dots.indexOf(o)); }
        }
      }
    }
  }

  // 2·3) 패스 안에서 이웃한 앵커 사이 거리 — .ai 스트림 순서를 그대로 쓴다
  let tight = 0, zero = 0, pairs = 0;
  for (let i = 1; i < dots.length; i++) {
    if (dots[i].corner) continue;         // m/l 로 시작한 새 조각은 이웃이 아니다
    const gap = Math.hypot(dots[i].x - dots[i - 1].x, dots[i].y - dots[i - 1].y);
    pairs++;
    if (gap < 0.05) zero++;
    else if (gap < 1) tight++;
  }
  console.log(
    `${name.padEnd(16)} ${String(dots.length).padStart(6)}  ` +
    `${String(overlap).padStart(7)} (${((overlap / dots.length) * 100).toFixed(1)}%)  ` +
    `${String(tight).padStart(6)} (${(pairs ? (tight / pairs) * 100 : 0).toFixed(1)}%)  ` +
    `${String(zero).padStart(6)}`,
  );
  void fs; void page;
}
