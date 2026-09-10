import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),root=process.cwd();
const out='results/v7.9',validation='results/v7.9/validation';
await fs.mkdir(validation,{recursive:true});
const hashes:Record<string,string>={},summaries:any[]=[];
const hash=async(p:string)=>crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex');
for(const id of ['jewelry_1','shoe_1','bag_2','bag_3']) {
  const input=`fixtures/live-v7.7/${id}/editor-doc.json`,meta=`fixtures/live-v7.7/${id}.json`;
  hashes[input]=await hash(input);hashes[meta]=await hash(meta);
  const r=await run(process.execPath,['--import','tsx','server/v4/tools/reprocess-clean.ts',input,`${out}/${id}`,meta],{cwd:root,maxBuffer:10*1024*1024});
  await fs.writeFile(`${validation}/${id}.log`,r.stdout+r.stderr);
  const report=JSON.parse(await fs.readFile(`${out}/${id}/report.json`,'utf8'));
  if(report.report.finalAudit.newFreeEnds.length)throw new Error(`${id}: new disconnected long-stroke endpoints`);
  if(report.after.uses!==report.before.uses)throw new Error(`${id}: pattern instance count changed`);
  summaries.push({id,before:report.before,after:report.after,seconds:report.seconds,
    spurs:report.report.contours.spurIds.length,hooks:report.report.contours.trimmedHookIds.length,specks:report.report.contours.speckIds.length,
    joins:report.report.contours.joined.length+report.report.postGlyphJoins.length,glyphs:report.report.glyphs,
    topology:report.report.topology,finalAudit:report.report.finalAudit,continuityBefore:report.continuityBefore,continuityAfter:report.continuityAfter,
    maxAcceptedDeviationSourcePx:Math.max(0,...report.report.contours.smoothed.map((x:any)=>x.deviationSourcePx))});
  hashes[`${out}/${id}/production.svg`]=await hash(`${out}/${id}/production.svg`);
  console.log(id,report.before.anchors,'->',report.after.anchors);
}
// The input is the exact same saved editor geometry; no live model calls occur.
const repeat='results/repeat-jewelry';
await run(process.execPath,['--import','tsx','server/v4/tools/reprocess-clean.ts','fixtures/live-v7.7/jewelry_1/editor-doc.json',repeat,'fixtures/live-v7.7/jewelry_1.json'],{cwd:root,maxBuffer:10*1024*1024});
const repeated=await hash(`${repeat}/production.svg`),original=hashes[`${out}/jewelry_1/production.svg`];
if(repeated!==original)throw new Error('Identical-input SVG replay differs');
await fs.writeFile(`${validation}/replay-summary.json`,JSON.stringify({scope:'Fixed public editor geometry replay, not photo/model/semantic-mask end-to-end QA',summaries,hashes,determinism:{sample:'jewelry_1',svgSha256:original,repeatedSvgSha256:repeated,equal:true}},null,2));
await fs.rm(repeat,{recursive:true,force:true});
