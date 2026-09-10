import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { parsePath, serializePath, type Pt } from "../vector/pathdata.js";
import { arcLengths, distance, dot, minus, project, resample, sampleSubpath, unit } from "../vector/curveGeometry.js";
import { fitPolyline, segsToPathD } from "../vector/fitCurve.js";
import { vtraceLayer } from "../vector/vtracerEngine.js";
import { distanceTransform } from "../v3/metrics.js";
import { labelComponents } from "../v3/label.js";
import { thinAnchors } from "./refit.js";
import { fitSmoothSpline } from "../vector/fitSpline.js";
import type { ShapePrimitive, StrokePrimitive, VectorScene } from "./types.js";

export interface GlyphReport { detached: {id:string; retainedInk:number; retainedGlyphCore:number; recoveredBoundary:boolean; gapSourcePx:number; method?:string;}[]; deferred:{id:string;reason:string}[] }
const glyph=(p:VectorScene["primitives"][number])=>p.cls==="OUTLINE_SHAPE"&&Boolean(p.route.features.glyph);

/** Recover only a smooth side of a fused text component that meets TWO existing
 * long structural endpoints with compatible tangents. No OCR or font redraw. */
export function glyphBoundaryCandidate(scene:VectorScene,g:ShapePrimitive,scale:number):Pt[]|null {
  const ends=scene.primitives.filter((p):p is StrokePrimitive=>p.cls==="STRUCTURAL_STROKE").flatMap(p=>{
    const s=parsePath(p.d);if(s.length!==1||s[0].closed)return [];
    const pts=resample(sampleSubpath(s[0],scale),scale),len=arcLengths(pts).at(-1)!;
    if(len<60*scale)return [];
    const k=Math.min(12,pts.length-1);
    return [{p,point:pts[0],t:unit(minus(pts[0],pts[k]))},
      {p,point:pts.at(-1)!,t:unit(minus(pts.at(-1)!,pts[pts.length-1-k]))}];
  });
  let best: {points:Pt[]; score:number}|null=null;
  for(const sub of parsePath(g.d)) {
    if(!sub.closed)continue;
    const pts=resample(sampleSubpath(sub,scale),scale);
    if(pts.length<120)continue;
    const hits=ends.map(e=>{
      let index=-1,bd=8*scale;
      for(let i=0;i<pts.length;i++){const d=distance(pts[i],e.point);if(d<bd){bd=d;index=i;}}
      return {...e,index,dist:bd};
    }).filter(e=>e.index>=0);
    for(let a=0;a<hits.length;a++)for(let b=a+1;b<hits.length;b++) {
      const x=hits[a],y=hits[b];if(x.p===y.p)continue;
      const span=distance(x.point,y.point);if(span<100*scale)continue;
      for(const dir of [-1,1]) {
        const run:Pt[]=[];let i=x.index;
        for(let j=0;j<pts.length;j++){run.push(pts[i]);if(i===y.index)break;i=(i+dir+pts.length)%pts.length;}
        if(run.length<20||distance(run.at(-1)!,pts[y.index])>0.1)continue;
        const length=arcLengths(run).at(-1)!;
        if(length>span*1.8)continue;
        const k=Math.min(12,Math.floor(run.length/4));
        const t0=unit(minus(run[k],run[0])),t1=unit(minus(run.at(-1)!,run[run.length-1-k]));
        if(dot(t0,x.t)<0.8||dot(t1,y.t)>-0.8)continue;
        let turn=0;
        const coarse=resample(run,5*scale);
        for(let j=1;j<coarse.length-1;j++) {
          const u=unit(minus(coarse[j],coarse[j-1])),v=unit(minus(coarse[j+1],coarse[j]));
          turn+=Math.acos(Math.max(-1,Math.min(1,dot(u,v))));
        }
        if(turn>Math.PI*2)continue;
        const score=length/span+turn/Math.PI+(x.dist+y.dist)/(8*scale);
        if(!best||score<best.score){run[0]=x.point;run[run.length-1]=y.point;best={points:run,score};}
      }
    }
  }
  return best?.points??null;
}

export async function separateGlyphs(scene:VectorScene,workDir:string,scale:number,say?:(m:string)=>void):Promise<GlyphReport> {
  const report:GlyphReport={detached:[],deferred:[]};
  if(process.env.V4_GLYPH_CLEARANCE==="0")return report;
  const configured=Number(process.env.V4_GLYPH_GAP_PX??2);
  const gap=(Number.isFinite(configured)&&configured>=0?configured:2)*scale;
  if(!gap)return report;
  const {width:W,height:H}=scene.canvas;
  const candidates=scene.primitives.filter(glyph) as ShapePrimitive[];
  const glyphPart=scene.parts.find(p=>/letter|logo|engrav|inscript|text|brand|monogram|marking/i.test(p.id+" "+p.label));
  await fs.mkdir(workDir,{recursive:true});
  for(const g of candidates) {
    const boundary=glyphBoundaryCandidate(scene,g,scale);
    const points=parsePath(g.d).flatMap(s=>sampleSubpath(s,scale));
    if(!points.length)continue;
    const pad=Math.ceil(16*scale),x0=Math.max(0,Math.floor(Math.min(...points.map(p=>p[0])))-pad),
      y0=Math.max(0,Math.floor(Math.min(...points.map(p=>p[1])))-pad),
      x1=Math.min(W,Math.ceil(Math.max(...points.map(p=>p[0])))+pad),y1=Math.min(H,Math.ceil(Math.max(...points.map(p=>p[1])))+pad);
    const w=x1-x0,h=y1-y0;if(w<1||h<1)continue;
    const head=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x0} ${y0} ${w} ${h}">`;
    const raw=await sharp(Buffer.from(head+`<path d="${g.d}" fill="black" fill-rule="evenodd"/></svg>`))
      .flatten({background:"white"}).greyscale().raw().toBuffer();
    let recovered:StrokePrimitive|null=null,clearWidth=0;
    if(boundary) {
      const fitted=fitSmoothSpline(boundary,scale,20) ?? fitPolyline(boundary,{maxError:scale,cornerTurnDeg:100,minSpanPx:scale});
      const d=segsToPathD(fitted,false);
      recovered={id:g.id+"-boundary",cls:"STRUCTURAL_STROKE",d,width:1.4*scale,color:"#111111",
        partId:g.partId,shared:g.shared,area:0,bbox:g.bbox,
        route:{chosen:"STRUCTURAL_STROKE",features:{glyphBoundaryRecovered:true},why:"글자와 붙은 매끄러운 경계 — 양쪽 구조선 끝점으로 확인",confidence:0.75}};
      // The recovered path already marks the exterior edge. Adding the full
      // local black width here eats bold LETTER stems near that edge. Enforce
      // the requested distance from the new thin stroke, not ribbon+distance.
      // The actual vector clearance and every thick core are still checked.
      clearWidth=recovered.width+2*(gap+scale);
    }
    const lines=scene.primitives.filter((p):p is StrokePrimitive=>p.cls==="STRUCTURAL_STROKE")
      .filter(p=>parsePath(p.d).reduce((sum,s)=>sum+(arcLengths(sampleSubpath(s,scale)).at(-1)??0),0)>=60*scale);
    const paths=lines.map(p=>`<path d="${p.d}" fill="none" stroke="black" stroke-width="${p.width+2*(gap+scale)}" stroke-linecap="round" stroke-linejoin="round"/>`);
    if(recovered)paths.push(`<path d="${recovered.d}" fill="none" stroke="black" stroke-width="${clearWidth}" stroke-linecap="round"/>`);
    const corridor=await sharp(Buffer.from(head+paths.join("")+"</svg>")).flatten({background:"white"}).greyscale().raw().toBuffer();
    const clean=Buffer.alloc(w*h,255);let before=0,after=0;
    for(let i=0;i<raw.length;i++)if(raw[i]<128){before++;if(corridor[i]>=128){clean[i]=0;after++;}}
    if(!before||after===before)continue;
    // The removed ribbon belongs to the boundary, not to the lettering. Protect
    // each thick glyph core instead of treating that ribbon as mandatory text.
    const background=new Uint8Array(w*h);
    for(let i=0;i<raw.length;i++)background[i]=raw[i]>=128?1:0;
    const edt=distanceTransform({data:background,width:w,height:h});
    const depths=Array.from(edt).filter((v,i)=>raw[i]<128&&Number.isFinite(v)).sort((a,b)=>a-b);
    const threshold=Math.max(3*scale,depths[Math.floor(depths.length*0.65)]??3*scale);
    const core=new Uint8Array(w*h);let coreN=0,coreKept=0;
    for(let i=0;i<raw.length;i++)if(raw[i]<128&&edt[i]>=threshold){core[i]=1;coreN++;if(clean[i]<128)coreKept++;}
    const coreComponents=labelComponents(core,w,h,8,Math.max(2,Math.round(scale*scale))).components;
    const lostCore=coreComponents.some(c=>{let kept=0;for(const i of c.pixels)if(clean[i]<128)kept++;return kept/c.area<0.9;});
    if(after/before<0.5||!coreN||lostCore){report.deferred.push({id:g.id,reason:`glyph_core_loss:${(coreKept/Math.max(1,coreN)).toFixed(3)}`});continue;}
    const tmp=path.join(workDir,`glyph-clear-${candidates.indexOf(g)}.png`);
    await sharp(clean,{raw:{width:w,height:h,channels:1}}).png().toFile(tmp);
    const traced=await vtraceLayer(tmp,{kind:"logo",color:g.fill});
    const toDs=(traced:Awaited<ReturnType<typeof vtraceLayer>>)=>traced.map(p=>{
      const subs=parsePath(p.d);
      for(const s of subs){s.start=[s.start[0]+x0,s.start[1]+y0];for(const t of s.segs){t.end=[t.end[0]+x0,t.end[1]+y0];
        if(t.c1)t.c1=[t.c1[0]+x0,t.c1[1]+y0];if(t.c2)t.c2=[t.c2[0]+x0,t.c2[1]+y0];}}
      return serializePath(subs);
    });
    const ds=toDs(traced);
    if(!ds.length){report.deferred.push({id:g.id,reason:"empty_trace"});continue;}
    // Validate the actual re-traced fill; a fitted contour can overshoot a raster
    // clearance, so no mask-only success claim is made.
    const targetPaths=paths.map(s=>s.replace(/stroke-width="([0-9.]+)"/,(_,v)=>`stroke-width="${Math.max(0.1,Number(v)-2*scale)}"`));
    const targetCorridor=await sharp(Buffer.from(head+targetPaths.join("")+"</svg>"))
      .flatten({background:"white"}).greyscale().raw().toBuffer();
    const white=new Uint8Array(w*h);for(let i=0;i<clean.length;i++)white[i]=clean[i]>=128?1:0;
    const holes=labelComponents(white,w,h,4,Math.max(4,Math.round(4*scale*scale))).components.filter(c=>
      !Array.from(c.pixels).some(i=>i%w===0||i%w===w-1||i<w||i>=(h-1)*w));
    let reason="clearance_trace_overshoot";
    const evaluate=async(ds:string[])=>{
    let accepted:{d:string;core:number;ink:number;anchors:number}|null=null;
    for(const epsilon of [1.2,0.6,0]) {
      const d=ds.map(x=>epsilon?thinAnchors(x,epsilon*scale):x).join("");
      const rendered=await sharp(Buffer.from(head+`<path d="${d}" fill="black" fill-rule="evenodd"/></svg>`))
        .flatten({background:"white"}).greyscale().raw().toBuffer();
      let spill=0,renderedCore=0,renderedInk=0;
      for(let i=0;i<raw.length;i++)if(rendered[i]<128){if(core[i])renderedCore++;if(raw[i]<128)renderedInk++;if(rendered[i]<96&&targetCorridor[i]<96)spill++;}
      if(spill>Math.max(5,after*0.002))continue;
      const losesCore=coreComponents.some(c=>{let kept=0;for(const i of c.pixels)if(rendered[i]<128)kept++;return kept/c.area<0.9;});
      const losesHole=holes.some(c=>{let white=0;for(const i of c.pixels)if(rendered[i]>=128)white++;return white/c.area<0.75;});
      if(losesCore||losesHole){reason="glyph_core_or_counter_lost_in_vector";continue;}
      const anchors=parsePath(d).reduce((n,s)=>n+s.segs.length+1,0);
      if(!accepted||anchors<accepted.anchors)accepted={d,core:renderedCore/coreN,ink:renderedInk/before,anchors};
    }
    return accepted;
    };
    let accepted=await evaluate(ds);
    if(!accepted)accepted=await evaluate(toDs(await vtraceLayer(tmp,{kind:"logo",color:g.fill,tight:true})));
    if(!accepted){report.deferred.push({id:g.id,reason});continue;}
    const nd=accepted.d;
    g.d=nd;g.route.features.glyphClearancePx=gap/scale;
    if(glyphPart)g.partId=glyphPart.id;
    if(recovered)scene.primitives.push(recovered);
    report.detached.push({id:g.id,retainedInk:accepted.ink,retainedGlyphCore:accepted.core,recoveredBoundary:!!recovered,gapSourcePx:gap/scale});
  }
  say?.(`글자·외곽 분리 — 적용 ${report.detached.length} · 보류 ${report.deferred.length}`);
  return report;
}
