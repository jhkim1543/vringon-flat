import { centerlineTrace, type CenterlineOptions } from "./centerline.js";
import { parsePath, serializePath, type Pt, type Seg as Segment } from "./pathdata.js";
import { distance, mix } from "./curveGeometry.js";
import type { IRPath } from "../types.js";

type OwnedPath=IRPath&{partId?:string;shared?:string[]};
function pointAt(p:Pt,s:Segment,t:number):Pt {
  if(s.type==="L")return mix(p,s.end,t);
  return mix(mix(mix(p,s.c1!,t),mix(s.c1!,s.c2!,t),t),mix(mix(s.c1!,s.c2!,t),mix(s.c2!,s.end,t),t),t);
}
function split(p:Pt,s:Segment,t:number):[Segment,Segment] {
  if(s.type==="L"){const q=mix(p,s.end,t);return [{type:"L",end:q},{type:"L",end:s.end}];}
  const a=mix(p,s.c1!,t),b=mix(s.c1!,s.c2!,t),c=mix(s.c2!,s.end,t),d=mix(a,b,t),e=mix(b,c,t),q=mix(d,e,t);
  return [{type:"C",c1:a,c2:d,end:q},{type:"C",c1:e,c2:c,end:s.end}];
}

/** Ownership cuts happen AFTER tracing. Both pieces share exactly the same
 * De Casteljau point and tangent; no raster seam is skeletonized as a new edge. */
export function splitPathByOwner(ir:IRPath,owner:Int16Array,W:number,H:number,parts:{id:string}[]):OwnedPath[] {
  const out:OwnedPath[]=[];
  const label=(p:Pt)=>{
    const x=Math.round(p[0]),y=Math.round(p[1]);if(x<0||y<0||x>=W||y>=H)return -1;
    const o=owner[y*W+x];return o>=0&&o<parts.length?o:-1;
  };
  for(const sub of parsePath(ir.d)) {
    let start=sub.start,cur=sub.start,active=-2,segs:Segment[]=[];
    const emit=()=>{if(segs.length)out.push({...ir,d:serializePath([{start,segs,closed:false}]),partId:active>=0?parts[active].id:undefined});};
    const original=[...sub.segs];
    if(sub.closed&&distance(sub.start,sub.segs.at(-1)?.end??sub.start)>1e-6)original.push({type:"L",end:sub.start});
    const firstIndex=out.length;
    for(const s of original) {
      const length=s.type==="L"?distance(cur,s.end):distance(cur,s.c1!)+distance(s.c1!,s.c2!)+distance(s.c2!,s.end);
      const n=Math.max(1,Math.ceil(length/2));
      const runs:{a:number;b:number;label:number}[]=[];
      for(let i=0;i<n;i++){
        const l=label(pointAt(cur,s,(i+0.5)/n)),last=runs.at(-1);
        if(last?.label===l)last.b=(i+1)/n;else runs.push({a:i/n,b:(i+1)/n,label:l});
      }
      for(const run of runs) {
        const until=run.b===1?s:split(cur,s,run.b)[0];
        const piece=run.a===0?until:split(cur,until,run.a/run.b)[1];
        const p0=pointAt(cur,s,run.a);
        if(active!==run.label){emit();segs=[];start=p0;active=run.label;}
        segs.push(piece);
      }
      cur=s.end;
    }
    emit();
    if(sub.closed&&out.length===firstIndex+1){const only=out[firstIndex];const s=parsePath(only.d);s[0].closed=true;only.d=serializePath(s);}
  }
  return out;
}

export async function traceOwnedCenterlines(png:string,opts:CenterlineOptions,W:number,H:number,owner?:Int16Array,parts?:{id:string}[]):Promise<OwnedPath[]> {
  const raw=await centerlineTrace(png,opts);
  return owner&&parts?.length?raw.flatMap(p=>splitPathByOwner(p,owner,W,H,parts)):raw;
}
