/** Connectivity diagnostic, not proof that every free endpoint is a defect.
 * Uses distances to sampled curve SEGMENTS; a fixed number of points on a long
 * Bezier incorrectly reports more breaks as the anchor count gets smaller. */
import { parsePath, type Pt } from '../vector/pathdata.js';
import { arcLengths, distance, project, sampleSubpath } from '../vector/curveGeometry.js';
export interface ContinuityReport {
  ends:number; free:number; longEnds:number; freeLong:number; freeLongAtFill:number;
  /** Endpoint count, not unique pair count. A pair can contribute two. */
  splitJoins:number;
  freePoints?:{id?:string;point:Pt;length:number}[];
}
interface Line {id?:string;pts:Pt[];ends:Pt[];len:number}
export function auditContinuity(prims:{id?:string;cls:string;d?:string}[],opts:{scale?:number;includePoints?:boolean}={}):ContinuityReport {
  const scale=opts.scale??1;
  if(!(Number.isFinite(scale)&&scale>0))throw new Error('Invalid continuity audit scale');
  const R=Number(process.env.V4_CONT_R??1.5)*scale,LONG=Number(process.env.V4_CONT_LONG??40)*scale;
  const strokes:Line[]=[],fills:Line[]=[];
  for(const p of prims)if(p.d)for(const sub of parsePath(p.d)) {
    const pts=sampleSubpath(sub,0.75*scale),closed=sub.closed||distance(pts[0],pts.at(-1)!)<0.5*scale;
    const s={id:p.id,pts,ends:closed?[]:[pts[0],pts.at(-1)!],len:arcLengths(pts).at(-1)??0};
    (p.cls==='STRUCTURAL_STROKE'||p.cls==='DASH_OR_STITCH'?strokes:fills).push(s);
  }
  const index=(lines:Line[],cell:number)=>{
    const grid=new Map<string,{si:number;i:number}[]>();
    lines.forEach((s,si)=>{for(let i=1;i<s.pts.length;i++) {
      const a=s.pts[i-1],b=s.pts[i];
      for(let y=Math.floor(Math.min(a[1],b[1])/cell);y<=Math.floor(Math.max(a[1],b[1])/cell);y++)
        for(let x=Math.floor(Math.min(a[0],b[0])/cell);x<=Math.floor(Math.max(a[0],b[0])/cell);x++) {
          const k=`${x},${y}`;(grid.get(k)??grid.set(k,[]).get(k)!).push({si,i});
        }
    }});
    return (q:Pt,radius:number,exclude=-1)=>{
      const gx=Math.floor(q[0]/cell),gy=Math.floor(q[1]/cell),reach=Math.ceil(radius/cell),near=new Set<number>();
      for(let y=-reach;y<=reach;y++)for(let x=-reach;x<=reach;x++)for(const h of grid.get(`${gx+x},${gy+y}`)??[]) {
        if(h.si===exclude||near.has(h.si))continue;
        const pp=lines[h.si].pts;
        if(project(q,pp[h.i-1],pp[h.i]).distance<=radius)near.add(h.si);
      }
      return near;
    };
  };
  const query=index(strokes,Math.max(2*scale,2*R)),fillQuery=index(fills,8*scale);
  const rep:ContinuityReport={ends:0,free:0,longEnds:0,freeLong:0,freeLongAtFill:0,splitJoins:0};
  if(opts.includePoints)rep.freePoints=[];
  strokes.forEach((s,si)=>{for(const e of s.ends) {
    rep.ends++;const long=s.len>=LONG;if(long)rep.longEnds++;
    const near=query(e,R,si);
    if(!near.size){rep.free++;rep.freePoints?.push({id:s.id,point:e,length:s.len});if(long){rep.freeLong++;if(fillQuery(e,6*scale).size)rep.freeLongAtFill++;}}
    else if([...near].some(i=>strokes[i].ends.some(p=>distance(p,e)<=R)))rep.splitJoins++;
  }});
  return rep;
}
