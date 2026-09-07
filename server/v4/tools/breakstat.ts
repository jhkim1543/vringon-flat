/**
 * 끊김 잔여 통계 — **이어 붙일 수 있었는데 안 붙은 쌍이 왜 남았나.**
 *
 * joinable.ts 는 기하(거리 ≤6px · 꺾임 ≤60°)만 본다. v7.1 부터 잇기는 **굵기가 같은 획만**
 * 잇고 **서브패스 하나짜리 획만** 다루므로, 남은 쌍을 그 이유로 나눠 세야 "고칠 것"과
 * "일부러 안 이은 것"이 갈린다.
 *
 *   npx tsx server/v4/tools/breakstat.ts <접두> <이름...>
 */
import fs from "node:fs/promises";
import { parsePath, type Pt, type SubPath } from "../../vector/pathdata.js";

type End = { prim: number; multi: boolean; w: number; p: Pt; t: Pt };

function endsOf(sub: SubPath, prim: number, multi: boolean, w: number): End[] {
  if (sub.closed || !sub.segs.length) return [];
  const f = sub.segs[0];
  const headIn = f.type === "L" ? f.end : f.c1!;
  const l = sub.segs[sub.segs.length - 1];
  const prev = sub.segs.length > 1 ? sub.segs[sub.segs.length - 2].end : sub.start;
  const tailIn = l.type === "L" ? prev : l.c2!;
  return [
    { prim, multi, w, p: sub.start, t: [sub.start[0] - headIn[0], sub.start[1] - headIn[1]] },
    { prim, multi, w, p: l.end, t: [l.end[0] - tailIn[0], l.end[1] - tailIn[1]] },
  ];
}

const [prefix, ...names] = process.argv.slice(2);
let T = { pairs: 0, sameW: 0, diffW: 0, multi: 0, corner: 0 };
for (const name of names) {
  const sc = JSON.parse(await fs.readFile(`outputs/v4/v4_${prefix}_${name}/scene.json`, "utf8")) as {
    primitives: { cls: string; d?: string; width?: number; qaWidth?: number }[];
  };
  const all: End[] = [];
  sc.primitives.forEach((p, i) => {
    if (p.cls !== "STRUCTURAL_STROKE" || !p.d) return;
    const subs = parsePath(p.d);
    const w = p.qaWidth ?? p.width ?? 0;
    for (const s of subs) all.push(...endsOf(s, i, subs.length > 1, w));
  });
  const c = { pairs: 0, sameW: 0, diffW: 0, multi: 0, corner: 0 };
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    if (a.prim === b.prim) continue;
    const gap = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]);
    if (gap > 6) continue;
    const na = Math.hypot(a.t[0], a.t[1]), nb = Math.hypot(b.t[0], b.t[1]);
    if (na < 1e-6 || nb < 1e-6) continue;
    const turn = (Math.acos(Math.max(-1, Math.min(1, -(a.t[0] * b.t[0] + a.t[1] * b.t[1]) / (na * nb)))) * 180) / Math.PI;
    if (turn > 150) continue;
    c.pairs++;
    if (a.multi || b.multi) c.multi++;
    else if (Math.abs(a.w - b.w) > 1e-6) c.diffW++;
    else { c.sameW++; if (turn > 60) c.corner++; }
  }
  for (const k of Object.keys(T) as (keyof typeof T)[]) T[k] += c[k];
  console.log(`${name.padEnd(10)} 6px·≤150° 쌍 ${String(c.pairs).padStart(4)} — 굵기 같음(진짜 잔여) ${String(c.sameW).padStart(3)} (그중 코너 ${c.corner}) · 굵기 다름(의도) ${String(c.diffW).padStart(3)} · 다중 서브패스 ${String(c.multi).padStart(3)}`);
}
console.log(`합계        쌍 ${T.pairs} — 굵기 같음 ${T.sameW} (코너 ${T.corner}) · 굵기 다름 ${T.diffW} · 다중 서브패스 ${T.multi}`);
