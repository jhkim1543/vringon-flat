/**
 * 두 접합 판정 규칙을 **같은 골격에서** 나란히 센다 —
 * `npx tsx server/v4/tools/tracercmp.ts`
 *
 * v7.9 의 `skeletonNeighbors` 는 이웃 수(대각 억제 후)로 접합을 정하고, v7.7 까지 쓰던
 * `crossingNumber` 는 8-이웃 고리의 0→1 전이 수로 정한다. 세선화된 골격에서 둘은
 * 같지 않다 — 계단꼴 대각 구간에서 이웃 규칙이 접합을 더 많이 만든다.
 *
 * 실측 shoe_3 에서 획 수가 1,293 → 3,549 로 늘어난 것이 이 차이인지 확인한다.
 */
import { skeletonNeighbors } from "../../vector/skeletonGraph.js";
import { crossingNumber } from "../../vector/centerline.js";

/** 문자 그림으로 골격을 만든다 — `#` 가 골격 픽셀 */
function fromArt(rows: string[]): { mask: Uint8Array; W: number; H: number } {
  const H = rows.length, W = Math.max(...rows.map((r) => r.length));
  const mask = new Uint8Array(W * H);
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (c === "#") mask[y * W + x] = 1; }));
  return { mask, W, H };
}

function count(mask: Uint8Array, W: number, H: number) {
  let nbJunction = 0, cnJunction = 0, px = 0;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    px++;
    const nb = skeletonNeighbors(mask, W, H, i).length;
    const cn = crossingNumber(mask, W, H, i % W, (i / W) | 0);
    if (nb !== 2) nbJunction++;
    if (cn !== 2) cnJunction++;
  }
  return { px, nbJunction, cnJunction };
}

const cases: [string, string[]][] = [
  ["곧은 가로선", ["........", "########", "........"]],
  ["45° 대각선", ["#.......", ".#......", "..#.....", "...#....", "....#...", ".....#..", "......#.", ".......#"]],
  ["완만한 계단(2:1)", ["##......", "..##....", "....##..", "......##"]],
  ["완만한 계단(3:1)", ["###.....", "...###..", "......##"]],
  ["진짜 T 접합", ["...#...", "...#...", "#######", "...#...", "...#..."]],
];

console.log(`${"골격".padEnd(20)} ${"픽셀".padStart(5)} ${"이웃≠2".padStart(8)} ${"교차수≠2".padStart(9)}  판정`);
for (const [name, art] of cases) {
  const { mask, W, H } = fromArt(art);
  const c = count(mask, W, H);
  const verdict = c.nbJunction > c.cnJunction ? "이웃 규칙이 더 쪼갠다" : c.nbJunction === c.cnJunction ? "같다" : "교차수가 더 쪼갠다";
  console.log(`${name.padEnd(20)} ${String(c.px).padStart(5)} ${String(c.nbJunction).padStart(8)} ${String(c.cnJunction).padStart(9)}  ${verdict}`);
}
