import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildStrokeGraph, repairJunctionTopology, cyclicBlocks } from "../../vector/junctionTopology.js";
import { parsePath, type Pt } from "../../vector/pathdata.js";
import { sampleSubpath, distance, dot, minus, unit } from "../../vector/curveGeometry.js";
import { repairSceneJunctions } from "../junctionRepair.js";
import { joinMicroGaps, cleanContours, smoothStroke } from "../cleanContours.js";
import { cleanFinish } from "../cleanFinish.js";
import { bridgeEvidenceGaps } from "../gapBridge.js";
import { applyCleanupReview } from "../qa4.js";
import { atomicMemo } from "../atomicMemo.js";
import { selectGeometry, writeStageManifest } from "../stageManifest.js";
import type { StrokePrimitive, VectorScene } from "../types.js";

const stroke=(id:string,d:string,partId="body"):StrokePrimitive=>({id,d,partId,cls:"STRUCTURAL_STROKE",width:1.4,color:"#111111",area:0,bbox:[0,0,200,200],route:{chosen:"STRUCTURAL_STROKE",features:{},why:"test",confidence:1}});
const scene=(primitives:VectorScene["primitives"]):VectorScene=>({canvas:{width:240,height:200,sourceWidth:240,sourceHeight:200,supersample:1},primitives,
 parts:[{id:"body",label:"body",kind:"body",confidence:1,z:0,occludedBy:[]}],sharedBoundaries:[],correspondence:{method:"none",confident:true,aspectRatio:1,note:""},
 provenance:{pipeline:"test",schematic:{backend:"fixture",prompt:"",seed:null},createdAt:"",lowConfidence:0}});
const tri:Pt[][]=[[[90,100],[100,97],[110,100]],[[90,100],[100,103],[110,100]],[[0,100],[90,100]],[[110,100],[210,100]],[[100,97],[100,40]]];
const graph=(pp:Pt[][],scale=1)=>buildStrokeGraph(pp.map((points,source)=>({source,points:points.map(p=>[p[0]*scale,p[1]*scale] as Pt)})),0.01*scale);

for(const scale of [1,2,4])test(`small multi-path knot is contracted at scale ${scale}`,()=>{
 const input=graph(tri,scale),r=repairJunctionTopology(input,scale);
 assert.equal(r.report.cyclesBefore,1);assert.equal(r.report.cyclesAfter,0);assert.equal(r.report.repaired.length,1);
 const q=r.report.repaired[0].junction!;assert.ok(distance(q,[100*scale,100*scale])<scale);
 const ends=r.graph.edges.flatMap(e=>[e.points[0],e.points.at(-1)!]);
 for(const p of [[0,100],[210,100],[100,40]] as Pt[])assert.ok(ends.some(e=>distance(e,[p[0]*scale,p[1]*scale])<1e-8));
});
test("an actual two-arm chain link is not collapsed",()=>{
 const g=graph(tri.slice(0,4)),r=repairJunctionTopology(g,1);assert.equal(r.report.repaired.length,0);assert.equal(r.report.cyclesAfter,1);
});
test("semantic eyelet protection overrides a three-arm geometric candidate",()=>{
 const g=graph(tri);g.edges[0].protected=true;const r=repairJunctionTopology(g,1);assert.equal(r.report.repaired.length,0);assert.equal(r.report.cyclesAfter,1);
});
test("closed letter counter is preserved byte-for-byte",()=>{
 const s=scene([stroke("counter","M90 100L100 97L110 100L100 103Z","letter"),stroke("a","M0 100L90 100","letter"),stroke("b","M110 100L210 100","letter"),stroke("c","M100 97L100 40","letter")]);
 const before=JSON.stringify(s);repairSceneJunctions(s,1);assert.equal(JSON.stringify(s),before);
});
test("crossing four arms does not create a repaired junction",()=>{
 const g=buildStrokeGraph([{source:0,points:[[0,100],[200,100]]},{source:1,points:[[100,0],[100,200]]}],0.01,true);
 assert.equal(cyclicBlocks(g).length,0);assert.equal(repairJunctionTopology(g,1).report.repaired.length,0);
});
test("two intersecting paths can form a cycle without any closed path",()=>{
 const g=buildStrokeGraph([{source:0,points:[[0,100],[200,100]]},{source:1,points:[[70,100],[100,90],[130,110],[150,140]]}],0.01,true);
 assert.equal(cyclicBlocks(g).reduce((n,b)=>n+b.rank,0),1);
});
test("different semantic parts are never contracted together",()=>{
 const s=scene(tri.map((p,i)=>stroke(`p${i}`,"M"+p.map(x=>x.join(" ")).join("L"),i===0?"front":"back")));
 const before=JSON.stringify(s);assert.equal(repairSceneJunctions(s,1).repaired.length,0);assert.equal(JSON.stringify(s),before);
});
test("repair switch leaves geometry unchanged",()=>{
 const s=scene(tri.map((p,i)=>stroke(`p${i}`,"M"+p.map(x=>x.join(" ")).join("L"))));const before=JSON.stringify(s);
 repairSceneJunctions(s,1,false);assert.equal(JSON.stringify(s),before);
});
test("six-pixel interruption of two long collinear contours is repaired",()=>{
 const p=[stroke("a","M0 80L100 80"),stroke("b","M106 80L230 80")];
 assert.equal(joinMicroGaps(p,1,12).length,1);assert.equal(p.length,1);
});
test("a long unsupported blank interval stays open",()=>{
 const p=[stroke("a","M0 80L100 80"),stroke("b","M120 80L230 80")];assert.equal(joinMicroGaps(p,1,12).length,0);
});
test("larger gap requires long support and almost collinear ends",()=>{
 const p=[stroke("a","M80 80L100 80"),stroke("b","M106 80L125 80")];assert.equal(joinMicroGaps(p,1,12).length,0);
});
test("a third line at a larger-gap endpoint blocks inference",()=>{
 const p=[stroke("a","M0 80L100 80"),stroke("b","M106 80L230 80"),stroke("side","M100 80L100 50")];
 assert.equal(joinMicroGaps(p,1,12).length,0);
});
test("a common T node can join the backbone without dropping the branch",()=>{
 const p=[stroke("a","M0 80L100 80"),stroke("b","M100 80L230 80"),stroke("c","M100 80L100 20")];
 assert.equal(joinMicroGaps(p,1,12).length,1);assert.ok(p.some(x=>x.id==="c"));
});
test("hair becomes removable after the fragmented backbone is joined",()=>{
 const s=scene([stroke("a","M0 80L50 80"),stroke("b","M50 80L100 80"),stroke("hair","M50 80L50 69")]);
 const r=cleanContours(s,{scale:1});assert.ok(r.spurIds.includes("hair"));assert.equal(s.primitives.length,1);
});
test("smoothing across an ordinary contact has a common tangent",()=>{
 const d="M0 50"+Array.from({length:101},(_,i)=>`L${i+1} ${50+0.4*Math.sin(i*1.8)}`).join("");
 const r=smoothStroke(d,1,2,[[50,50]]);assert.ok(r.changed);
 const s=parsePath(r.d)[0];let found=false;for(let i=1;i<s.segs.length;i++) {
   const a=s.segs[i-1],b=s.segs[i];if(distance(a.end,[50,50])>.01||a.type!=="C"||b.type!=="C")continue;
   found=true;assert.ok(dot(unit(minus(a.end,a.c2!)),unit(minus(b.c1!,a.end)))>0.999);
 }
 assert.ok(found,"contact must remain an actual fitted anchor");
});
test("a cyclic-knot candidate is reported without failing the gate, unless strict",()=>{
 // 실측(bag_2 14/14, jewelry_1 6/6)에서 후보는 전부 실제 장식·끝단 형상이었다. 확정 결함이
 // 아니므로 기본값은 게이트를 가르지 않고 노트로 남긴다. 원안 동작은 env 로 유지한다.
 const s=scene([]);s.provenance.cleanup={codeVersion:"v7.9",glyphReview:[],lineReview:[{id:"x",reason:"junction_cycle"}]};
 const soft={pass:true,notes:[] as string[]};applyCleanupReview(s,soft);
 assert.equal(soft.pass,true);
 assert.ok(soft.notes.some(n=>n.includes("검토 후보 1곳")),"후보 수가 노트에 남아야 한다");
 process.env.V4_REVIEW_BLOCKS_GATE="1";
 try{const strict={pass:true,notes:[] as string[]};applyCleanupReview(s,strict);assert.equal(strict.pass,false);}
 finally{delete process.env.V4_REVIEW_BLOCKS_GATE;}
});
test("a glyph split with measured core loss fails the gate; zero loss does not",()=>{
 const mk=(reason:string)=>{const s=scene([]);s.provenance.cleanup={codeVersion:"v7.9",glyphReview:[{id:"g",reason}],lineReview:[]};
   const g={pass:true,notes:[] as string[]};applyCleanupReview(s,g);return g;};
 assert.equal(mk("glyph_core_loss:0.000").pass,true);
 assert.equal(mk("glyph_core_loss:0.031").pass,false);
 assert.equal(mk("unmeasured_reason").pass,false);   // 못 재면 보수적으로 결함 취급
});
test("atomic memo shares concurrent calls and validates persisted schema",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"flat-memo-"));let calls=0;const file=path.join(dir,"a.json");
 const valid=(x:unknown):x is {value:number}=>typeof x==="object"&&x!==null&&typeof (x as any).value==="number";
 try{const compute=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return {value:calls};};
   const values=await Promise.all(Array.from({length:12},()=>atomicMemo(file,compute,valid)));assert.equal(calls,1);assert.ok(values.every(v=>v.value===1));
   assert.deepEqual(await atomicMemo(file,async()=>({value:999}),valid),{value:1});
   await fs.writeFile(file,'{}');await assert.rejects(atomicMemo(file,compute,valid),/Invalid memo schema/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test("recomposed mono is selected for vectorization in colour mode",()=>{
 assert.equal(selectGeometry("preview.png","old-mono.png","recomposed.png",false),"recomposed.png");
 assert.equal(selectGeometry("preview.png","old-mono.png",undefined,false),"old-mono.png");
 assert.equal(selectGeometry("gray.png",undefined,undefined,true),"gray.png");
});
test("stage manifest records exact geometry bytes and resolution",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"flat-stages-"));
 try {const image=path.join(dir,"geom.png");await sharp({create:{width:23,height:17,channels:3,background:"white"}}).png().toFile(image);
   const output=path.join(dir,"manifest.json");await writeStageManifest(output,[{role:"vectorization_input",file:image}],image);
   const x=JSON.parse(await fs.readFile(output,"utf8"));assert.equal(x.entries[0].width,23);assert.equal(x.entries[0].sha256.length,64);assert.equal(x.entries[0].selectedForGeometry,true);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test("reported user junction regression has no remaining small loops",async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"flat-junction-"));
 try{
   const s=JSON.parse(await fs.readFile("fixtures/regression/jewelry-v7.8.json","utf8"));
   const before=structuredClone(s),r=await cleanFinish(s,dir);
   assert.equal(r.finalAudit.topology.cyclesAfter,0);assert.equal(r.topology.repaired.length,2);
   const anchors=(ss:VectorScene)=>ss.primitives.reduce((n,p)=>n+("d"in p?parsePath(p.d).reduce((a,s)=>a+s.segs.length+1,0):0),0);
   assert.ok(anchors(s)<anchors(before));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test("evidence-supported fourteen-pixel gap joins, empty raster does not",()=>{
 const make=()=>[stroke("a","M100 600L500 600"),stroke("b","M514 600L1000 600")];
 const W=1200,H=1200,ink=new Float32Array(W*H);for(let x=100;x<=1000;x++)ink[600*W+x]=1;
 assert.equal(bridgeEvidenceGaps(make(),ink,W,H).bridged,1);
 assert.equal(bridgeEvidenceGaps(make(),new Float32Array(W*H),W,H).bridged,0);
});
test("a long cubic crossing the bridge cannot hide between 64 samples",()=>{
 const W=1200,H=1200,ink=new Float32Array(W*H);for(let x=100;x<=1000;x++)ink[601*W+x]=1;
 const p=[stroke("a","M100 601L500 601"),stroke("b","M514 601L1000 601"),stroke("cross","M507 0C507 400 507 800 507 1199")];
 const r=bridgeEvidenceGaps(p,ink,W,H);assert.equal(r.bridged,0);assert.ok(r.rejected.collision>0);
});
