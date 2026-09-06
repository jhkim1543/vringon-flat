/** 대시꼴 획 사이의 실제 이웃 관계 — 캐리어 체이닝 문턱을 실측으로 정하기 위해. */
import fs from "node:fs/promises";
import { parsePath, type Pt } from "../../vector/pathdata.js";
import type { VectorScene, StrokePrimitive } from "../types.js";

const name = process.argv[2];
const sc = JSON.parse(await fs.readFile(`outputs/v4/v4_${name}/scene.json`, "utf8")) as VectorScene;
interface D { a: Pt; b: Pt; dir: Pt; len: number; w: number }
const ds: D[] = [];
for (const p of sc.primitives) {
  if (p.cls !== "STRUCTURAL_STROKE") continue;
  const st = p as StrokePrimitive;
  const subs = parsePath(st.d);
  if (subs.length !== 1 || subs[0].closed) continue;
  const sp = subs[0];
  const a = sp.start, b = sp.segs[sp.segs.length - 1].end;
  let len = 0; let cur = a;
  for (const s of sp.segs) { len += Math.hypot(s.end[0] - cur[0], s.end[1] - cur[1]); cur = s.end; }
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len > 45 || sp.segs.length > 3 || chord < 3 || chord / len < 0.88) continue;
  ds.push({ a, b, dir: [(b[0] - a[0]) / chord, (b[1] - a[1]) / chord], len, w: st.width });
}
console.log(`${name}: 대시꼴 ${ds.length}개`);
// 각 대시의 b 에서 가장 가까운 다른 대시 끝점까지 — gap · cos · lateral 분포
const gaps: number[] = [], coss: number[] = [], lats: number[] = [], ratios: number[] = [];
for (const d of ds) {
  let best: { gap: number; cos: number; lat: number } | null = null;
  for (const c of ds) {
    if (c === d) continue;
    for (const [start, dir] of [[c.a, c.dir], [c.b, [-c.dir[0], -c.dir[1]]]] as [Pt, Pt][]) {
      const gap = Math.hypot(d.b[0] - start[0], d.b[1] - start[1]);
      if (gap > 120) continue;
      const cos = d.dir[0] * dir[0] + d.dir[1] * dir[1];
      const vx = start[0] - d.b[0], vy = start[1] - d.b[1];
      const fwd = vx * d.dir[0] + vy * d.dir[1];
      if (fwd < -1) continue;
      const lat = Math.abs(vx * -d.dir[1] + vy * d.dir[0]);
      if (!best || gap < best.gap) best = { gap, cos, lat };
    }
  }
  if (best) { gaps.push(best.gap); coss.push(best.cos); lats.push(best.lat); ratios.push(best.gap / Math.max(1, d.len)); }
}
const q = (arr: number[], p: number) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
console.log(`  gap      p25 ${q(gaps, .25).toFixed(1)} · 중앙 ${q(gaps, .5).toFixed(1)} · p75 ${q(gaps, .75).toFixed(1)} · p90 ${q(gaps, .9).toFixed(1)}`);
console.log(`  gap/len  p25 ${q(ratios, .25).toFixed(2)} · 중앙 ${q(ratios, .5).toFixed(2)} · p75 ${q(ratios, .75).toFixed(2)} · p90 ${q(ratios, .9).toFixed(2)}`);
console.log(`  cos      p10 ${q(coss, .1).toFixed(3)} · p25 ${q(coss, .25).toFixed(3)} · 중앙 ${q(coss, .5).toFixed(3)}`);
console.log(`  lateral  p50 ${q(lats, .5).toFixed(1)} · p75 ${q(lats, .75).toFixed(1)} · p90 ${q(lats, .9).toFixed(1)}`);
console.log(`  대시 길이 중앙 ${q(ds.map(d=>d.len), .5).toFixed(1)} · 굵기 중앙 ${q(ds.map(d=>d.w), .5).toFixed(1)}`);
