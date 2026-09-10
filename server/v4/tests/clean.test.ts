import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { traceSkeletonChains, pruneSkeletonSpurs, skeletonNeighbors } from "../../vector/skeletonGraph.js";
import { splitPathByOwner } from "../../vector/ownerStrokes.js";
import { fitSmoothSpline } from "../../vector/fitSpline.js";
import { centerlineTrace } from "../../vector/centerline.js";
import { parsePath, type Pt } from "../../vector/pathdata.js";
import { boundedDeviation, crossingIndex, distance, maxDistanceToPolyline, sampleSubpath } from "../../vector/curveGeometry.js";
import { segsToPathD } from "../../vector/fitCurve.js";
import { cleanContours, joinMicroGaps, removeTerminalSpurs, trimTerminalHooks, removeNearContourSpecks, smoothStroke } from "../cleanContours.js";
import { letterMaskFromBoxes } from "../letterDetect.js";
import { auditContinuity } from "../continuityAudit.js";
import { applyCleanupReview } from "../qa4.js";
import { separateGlyphs } from "../glyphClearance.js";
import { cleanFinish } from "../cleanFinish.js";
import type { ScenePrimitive, StrokePrimitive, VectorScene } from "../types.js";

const stroke=(id:string,d:string,width=2,partId="body"):StrokePrimitive=>({id,d,width,partId,color:"#111111",cls:"STRUCTURAL_STROKE",
  area:0,bbox:[0,0,200,200],route:{chosen:"STRUCTURAL_STROKE",features:{},why:"fixture",confidence:1}});
const scene=(primitives:ScenePrimitive[]):VectorScene=>({canvas:{width:200,height:200,sourceWidth:200,sourceHeight:200,supersample:1},primitives,
  parts:[{id:"body",label:"body",z:0,kind:"body",confidence:1,occludedBy:[]}],sharedBoundaries:[],correspondence:{method:"none",aspectRatio:1,confident:true,note:""},
  provenance:{pipeline:"test",schematic:{backend:"fixture",prompt:"",seed:null},createdAt:"",lowConfidence:0}});

test("staircase diagonal has one continuous chain, no false junctions",()=>{
  const W=30,H=30,m=new Uint8Array(W*H);
  for(let i=3;i<24;i++){m[i*W+i]=1;m[i*W+i+1]=1;}
  const c=traceSkeletonChains(m,W,H);assert.equal(c.length,1);
  assert.equal(c[0].length,42);
  for(let i=0;i<m.length;i++)if(m[i])assert.ok(skeletonNeighbors(m,W,H,i).length<=2);
  const r=pruneSkeletonSpurs(m,W,H,new Float32Array(W*H).fill(2),2);assert.deepEqual(r.skel,m);
});
test("spur removal preserves the complete backbone and junction pixel",()=>{
  const W=50,H=40,m=new Uint8Array(W*H),dt=new Float32Array(W*H).fill(1.5);
  for(let x=3;x<47;x++)m[20*W+x]=1;for(let y=17;y<20;y++)m[y*W+25]=1;
  const r=pruneSkeletonSpurs(m,W,H,dt,1.5);assert.equal(r.pruned,1);
  for(let x=3;x<47;x++)assert.equal(r.skel[20*W+x],1);
  assert.equal(r.skel[17*W+25],0);
});
test("junction-to-junction connector is not a leaf spur",()=>{
  const W=40,H=40,m=new Uint8Array(W*H);
  for(let y=3;y<37;y++)m[y*W+18]=m[y*W+21]=1;
  for(let x=18;x<=21;x++)m[20*W+x]=1;
  const r=pruneSkeletonSpurs(m,W,H,new Float32Array(W*H).fill(1),2);
  for(let x=18;x<=21;x++)assert.equal(r.skel[20*W+x],1);
});
test("closed skeleton ring remains closed",()=>{
  const W=30,H=30,m=new Uint8Array(W*H);
  for(let x=5;x<=24;x++)m[5*W+x]=m[24*W+x]=1;
  for(let y=6;y<24;y++)m[y*W+5]=m[y*W+24]=1;
  const c=traceSkeletonChains(m,W,H);assert.equal(c.length,1);assert.deepEqual(c[0][0],c[0].at(-1));
});
test("path budget cannot delete required long structural strokes",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"flat-test-"));
  try {
    const png=path.join(dir,"line.png");
    await sharp(Buffer.from('<svg width="160" height="50"><path d="M10 25 L150 25" stroke="black" stroke-width="3"/></svg>'))
      .flatten({background:"white"}).png().toFile(png);
    const a=await centerlineTrace(png,{color:"#111111",maxPaths:0,minLength:6});assert.ok(a.length>=1);
    assert.ok(sampleSubpath(parsePath(a[0].d)[0]).some(p=>p[0]>145));
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test("ownership split preserves exact endpoint and tangent",()=>{
  const W=120,H=120,owner=new Int16Array(W*H);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++)owner[y*W+x]=x<60?0:1;
  const d="M10 70 C30 20 90 20 110 70";
  const out=splitPathByOwner({d,fill:null,stroke:"#111111",strokeWidth:2,vectorizer:"vtracer"},owner,W,H,[{id:"left"},{id:"right"}]);
  assert.equal(out.length,2);assert.equal(out[0].partId,"left");assert.equal(out[1].partId,"right");
  const a=parsePath(out[0].d)[0],b=parsePath(out[1].d)[0],last=a.segs.at(-1)!;
  assert.deepEqual(last.end,b.start);
  const u:[number,number]=[last.end[0]-last.c2![0],last.end[1]-last.c2![1]],v:[number,number]=[b.segs[0].c1![0]-b.start[0],b.segs[0].c1![1]-b.start[1]];
  assert.ok(Math.abs(u[0]*v[1]-u[1]*v[0])<0.5);
  const input=sampleSubpath(parsePath(d)[0],0.5),combined=out.flatMap(x=>sampleSubpath(parsePath(x.d)[0],0.5));
  assert.ok(boundedDeviation(input,combined,0.03)<0.03);
});
for(const scale of [1,2,4])test(`global spline has few anchors at scale ${scale}`,()=>{
  const pts:Pt[]=Array.from({length:201},(_,i)=>[i*scale,(50+0.4*Math.sin(i*2))*scale]);
  const c=fitSmoothSpline(pts,scale);assert.ok(c);assert.ok(c.length<=3);
  const p=sampleSubpath(parsePath(segsToPathD(c,false))[0],0.5*scale);
  assert.ok(boundedDeviation(pts,p,scale)<=scale);assert.deepEqual(c[0].p0,pts[0]);assert.deepEqual(c.at(-1)!.p3,pts.at(-1));
});
test("distance gate is independent of sampling density",()=>{
  assert.equal(maxDistanceToPolyline([[500,0]],[[0,0],[1000,0]]),0);
});
test("smooth noisy line reduces anchors without moving its ends",()=>{
  const d="M0 50"+Array.from({length:100},(_,i)=>`L${i+1} ${50+0.5*Math.sin(i*2)}`).join("");
  const r=smoothStroke(d,1,2);assert.ok(r.changed);
  const a=parsePath(d)[0],b=parsePath(r.d)[0];assert.deepEqual(a.start,b.start);assert.ok(distance(a.segs.at(-1)!.end,b.segs.at(-1)!.end)<0.01);
  assert.ok(b.segs.length<10);assert.ok(r.roughnessAfter!<r.roughnessBefore!);
});
test("micro gap becomes one edit path",()=>{
  const s=scene([stroke("a","M10 50L60 50"),stroke("b","M62 50L150 50")]);
  const r=cleanContours(s,{scale:1});assert.equal(r.joined.length,1);assert.equal(s.primitives.length,1);
  assert.equal(parsePath((s.primitives[0] as StrokePrimitive).d).length,1);
});
test("coincident compatible endpoints join without zero-length bridge",()=>{
  const p=[stroke("a","M10 50L60 50"),stroke("b","M60 50L150 50")];
  assert.equal(joinMicroGaps(p,1,3).length,1);assert.equal(parsePath(p[0].d)[0].segs.length,2);
});
test("parallel contours stay separate",()=>{
  const p=[stroke("a","M10 50L60 50"),stroke("b","M60 52L10 52")];
  assert.equal(joinMicroGaps(p,1,3).length,0);
});
test("a third crossing stroke blocks a proposed micro bridge",()=>{
  const p=[stroke("a","M10 50L60 50"),stroke("b","M62 50L150 50"),stroke("cross","M61 40L61 60")];
  assert.equal(joinMicroGaps(p,1,3).length,0);
});
test("different parts without shared boundary are not joined",()=>{
  const p=[stroke("a","M10 50L60 50",2,"a"),stroke("b","M62 50L150 50",2,"b")];
  assert.equal(joinMicroGaps(p,1,3).length,0);
});
test("large blank gaps are not hallucinated",()=>{
  const p=[stroke("a","M0 50L80 50"),stroke("b","M100 50L200 50")];assert.equal(joinMicroGaps(p,1,3).length,0);
});
test("declared stitches, closed loops and two-sided connectors survive",()=>{
  const p:ScenePrimitive[]=[stroke("main","M10 50L190 50"),stroke("hair","M100 50L100 45"),
    {...stroke("stitch","M120 50L120 45"),cls:"DASH_OR_STITCH",dashArray:"1 1"},stroke("eyelet","M140 48L142 50L140 52L138 50Z")];
  assert.deepEqual(removeTerminalSpurs(p,1),["hair"]);assert.ok(p.some(x=>x.id==="stitch"));assert.ok(p.some(x=>x.id==="eyelet"));
});
test("letter mask cannot leak outside recognized box",()=>{
  const W=40,H=30,ink=new Uint8Array(W*H).fill(1),dist=new Float32Array(W*H).fill(3);
  const mask=letterMaskFromBoxes([[0.25,0.25,0.5,0.5]],ink,W,H,dist);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++)if(mask[y*W+x])assert.ok(x>=10&&x<=20&&y>=7&&y<=15);
});
test("cleanup is deterministic and keeps semantic identities",()=>{
  const input=scene([stroke("a","M10 50L60 50"),stroke("b","M62 50L150 50")]);
  const a=structuredClone(input),b=structuredClone(input);
  assert.deepEqual(cleanContours(a,{scale:1}),cleanContours(b,{scale:1}));assert.deepEqual(a,b);assert.equal(a.primitives[0].partId,"body");
});
test("the outline cap spares an already graded width, and caps a raw ink width",async()=>{
  // `qaWidth` 가 있으면 `width` 는 실측 잉크 폭이 아니라 얇은 마감이 정한 **표시용 등급**이다
  // (굵기 사다리 1.2 · 2 · 3.2 · 4.5px). 그걸 상한하면 외곽이 굵고 디테일이 얇은 위계가
  // 사라진다 — 실측 shoe_1: {1.2:61, 2:115, 3.2:74, 4.5:21} → {1.2:81, 1.4:119}. 선 F@2 는
  // qaWidth 로 재므로 이 손실을 못 잡는다. 그래서 등급은 살리고, 실측 폭만 상한한다.
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"flat-finish-"));
  try {
    const graded=scene([{...stroke("a","M10 50L150 50",6),qaWidth:30}]);
    await cleanFinish(graded,dir);
    assert.equal((graded.primitives[0] as StrokePrimitive).width,6,"등급 굵기는 그대로");
    assert.equal((graded.primitives[0] as StrokePrimitive).qaWidth,30);

    const raw=scene([stroke("a","M10 50L150 50",6)]);          // qaWidth 없음 = 실측 잉크 폭
    await cleanFinish(raw,dir);
    assert.equal((raw.primitives[0] as StrokePrimitive).width,1.4,"실측 폭은 상한한다");
    assert.equal((raw.primitives[0] as StrokePrimitive).qaWidth,6,"상한 전 폭을 채점용으로 남긴다");

    process.env.V4_CLEAN_CAP_GRADED="1";                        // 원안 동작도 남겨 둔다
    try {
      const forced=scene([{...stroke("a","M10 50L150 50",6),qaWidth:30}]);
      await cleanFinish(forced,dir);
      assert.equal((forced.primitives[0] as StrokePrimitive).width,1.4);
    } finally {delete process.env.V4_CLEAN_CAP_GRADED;}
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test("embedded terminal hook is trimmed at an existing continuation anchor",()=>{
  const p=[stroke("main","M0 50L100 50L105 42"),stroke("next","M100 50L200 50")];
  assert.deepEqual(trimTerminalHooks(p,1),["main"]);
  assert.deepEqual(parsePath(p[0].d)[0].segs.at(-1)!.end,[100,50]);
  assert.equal(joinMicroGaps(p,1,3).length,1);assert.equal(p.length,1);
});
test("a short tail with an attached other end is a connector, not a hook",()=>{
  const p=[stroke("main","M0 50L100 50L105 42"),stroke("next","M100 50L200 50"),stroke("link","M105 42L140 10")];
  assert.deepEqual(trimTerminalHooks(p,1),[]);
});
test("longer hair is removed but a collinear continuation survives",()=>{
  const p=[stroke("main","M0 50L200 50"),stroke("hair","M100 50L100 36"),stroke("along","M120 50L135 50")];
  assert.deepEqual(removeTerminalSpurs(p,1),["hair"]);
});
test("tiny isolated remnants near one contour are removed, glyphs and remote detail survive",()=>{
  const p:ScenePrimitive[]=[stroke("main","M0 50L200 50"),stroke("speck","M80 45L83 45"),stroke("remote","M80 10L83 10"),
    {...stroke("glyph","M100 45L103 45"),route:{chosen:"STRUCTURAL_STROKE",features:{glyph:true},why:"text",confidence:1}}];
  assert.deepEqual(removeNearContourSpecks(p,1),["speck"]);
});
test("a bridge entirely inside a filled glyph is blocked",()=>{
  const p:ScenePrimitive[]=[stroke("a","M0 50L60 50"),stroke("b","M62 50L180 50"),
    {id:"glyph",cls:"OUTLINE_SHAPE",d:"M50 40L70 40L70 60L50 60Z",fill:"#111111",area:400,bbox:[50,40,70,60],route:{chosen:"OUTLINE_SHAPE",features:{glyph:true},why:"text",confidence:1}}];
  assert.equal(joinMicroGaps(p,1,3).length,0);
});
test("letter clearance is checked after the actual vector retrace",async()=>{
  const s=scene([stroke("border","M10 50L190 50",1.4),{id:"glyph",cls:"OUTLINE_SHAPE",d:"M40 51L60 51L60 95L40 95Z",fill:"#111111",area:880,bbox:[40,51,60,95],
    route:{chosen:"OUTLINE_SHAPE",features:{glyph:true},why:"text",confidence:1}}]);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"flat-glyph-"));
  try {
    const r=await separateGlyphs(s,dir,1);assert.equal(r.detached.length,1,JSON.stringify(r));
    const p=s.primitives.find(p=>p.id==="glyph")!;assert.ok("d"in p);
    const pixels=await sharp(Buffer.from(`<svg width="200" height="200"><path d="${p.d}" fill="black"/></svg>`)).flatten({background:"white"}).greyscale().raw().toBuffer();
    for(let y=48;y<=52;y++)for(let x=0;x<200;x++)assert.ok(pixels[y*200+x]>96);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test("known text separation failure cannot produce an editability PASS",()=>{
  const s=scene([]);s.provenance.cleanup={codeVersion:"v7.8",glyphReview:[{id:"fused-text",reason:"glyph_core_loss"}]};
  const gate={pass:true,notes:[] as string[]};applyCleanupReview(s,gate);
  assert.equal(gate.pass,false);assert.ok(gate.notes[0].includes("fused-text"));
});

test("cross-path collision check catches a crossing at a sampling vertex",()=>{
  const q=crossingIndex([[0,0],[5,0],[10,0]],2);
  assert.equal(q([[5,-5],[5,0],[5,5]]),1);
  assert.equal(q([[0,3],[10,3]]),0);
  assert.equal(q([[5,0],[5,5]]),0); // intentional endpoint contact
});

test("chain and stitch semantics protect short branches even if classified as structural",()=>{
  const p=[stroke("main","M0 50L200 50",2,"chain"),stroke("link","M100 50L100 36",2,"chain")];
  assert.deepEqual(removeTerminalSpurs(p,1),[]);
  const s=scene([stroke("main","M0 50L200 50",2,"p1"),stroke("link","M100 50L100 36",2,"p1")]);
  s.parts[0]={...s.parts[0],id:"p1",label:"Chain links"};
  assert.deepEqual(cleanContours(s,{scale:1}).spurIds,[]);
});

test("smoothing keeps even a short protected branch's contact",()=>{
  const main="M0 50"+Array.from({length:100},(_,i)=>`L${2*(i+1)} ${50+0.4*Math.sin(i*1.1)}`).join("");
  const contactY=50+0.4*Math.sin(49*1.1);
  const branch={...stroke("mark",`M100 ${contactY}L100 43`,2,"stitch"),route:{chosen:"STRUCTURAL_STROKE" as const,features:{cleanProtected:true},why:"stitch",confidence:1}};
  const s=scene([stroke("main",main),branch]);cleanContours(s,{scale:1});
  const p=s.primitives.find(p=>p.id==="main")!;assert.ok("d"in p);
  assert.ok(maxDistanceToPolyline([[100,contactY]],sampleSubpath(parsePath(p.d)[0],0.2))<0.1);
});

test("continuity audit is stable for a long cubic versus a line and source scale",()=>{
  const a=auditContinuity([stroke("a","M0 50L1000 50"),stroke("b","M507 50L507 70")]);
  const b=auditContinuity([stroke("a","M0 50C333 50 667 50 1000 50"),stroke("b","M507 50L507 70")]);
  const c=auditContinuity([stroke("a","M0 100C666 100 1334 100 2000 100"),stroke("b","M1014 100L1014 140")],{scale:2});
  assert.deepEqual(a,b);assert.deepEqual(b,c);assert.equal(a.free,3);
});

test("disabled micro bridging also stays disabled after glyph cleanup",async()=>{
  const old=process.env.V4_CLEAN_GAP_PX;process.env.V4_CLEAN_GAP_PX="0";
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"flat-no-gap-"));
  try {
    const s=scene([stroke("a","M0 50L60 50"),stroke("b","M62 50L180 50")]);
    await cleanFinish(s,dir);assert.equal(s.primitives.length,2);
  } finally {if(old===undefined)delete process.env.V4_CLEAN_GAP_PX;else process.env.V4_CLEAN_GAP_PX=old;await fs.rm(dir,{recursive:true,force:true});}
});
