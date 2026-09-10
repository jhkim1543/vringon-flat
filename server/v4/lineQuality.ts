import { parsePath, type Pt } from "../vector/pathdata.js";
import { arcLengths, distance, dot, minus, project, resample, sampleSubpath, unit } from "../vector/curveGeometry.js";
import { detailRole, repairSceneJunctions } from "./junctionRepair.js";
import { auditContinuity } from "./continuityAudit.js";
import type { StrokePrimitive, VectorScene } from "./types.js";

export interface LineReview { id:string;reason:string }
/** Free endpoints alone are NOT defects. Report nearby, mutually facing long
 * contour ends as review candidates, and separately report small cyclic knots.
 * This audit runs on FINAL geometry, after smoothing and text processing. */
export function auditLineQuality(scene:VectorScene,scale:number,before?:VectorScene) {
  const topology=repairSceneJunctions(scene,scale,false),review:LineReview[]=[];
  for(const r of topology.deferred)if(r.diameter<=24&&r.exits>=3&&r.reason!=="protected_detail")
    review.push({id:r.ids.join("+"),reason:`junction_cycle:${r.reason}`});
  const protectedParts=new Set(scene.parts.filter(p=>detailRole(p.id+" "+p.label)).map(p=>p.id));
  const lines=scene.primitives.filter((p):p is StrokePrimitive=>p.cls==="STRUCTURAL_STROKE"&&!detailRole(p.partId??"")&&!protectedParts.has(p.partId??"")&&!p.route.features.facet&&!p.route.features.cleanProtected)
    .flatMap(p=>parsePath(p.d).filter(s=>!s.closed).map(s=>{
      const points=resample(sampleSubpath(s,scale),scale);return {p,points,length:arcLengths(points).at(-1)!};
    }));
  const ends=lines.flatMap(l=>l.length<40*scale?[]:[false,true].map(reverse=>{
    const pp=reverse?[...l.points].reverse():l.points,k=Math.min(12,pp.length-1);
    return {l,point:pp[0],t:unit(minus(pp[0],pp[k]))};
  })).filter(e=>!lines.some(l=>l!==e.l&&l.points.some((p,i,pp)=>i>0&&project(e.point,pp[i-1],p).distance<1.5*scale)));
  const gaps:{ids:string[];points:Pt[];gapSourcePx:number}[]=[];
  for(let i=0;i<ends.length;i++)for(let j=i+1;j<ends.length;j++) {
    const a=ends[i],b=ends[j],g=distance(a.point,b.point);
    if(g<1.5*scale||g>12*scale||a.l.p.partId!==b.l.p.partId||a.l.p.color!==b.l.p.color)continue;
    const v=unit(minus(b.point,a.point));if(dot(a.t,v)<0.85||dot(b.t,v)>-0.85||dot(a.t,b.t)>-0.8)continue;
    gaps.push({ids:[a.l.p.id,b.l.p.id],points:[a.point,b.point],gapSourcePx:g/scale});
  }
  for(const g of gaps)review.push({id:g.ids.join("+"),reason:`facing_free_ends:${g.gapSourcePx.toFixed(2)}px`});
  const prior=before?auditContinuity(before.primitives,{scale,includePoints:true}).freePoints??[]:null;
  const newFreeEnds=prior?(auditContinuity(scene.primitives,{scale,includePoints:true}).freePoints??[])
    .filter(e=>e.length>=40*scale&&!prior.some(p=>distance(p.point,e.point)<=3*scale)):[];
  for(const e of newFreeEnds)review.push({id:e.id??"unknown",reason:`new_free_endpoint:${e.point.map(n=>+(n/scale).toFixed(2)).join(",")}`});
  return {topology,gaps,newFreeEnds,review};
}
