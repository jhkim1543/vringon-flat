/** 획 위 이웃 앵커 간 호길이 간격 — 선 굵기보다 가까우면 "겹쳐 보인다". */
import fs from "node:fs/promises";
import { parsePath } from "../../vector/pathdata.js";
import type { VectorScene, StrokePrimitive } from "../types.js";

for (const name of process.argv.slice(2)) {
  const sc = JSON.parse(await fs.readFile(`outputs/v4/v4_${name}/scene.json`, "utf8")) as VectorScene;
  const gaps: number[] = [];
  let overlapped = 0, total = 0;
  for (const p of sc.primitives) {
    if (p.cls !== "STRUCTURAL_STROKE" && p.cls !== "DASH_OR_STITCH") continue;
    const st = p as StrokePrimitive;
    for (const sp of parsePath(st.d)) {
      let cur = sp.start;
      for (const s of sp.segs) {
        const g = Math.hypot(s.end[0] - cur[0], s.end[1] - cur[1]);
        gaps.push(g); total++;
        if (g < st.width) overlapped++;
        cur = s.end;
      }
    }
  }
  gaps.sort((a, b) => a - b);
  const q = (p: number) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
  console.log(
    `${name.padEnd(14)} 간격 p10 ${q(0.1).toFixed(1)} · 중앙 ${q(0.5).toFixed(1)} · p90 ${q(0.9).toFixed(0)}px` +
    ` · 선 굵기보다 가까운(겹쳐 보임) ${overlapped}/${total} (${(overlapped / total * 100).toFixed(0)}%)`,
  );
}
