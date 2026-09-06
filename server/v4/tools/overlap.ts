/**
 * 겹친 앵커의 **정체**를 밝힌다 — 같은 패스 안인가, 다른 패스끼리인가.
 *
 * 같은 패스 안이면 굵은 띠의 양쪽 윤곽이 끝에서 만나는 정상적인 모양이다.
 * 다른 패스끼리면 **같은 경계를 두 번 그린 것**이고, 그건 줄일 수 있는 낭비다.
 */
import fs from "node:fs/promises";
import { parsePath } from "../../vector/pathdata.js";
import type { VectorScene } from "../types.js";

const name = process.argv[2] ?? "t_footwear_02";
const NEAR = Number(process.argv[3] ?? 0.6);

const sc = JSON.parse(await fs.readFile(`outputs/v4/v4_${name}/scene.json`, "utf8")) as VectorScene;

interface A { x: number; y: number; prim: string; cls: string; sub: number }
const pts: A[] = [];
for (const p of sc.primitives) {
  const d = (p as { d?: string }).d;
  if (!d) continue;
  let si = 0;
  for (const sp of parsePath(d)) {
    pts.push({ x: sp.start[0], y: sp.start[1], prim: p.id, cls: p.cls, sub: si });
    for (const seg of sp.segs) pts.push({ x: seg.end[0], y: seg.end[1], prim: p.id, cls: p.cls, sub: si });
    si++;
  }
}

const cell = Math.max(NEAR, 1);
const grid = new Map<string, A[]>();
for (const a of pts) {
  const k = `${Math.floor(a.x / cell)},${Math.floor(a.y / cell)}`;
  (grid.get(k) ?? grid.set(k, []).get(k)!).push(a);
}

let samePath = 0, sameSub = 0, crossPrim = 0;
const pairCls = new Map<string, number>();
const counted = new Set<A>();
for (const a of pts) {
  if (counted.has(a)) continue;
  const gx = Math.floor(a.x / cell), gy = Math.floor(a.y / cell);
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      for (const b of grid.get(`${gx + i},${gy + j}`) ?? []) {
        if (b === a || counted.has(b)) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) > NEAR) continue;
        counted.add(b);
        if (a.prim === b.prim && a.sub === b.sub) sameSub++;
        else if (a.prim === b.prim) samePath++;
        else {
          crossPrim++;
          const k = [a.cls, b.cls].sort().join(" ↔ ");
          pairCls.set(k, (pairCls.get(k) ?? 0) + 1);
        }
      }
    }
  }
}

console.log(`\n${name} — 앵커 ${pts.length}개 · 기준 ${NEAR}px`);
console.log(`  같은 서브패스 안      ${sameSub}  (닫힌 곡선의 이음매 등 — 정상)`);
console.log(`  같은 패스의 다른 조각 ${samePath}  (굵은 띠의 양쪽 윤곽 — 대체로 정상)`);
console.log(`  **다른 프리미티브끼리** ${crossPrim}  (같은 경계를 두 번 그린 것)`);
for (const [k, v] of [...pairCls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`      ${String(v).padStart(5)}  ${k}`);
}
