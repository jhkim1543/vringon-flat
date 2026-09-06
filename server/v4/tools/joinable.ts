/**
 * **이어 붙일 수 있었는데 안 붙은 획**을 센다.
 *
 * 매끄러운 선 한 줄에 앵커가 뭉치는 가장 흔한 원인은 곡선 피팅이 아니라 **획이 잘려
 * 있다는 것**이다. 획이 끊기면 끝점마다 앵커가 하나씩 박히고, 앵커 솎기는 서브패스
 * 안에서만 도므로 그 끝점들을 영영 못 없앤다.
 *
 * 여기서는 "끝점 A 와 끝점 B 가 가깝고, 접선이 이어지면 한 획이었어야 한다"를 센다.
 */
import fs from "node:fs/promises";
import { parsePath, type Pt } from "../../vector/pathdata.js";
import type { VectorScene, StrokePrimitive } from "../types.js";

const NEAR = Number(process.env.J_NEAR ?? 6);      // 끝점 사이 거리(작업 px)
const TURN = Number(process.env.J_TURN ?? 60);     // 접선이 꺾이는 허용 각(도)

function ends(d: string): { p: Pt; t: Pt }[] {
  const out: { p: Pt; t: Pt }[] = [];
  for (const sp of parsePath(d)) {
    if (sp.closed || !sp.segs.length) continue;
    const first = sp.segs[0];
    const head = first.type === "L" ? first.end : first.c1!;
    out.push({ p: sp.start, t: [sp.start[0] - head[0], sp.start[1] - head[1]] });
    const last = sp.segs[sp.segs.length - 1];
    const prev = sp.segs.length > 1 ? sp.segs[sp.segs.length - 2].end : sp.start;
    const tail = last.type === "L" ? prev : last.c2!;
    out.push({ p: last.end, t: [last.end[0] - tail[0], last.end[1] - tail[1]] });
  }
  return out;
}

for (const name of process.argv.slice(2)) {
  let sc: VectorScene;
  try { sc = JSON.parse(await fs.readFile(`outputs/v4/v4_${name}/scene.json`, "utf8")) as VectorScene; }
  catch { console.log(`  ${name}: 없음`); continue; }

  const all: { p: Pt; t: Pt; id: string }[] = [];
  for (const p of sc.primitives) {
    if (p.cls !== "STRUCTURAL_STROKE" && p.cls !== "DASH_OR_STITCH") continue;
    for (const e of ends((p as StrokePrimitive).d)) all.push({ ...e, id: p.id });
  }
  const cell = Math.max(NEAR, 2);
  const grid = new Map<string, typeof all>();
  for (const e of all) {
    const k = `${Math.floor(e.p[0] / cell)},${Math.floor(e.p[1] / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(e);
  }
  let pairs = 0, sameId = 0;
  const used = new Set<typeof all[number]>();
  for (const a of all) {
    if (used.has(a)) continue;
    const gx = Math.floor(a.p[0] / cell), gy = Math.floor(a.p[1] / cell);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const b of grid.get(`${gx + i},${gy + j}`) ?? []) {
          if (b === a || used.has(b)) continue;
          if (Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]) > NEAR) continue;
          // 접선: 두 끝점이 서로 마주 보며 이어지려면 방향이 반대여야 한다
          const na = Math.hypot(a.t[0], a.t[1]), nb = Math.hypot(b.t[0], b.t[1]);
          if (na < 1e-6 || nb < 1e-6) continue;
          const cos = (a.t[0] * b.t[0] + a.t[1] * b.t[1]) / (na * nb);
          const turn = (Math.acos(Math.max(-1, Math.min(1, -cos))) * 180) / Math.PI;
          if (turn > TURN) continue;
          used.add(a); used.add(b);
          pairs++;
          if (a.id === b.id) sameId++;
          break;
        }
      }
    }
  }
  console.log(
    `${name.padEnd(16)} 열린 끝점 ${String(all.length).padStart(5)} · ` +
    `이어 붙일 수 있는 쌍 ${String(pairs).padStart(4)} (끝점의 ${((pairs * 2 / Math.max(1, all.length)) * 100).toFixed(0)}%) · ` +
    `그중 같은 프리미티브 안 ${sameId}`,
  );
}
