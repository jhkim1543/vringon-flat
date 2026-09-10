import { CODE_VERSION } from "./version.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

export function selectGeometry(raw:string,mono:string|undefined,recomposedMono:string|undefined,grayscale:boolean):string {
  return recomposedMono??(!grayscale&&mono?mono:raw);
}
/** Preserve exact geometry provenance, not a resized public JPEG preview. */
export async function writeStageManifest(output:string,inputs:{role:string;file:string}[],geometry:string):Promise<void> {
  const entries=[];
  for(const x of inputs) {
    const bytes=await fs.readFile(x.file),meta=await sharp(bytes).metadata();
    entries.push({role:x.role,file:path.relative(path.dirname(output),x.file),width:meta.width,height:meta.height,
      sha256:crypto.createHash("sha256").update(bytes).digest("hex"),selectedForGeometry:path.resolve(x.file)===path.resolve(geometry)});
  }
  await fs.writeFile(output,JSON.stringify({version:CODE_VERSION,geometry:path.relative(path.dirname(output),geometry),entries},null,2));
}
