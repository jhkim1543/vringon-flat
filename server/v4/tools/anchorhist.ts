/**
 * 정식 9종의 **현재 .ai 실앵커** — 역대 판(V4.7~V5.2)과 같은 대상으로 잰다.
 *
 * 계수기 주의: 역대 수치는 패턴을 인스턴스마다 펼친 파일에서 쟀다. 지금은 모티프가
 * XObject 로 한 번만 들어가므로, 공정 비교를 위해 **둘 다** 찍는다.
 *   저장 기준   파일에 실제로 있는 앵커 (모티프 1벌)
 *   펼침 환산   모티프 앵커 × 인스턴스 수 (역대 계수 방식)
 */
import fs from "node:fs/promises";
import { readAiAnchors } from "../ai-anchor-render.js";
import type { VectorScene, PatternPrimitive } from "../types.js";

const NAMES = ["shoe_1", "shoe_2", "shoe_3", "bag_1", "bag_2", "bag_3", "jewelry_1", "jewelry_2", "jewelry_3"];
let stored = 0, expanded = 0;
console.log("\n샘플        저장기준   펼침환산");
for (const n of NAMES) {
  try {
    const a = await readAiAnchors(`outputs/v4/v4_${n}/layered.ai`);
    const sc = JSON.parse(await fs.readFile(`outputs/v4/v4_${n}/scene.json`, "utf8")) as VectorScene;
    // 펼침 환산: 저장 기준 + 모티프앵커 × (인스턴스-1)
    let extra = 0;
    for (const p of sc.primitives) {
      if (p.cls !== "REPEATING_PATTERN") continue;
      const t = p as PatternPrimitive;
      const mA = (t.motif.match(/[MLC]/g) ?? []).length;
      extra += mA * Math.max(0, t.instances.length - 1);
    }
    stored += a.dots.length;
    expanded += a.dots.length + extra;
    console.log(`${n.padEnd(11)} ${String(a.dots.length).padStart(7)}  ${String(a.dots.length + extra).padStart(8)}`);
  } catch { console.log(`${n.padEnd(11)}   없음`); }
}
console.log(`${"합계".padEnd(10)} ${String(stored).padStart(7)}  ${String(expanded).padStart(8)}`);
