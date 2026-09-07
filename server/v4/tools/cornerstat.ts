/**
 * 끝점 접촉 통계 — **이어 붙일 수 있는데 안 붙은 자리가 어떤 모양인가.**
 *
 * bridgeGaps 는 꺾임 ≤60° 만 잇는다. 리뷰(2026-09-07)의 지적: 두 획이 **코너에서**
 * 맞닿은 2갈래 접촉은 꺾임이 커도 한 획으로 잇고 코너 앵커를 고정하는 것이
 * 편집 단위로 맞다 — 끝점 둘(앵커 2)이 코너 하나(앵커 1)가 된다.
 * 그 후보가 실제로 몇 개인지 6px 안 끝점 쌍을 (갈래 수 × 꺾임) 으로 나눠 센다.
 *
 *   npx tsx server/v4/tools/cornerstat.ts <접두> <이름...>     예) v7e shoe_1 bag_1
 */
import fs from "node:fs/promises";
import { parsePath, type Pt, type SubPath } from "../../vector/pathdata.js";

type End = { id: number; p: Pt; t: Pt; w: number };

function endsOf(sub: SubPath, id: number, w = 0): End[] {
  if (sub.closed || !sub.segs.length) return [];
  const f = sub.segs[0];
  const headIn = f.type === "L" ? f.end : f.c1!;
  const l = sub.segs[sub.segs.length - 1];
  const prev = sub.segs.length > 1 ? sub.segs[sub.segs.length - 2].end : sub.start;
  const tailIn = l.type === "L" ? prev : l.c2!;
  return [
    { id, p: sub.start, t: [sub.start[0] - headIn[0], sub.start[1] - headIn[1]], w },
    { id, p: l.end, t: [l.end[0] - tailIn[0], l.end[1] - tailIn[1]], w },
  ];
}

const [prefix, ...names] = process.argv.slice(2);
for (const name of names) {
  const sc = JSON.parse(await fs.readFile(`outputs/v4/v4_${prefix}_${name}/scene.json`, "utf8")) as {
    primitives: { cls: string; d?: string; width?: number }[];
  };
  const all: End[] = [];
  let id = 0;
  for (const p of sc.primitives) {
    if (p.cls !== "STRUCTURAL_STROKE" || !p.d) continue;
    const subs = parsePath(p.d);
    if (subs.length !== 1) continue;
    all.push(...endsOf(subs[0], id++, p.width ?? 0));
  }
  const R = 6;
  const nearOthers = (e: End) =>
    all.filter((o) => o.id !== e.id && Math.hypot(o.p[0] - e.p[0], o.p[1] - e.p[1]) <= R).length;
  const buckets = new Map<string, number>();
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.id === b.id) continue;
      const gap = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]);
      if (gap > R) continue;
      const na = Math.hypot(a.t[0], a.t[1]), nb = Math.hypot(b.t[0], b.t[1]);
      if (na < 1e-6 || nb < 1e-6) continue;
      const cos = (a.t[0] * b.t[0] + a.t[1] * b.t[1]) / (na * nb);
      const turn = (Math.acos(Math.max(-1, Math.min(1, -cos))) * 180) / Math.PI;
      const deg2 = nearOthers(a) === 1 && nearOthers(b) === 1;
      const tb = turn <= 60 ? "a<=60" : turn <= 90 ? "b60-90" : turn <= 120 ? "c90-120" : turn <= 150 ? "d120-150" : "e>150";
      const k = `${deg2 ? "2way" : "nway"} ${tb}${Math.abs(a.w - b.w) > 1e-6 ? "*" : ""}`;  // * = 굵기 다름
      buckets.set(k, (buckets.get(k) ?? 0) + 1);
    }
  }
  const rows = [...buckets.entries()].sort().map(([k, v]) => `${k}=${v}`).join("  ");
  console.log(`${name.padEnd(10)} open-ends ${String(all.length).padStart(5)}  ${rows}`);
}
