import fs from "node:fs/promises";
import { sceneToAiDoc } from "../aiExport.js";
for (const n of process.argv.slice(2)) {
  const sc = JSON.parse(await fs.readFile(`outputs/v4/v4_${n}/scene.json`, "utf8"));
  const doc = sceneToAiDoc(sc);
  console.log(`\n${n}`);
  for (const l of doc.layers) {
    console.log(`  ${l.name.padEnd(20)} 하위 ${String(l.groups.length).padStart(2)} · 패스 ${l.groups.reduce((a, g) => a + g.paths.length, 0)}`);
  }
}
