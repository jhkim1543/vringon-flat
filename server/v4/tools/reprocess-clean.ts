import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { sceneFromEditor } from "../editorImport.js";
import { cleanFinish } from "../cleanFinish.js";
import { exportProduction, complexity } from "../export.js";
import { exportAi } from "../aiExport.js";
import { auditContinuity } from "../continuityAudit.js";
import type { VectorScene } from "../types.js";

const [input,output,metaPath]=process.argv.slice(2);
if(!input||!output)throw new Error("Usage: tsx server/v4/tools/reprocess-clean.ts scene-or-editor.json output-dir [sample-meta.json]");
await fs.mkdir(output,{recursive:true});
const data=JSON.parse(await fs.readFile(input,"utf8"));
const meta=metaPath?JSON.parse(await fs.readFile(metaPath,"utf8")):null;
const scene:VectorScene=data.primitives?data:sceneFromEditor(data,meta?.canvas);
const baseline=structuredClone(scene),beforeSvg=exportProduction(baseline),before=complexity(beforeSvg);
const t=performance.now(),report=await cleanFinish(scene,path.join(output,"work"),console.log);
const svg=exportProduction(scene),after=complexity(svg);
await fs.writeFile(path.join(output,"scene.json"),JSON.stringify(scene));
await fs.writeFile(path.join(output,"before.svg"),beforeSvg);
await fs.writeFile(path.join(output,"production.svg"),svg);
await fs.writeFile(path.join(output,"layered.ai"),exportAi(scene));
await fs.writeFile(path.join(output,"by-part.ai"),exportAi(scene,"part"));
await fs.writeFile(path.join(output,"by-color.ai"),exportAi(scene,"color"));
const summary={scope:data.primitives?"postprocessing scene replay":"live editor geometry replay; upstream masks and qaWidth unavailable",
  before,after,seconds:(performance.now()-t)/1000,continuityBefore:auditContinuity(baseline.primitives,{scale:report.scale}),continuityAfter:auditContinuity(scene.primitives,{scale:report.scale}),report};
await fs.writeFile(path.join(output,"report.json"),JSON.stringify(summary,null,2));
for(const [name,src] of [["before",beforeSvg],["after",svg]])await sharp(Buffer.from(src)).resize({width:1200}).flatten({background:"white"}).png().toFile(path.join(output,name+".png"));
console.log(JSON.stringify({before,after,seconds:summary.seconds,changes:{spurs:report.contours.spurIds,joins:report.contours.joined.length,
  smoothed:report.contours.smoothed.length,glyphs:report.glyphs}},null,2));
