import { parsePath } from "../vector/pathdata.js";
import { distance, dot, minus, project, sampleSubpath, unit } from "../vector/curveGeometry.js";
import { fitPolyline, segsToPathD } from "../vector/fitCurve.js";
import { buildStrokeGraph, repairJunctionTopology, type TopologyReport } from "../vector/junctionTopology.js";
import type { StrokePrimitive, VectorScene } from "./types.js";

export const detailRole=(s:string)=>/chain|stitch|lace|lattice|mesh|letter|logo|text|engrav|eyelet|gem|stone|prong|facet|사슬|체인|바느질|레이스|글자|보석|아일렛/i.test(s);
export interface SceneTopologyReport extends Omit<TopologyReport,"repaired"|"deferred"> {
  repaired:(TopologyReport["repaired"][number]&{ids:string[]})[];
  deferred:(TopologyReport["deferred"][number]&{ids:string[]})[];
}
/** Same cycle classifier used for fresh skeletons and saved editor geometry.
 * Repairs are per semantic owner and colour: no layer is merged into another. */
function repairPass(scene:VectorScene,scale:number,enabled:boolean):SceneTopologyReport {
  const result:SceneTopologyReport={cyclesBefore:0,cyclesAfter:0,repaired:[],deferred:[]};
  const protectedParts=new Set(scene.parts.filter(p=>detailRole(p.id+" "+p.label)).map(p=>p.id));
  const groups=new Map<string,StrokePrimitive[]>();
  for(const p of scene.primitives)if(p.cls==="STRUCTURAL_STROKE") {
    const key=JSON.stringify([p.partId??"",[...(p.shared??[])].sort(),p.color]);
    (groups.get(key)??groups.set(key,[]).get(key)!).push(p);
  }
  const usedIds=new Set(scene.primitives.map(p=>p.id));
  const externalEnds=scene.primitives.filter((p):p is StrokePrimitive=>p.cls==="STRUCTURAL_STROKE"||p.cls==="DASH_OR_STITCH")
    .flatMap(p=>parsePath(p.d).filter(s=>!s.closed&&s.segs.length).flatMap(s=>[{id:p.id,point:s.start},{id:p.id,point:s.segs.at(-1)!.end}]));
  for(const prims of groups.values()) {
    const lines=prims.flatMap((p,source)=>parsePath(p.d).map(s=>({source,points:sampleSubpath(s,0.5*scale),width:p.width,
      protected:s.closed||detailRole(p.partId??"")||protectedParts.has(p.partId??"")||Boolean(p.route.features.cleanProtected||p.route.features.cleanDetailProtected||p.route.features.glyph||p.route.features.facet)})));
    const {graph,report}=repairJunctionTopology(buildStrokeGraph(lines,1.25*scale,true),scale,enabled,(bb,sources)=>{
      const ids=new Set(sources.map(i=>prims[i].id)),pad=Math.max(8*scale,Math.hypot(bb[2]-bb[0],bb[3]-bb[1])*0.6);
      // A nearby fourth branch may touch the stroke envelope while missing
      // graph snapping. Do not move its support out from under it.
      return !externalEnds.some(e=>!ids.has(e.id)&&e.point[0]>=bb[0]-pad&&e.point[0]<=bb[2]+pad&&e.point[1]>=bb[1]-pad&&e.point[1]<=bb[3]+pad);
    });
    result.cyclesBefore+=report.cyclesBefore;result.cyclesAfter+=report.cyclesAfter;
    for(const kind of ["repaired","deferred"] as const)result[kind].push(...report[kind].map(r=>({...r,ids:r.sources.map(i=>prims[i].id)})));
    const changed=new Set(report.repaired.flatMap(r=>r.sources));
    for(const source of changed) {
      const old=prims[source],replacement:StrokePrimitive[]=[];
      const chunks:{points:import("../vector/pathdata.js").Pt[];v:number}[]=[];
      for(const e of graph.edges.filter(e=>e.source===source)) {
        const prev=chunks.at(-1),a=prev?.points,b=e.points;
        const isNewJunction=report.repaired.some(r=>distance(r.junction!,b[0])<0.01*scale);
        const aligned=a&&dot(unit(minus(a.at(-1)!,a[Math.max(0,a.length-4)])),unit(minus(b[Math.min(3,b.length-1)],b[0])))>0.85;
        if(prev&&prev.v===e.u&&distance(prev.points.at(-1)!,b[0])<0.2*scale&&(!isNewJunction||aligned)) {
          prev.points.push(...b.slice(1));prev.v=e.v;
        } else chunks.push({points:[...b],v:e.v});
      }
      // Graph intersections are audit nodes, not mandatory SVG path breaks.
      // Restore each unchanged through-run before fitting; emitting every graph
      // edge separately used to manufacture new short paths and excess anchors.
      for(const e of chunks) {
        const pp=e.points,cuts:{t:number;p:import("../vector/pathdata.js").Pt}[]=[{t:0,p:pp[0]},{t:pp.length-1,p:pp.at(-1)!}];
        const xmin=Math.min(...pp.map(p=>p[0]))-2*scale,xmax=Math.max(...pp.map(p=>p[0]))+2*scale,
          ymin=Math.min(...pp.map(p=>p[1]))-2*scale,ymax=Math.max(...pp.map(p=>p[1]))+2*scale;
        for(const end of externalEnds) {
          if(end.id===old.id||end.point[0]<xmin||end.point[0]>xmax||end.point[1]<ymin||end.point[1]>ymax)continue;
          // Contact positions inside a replaced knot are deliberately replaced
          // by its common new node. All other existing branch contacts are pins.
          if(report.repaired.some(r=>end.point[0]>=r.bounds[0]-2*scale&&end.point[0]<=r.bounds[2]+2*scale&&end.point[1]>=r.bounds[1]-2*scale&&end.point[1]<=r.bounds[3]+2*scale))continue;
          let best:typeof cuts[number]|null=null,bd=2*scale;
          for(let i=1;i<pp.length;i++){const q=project(end.point,pp[i-1],pp[i]);if(q.distance<bd){bd=q.distance;best={t:i-1+q.t,p:q.point};}}
          if(best&&best.t>0&&best.t<pp.length-1)cuts.push(best);
        }
        cuts.sort((a,b)=>a.t-b.t);
        const segs:ReturnType<typeof fitPolyline>=[];
        for(let i=1;i<cuts.length;i++) {
          const a=cuts[i-1],b=cuts[i];if(distance(a.p,b.p)<0.01*scale)continue;
          const span=[a.p,...pp.slice(Math.floor(a.t)+1,Math.ceil(b.t)),b.p];
          segs.push(...fitPolyline(span,{maxError:0.35*scale,cornerTurnDeg:70,minSpanPx:scale*0.5}));
        }
        if(!segs.length)continue;
        let id=old.id;if(replacement.length){let i=replacement.length;while(usedIds.has(`${old.id}-jt${i}`))i++;id=`${old.id}-jt${i}`;usedIds.add(id);}
        const d=segsToPathD(segs,false),points=sampleSubpath(parsePath(d)[0],scale);
        replacement.push({...old,id,d,bbox:[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))],
          route:{...old.route,features:{...old.route.features,junctionCycleRepaired:true},why:old.route.why+" · 작은 접합 고리 복원(세 갈래 주선 추정)"}});
      }
      const at=scene.primitives.indexOf(old);scene.primitives.splice(at,1,...replacement);
    }
  }
  return result;
}

export function repairSceneJunctions(scene:VectorScene,scale:number,enabled=process.env.V4_JUNCTION_REPAIR!=="0"):SceneTopologyReport {
  const report=repairPass(scene,scale,enabled);
  if(!enabled)return report;
  for(let i=0;i<3&&report.repaired.length;i++) {
    const next=repairPass(scene,scale,true);
    report.cyclesAfter=next.cyclesAfter;report.deferred=next.deferred;
    report.repaired.push(...next.repaired);
    if(!next.repaired.length)break;
  }
  return report;
}
