/** buildDashChains 문턱 시나리오를 재실행 없이 비교 — scene 의 획을 그대로 먹인다. */
import fs from "node:fs/promises";
import { parsePath } from "../../vector/pathdata.js";
import type { VectorScene, StrokePrimitive } from "../types.js";
import { buildDashChains } from "../dashCarrier.js";

for (const name of process.argv.slice(2)) {
  const sc = JSON.parse(await fs.readFile(`outputs/v4/v4_${name}/scene.json`, "utf8")) as VectorScene;
  const items = sc.primitives
    .filter((p) => p.cls === "STRUCTURAL_STROKE")
    .map((p) => ({ d: (p as StrokePrimitive).d, width: (p as StrokePrimitive).width, partId: p.partId }));
  const open = items.filter((x) => { const s = parsePath(x.d); return s.length === 1 && !s[0].closed; }).length;
  const chains = buildDashChains(items);
  const saved = chains.reduce((a, c) => a + c.anchorsBefore - c.carrierAnchors, 0);
  const consumed = chains.reduce((a, c) => a + c.members.length, 0);
  console.log(`${name.padEnd(16)} 열린 획 ${open} → 체인 ${chains.length}줄 · 대시 ${consumed}개 소비 · 앵커 ${saved} 절감` +
    (chains.length ? ` · 예: dash=[${chains[0].dashArray}] 멤버 ${chains[0].members.length}` : ""));
}
