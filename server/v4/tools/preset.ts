import fs from "node:fs/promises";
import { sceneToAiDoc, type LayerPreset } from "../aiExport.js";
const n = process.argv[2];
const sc = JSON.parse(await fs.readFile(`outputs/v4/v4_${n}/scene.json`, "utf8"));
for (const p of ["function", "part", "color"] as LayerPreset[]) {
  const doc = sceneToAiDoc(sc, p);
  const paths = doc.layers.reduce((a, l) => a + l.groups.reduce((b, g) => b + g.paths.length, 0), 0);
  console.log(`\n[${p}] 레이어 ${doc.layers.length} · 패스 ${paths}`);
  for (const l of doc.layers.slice(0, 8)) {
    console.log(`   ${l.name.padEnd(22)} 하위 ${String(l.groups.length).padStart(2)} · 패스 ${l.groups.reduce((a, g) => a + g.paths.length, 0)}`);
  }
}
