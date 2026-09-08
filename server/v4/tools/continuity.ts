/**
 * 연속성 감사 도구 — `npx tsx server/v4/tools/continuity.ts <scene.json> [...]`
 *
 * 계산은 `server/v4/continuityAudit.ts` 한 곳에 있다. 여기서는 읽고 찍기만 한다 —
 * 같은 계산을 두 벌 두면 언젠가 갈라져서 두 숫자가 다르게 나온다.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { auditContinuity } from "../continuityAudit.js";

for (const file of process.argv.slice(2)) {
  const scene = JSON.parse(await fs.readFile(file, "utf8"));
  const r = auditContinuity(scene.primitives ?? []);
  const name = path.basename(path.dirname(file));
  console.log(
    `${name.padEnd(22)} 끝점 ${String(r.ends).padStart(4)} · 자유끝 ${String(r.free).padStart(4)}`
    + ` · 긴획 자유끝 ${String(r.freeLong).padStart(3)}/${String(r.longEnds).padStart(4)}`
    + ` (면에 닿아 끝 ${r.freeLongAtFill}) · 갈라진이음 ${String(r.splitJoins).padStart(3)}`,
  );
}
