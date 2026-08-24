/**
 * 저장된 scene.json 에서 export 산출물만 다시 굽는다 — 파이프라인은 돌리지 않는다.
 *
 *   npx tsx server/v4/rebuild-exports.ts
 *
 * 표현 라우팅 결과(scene)는 그대로다. 바뀐 것은 그 장면을 파일로 옮기는 규칙뿐이다.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { VectorScene } from "./types.js";
import { exportFidelity, exportEditable, exportProduction } from "./export.js";
import { exportAi, sceneToAiDoc } from "./aiExport.js";
import { buildJsx } from "../writers/jsxWriter.js";
import type { VectorIR } from "../types.js";

const ORDER = ["shoe_1", "shoe_2", "shoe_3", "bag_1", "bag_2", "bag_3", "jewelry_1", "jewelry_2", "jewelry_3"];
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));

console.log();
for (const name of only.length ? only : ORDER) {
  const src = path.join("outputs", "v4", `v4_${name}`);
  const scene = JSON.parse(await fs.readFile(path.join(src, "scene.json"), "utf8")) as VectorScene;

  const files: Record<string, string | Buffer> = {
    "fidelity.svg": exportFidelity(scene),
    "editable.svg": exportEditable(scene),
    "production.svg": exportProduction(scene),
    "layered.ai": exportAi(scene),
  };

  const doc = sceneToAiDoc(scene);
  const ir: VectorIR = {
    width: doc.width, height: doc.height,
    layers: doc.layers.map((l) => ({
      name: l.name,
      groups: l.groups.map((g) => ({
        name: g.name,
        paths: g.paths.map((p) => ({
          d: p.d, fill: p.fill, stroke: p.stroke,
          strokeWidth: p.strokeWidth, vectorizer: "vtracer" as const,
        })),
      })),
    })),
  };
  files["native-layers.jsx"] = buildJsx(ir, `${name}.ai`);

  for (const dir of [src, path.join("docs", "samples-v4", name)]) {
    await fs.mkdir(dir, { recursive: true });
    for (const [f, body] of Object.entries(files)) await fs.writeFile(path.join(dir, f), body as never);
  }

  const groups = doc.layers.reduce((s, l) => s + l.groups.length, 0);
  const paths = doc.layers.reduce((s, l) => s + l.groups.reduce((t, g) => t + g.paths.length, 0), 0);
  console.log(
    `  ${name.padEnd(11)} 레이어 ${String(doc.layers.length).padStart(2)} · 하위 ${String(groups).padStart(3)} · ` +
    `패스 ${String(paths).padStart(5)} · ai ${((files["layered.ai"] as Buffer).length / 1024 / 1024).toFixed(2)}MB`,
  );
}
