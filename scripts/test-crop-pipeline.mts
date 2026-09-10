import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
const [sourceRoot,input,output]=process.argv.slice(2);
if(!sourceRoot||!input||!output)throw new Error("Usage: tsx scripts/test-crop-pipeline.mts source-root image.png output-dir");
const mod=await import(pathToFileURL(path.resolve(sourceRoot,"server/v4/scene.ts")).href);
const exp=await import(pathToFileURL(path.resolve(sourceRoot,"server/v4/export.ts")).href);
const ai=await import(pathToFileURL(path.resolve(sourceRoot,"server/v4/aiExport.ts")).href);
const m=await sharp(input).metadata();
await fs.mkdir(output,{recursive:true});
const {scene}=await mod.buildScene(path.resolve(input),{...mod.DEFAULT_SCENE_OPTIONS,
  workDir:path.resolve(output,"work"),workLong:Math.max(m.width!,m.height!),lineMode:true,strokeLines:true,thinFinish:true,widthGrades:3,textureMode:"keep"},console.log);
const svg=exp.exportProduction(scene);
await fs.writeFile(path.join(output,"scene.json"),JSON.stringify(scene));
await fs.writeFile(path.join(output,"production.svg"),svg);
await sharp(Buffer.from(svg)).flatten({background:"white"}).png().toFile(path.join(output,"preview.png"));
await fs.writeFile(path.join(output,"stats.json"),JSON.stringify({canvas:scene.canvas,...exp.complexity(svg)},null,2));
await fs.writeFile(path.join(output,"layered.ai"),ai.exportAi(scene));
try {await fs.copyFile(path.join(output,"work/clean-finish.json"),path.join(output,"cleanup-report.json"));}catch{}
console.log(exp.complexity(svg));
