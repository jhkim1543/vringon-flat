/**
 * 앵커가 **어디에 사는지** — 줄이려면 먼저 어디가 살쪘는지 알아야 한다.
 *
 *   끝점   획의 시작·끝 (M + 마지막 앵커). 획이 존재하는 한 필요하지만, 획이 잘게
 *          쪼개져 있으면 여기가 부풀어 있다.
 *   곡선   중간 앵커. 피팅 허용오차가 정하는 몫.
 *   대시꼴 짧고 곧은 획 — 점선 속성 하나로 접을 수 있는 후보.
 */
import fs from "node:fs/promises";
import { parsePath } from "../../vector/pathdata.js";
import type { VectorScene, StrokePrimitive } from "../types.js";

for (const name of process.argv.slice(2)) {
  const sc = JSON.parse(await fs.readFile(`outputs/v4/v4_${name}/scene.json`, "utf8")) as VectorScene;
  const by: Record<string, { n: number; end: number; mid: number }> = {};
  let dashish = 0, dashishAnchors = 0, shortStrokes = 0;
  for (const p of sc.primitives) {
    const d = (p as { d?: string }).d;
    if (!d) continue;
    const cls = p.cls;
    by[cls] ??= { n: 0, end: 0, mid: 0 };
    by[cls].n++;
    for (const sp of parsePath(d)) {
      const segAnchors = sp.segs.length;                       // 도착 앵커들
      if (sp.closed) { by[cls].mid += segAnchors; continue; }  // 닫힘: 전부 중간 취급
      by[cls].end += 2;
      by[cls].mid += Math.max(0, segAnchors - 1);
      if (cls === "STRUCTURAL_STROKE") {
        // 대시꼴: 짧고(<=45px) 앵커 적고(<=4) 거의 곧다
        let L = 0; let cur = sp.start;
        for (const s of sp.segs) { L += Math.hypot(s.end[0] - cur[0], s.end[1] - cur[1]); cur = s.end; }
        const a = segAnchors + 1;
        if (L <= 45 && a <= 4) { dashish++; dashishAnchors += a; }
        if (L <= 60) shortStrokes++;
      }
    }
  }
  console.log(`\n=== ${name} ===`);
  let totE = 0, totM = 0;
  for (const [k, v] of Object.entries(by)) {
    totE += v.end; totM += v.mid;
    console.log(`  ${k.padEnd(22)} ${String(v.n).padStart(4)}개 · 끝점 ${String(v.end).padStart(5)} · 중간 ${String(v.mid).padStart(5)}`);
  }
  const tot = totE + totM;
  console.log(`  합계 ${tot.toLocaleString()} — 끝점 ${totE.toLocaleString()} (${(totE / tot * 100).toFixed(0)}%) · 중간 ${totM.toLocaleString()} (${(totM / tot * 100).toFixed(0)}%)`);
  console.log(`  대시꼴 획 ${dashish}개 (앵커 ${dashishAnchors} — 점선 속성으로 접을 후보) · 60px 미만 획 ${shortStrokes}`);
}
