import type { Pt } from "./pathdata.js";
import { arcLengths, distance, dot, minus, mix, project, resample, unit } from "./curveGeometry.js";

export interface TopologyLine { points:Pt[]; source:number; protected?:boolean; width?:number }
export interface GraphEdge extends TopologyLine { u:number; v:number }
export interface StrokeGraph { nodes:Pt[]; edges:GraphEdge[] }
export interface CycleDecision {
  sources:number[]; cycleRank:number; diameter:number; exits:number;
  reason:string; junction?:Pt; bounds:[number,number,number,number];
}
export interface TopologyReport { cyclesBefore:number; cyclesAfter:number; repaired:CycleDecision[]; deferred:CycleDecision[] }

/** End-to-interior contacts matter: a loop can consist of several individually
 * non-self-intersecting paths. Geometric interior intersections are included
 * for cycle AUDITING; four-arm crossings are ineligible for automatic repair. */
export function buildStrokeGraph(lines:TopologyLine[],snap:number,includeCrossings=false):StrokeGraph {
  const nodes:Pt[]=[],parent:number[]=[],cuts=lines.map(()=>[] as {t:number;n:number}[]);
  const node=(p:Pt)=>{const n=nodes.length;nodes.push(p);parent.push(n);return n;};
  const find=(n:number):number=>{while(parent[n]!==n){parent[n]=parent[parent[n]];n=parent[n];}return n;};
  const union=(a:number,b:number)=>{a=find(a);b=find(b);if(a!==b)parent[Math.max(a,b)]=Math.min(a,b);};
  const endpoints:{line:number;side:number;n:number;p:Pt}[]=[];
  lines.forEach((l,i)=>{for(const side of [0,1]){const t=side?l.points.length-1:0,p=l.points[t],n=node(p);cuts[i].push({t,n});endpoints.push({line:i,side,n,p});}});
  const cell=Math.max(snap*4,1),grid=new Map<string,{line:number;i:number}[]>();
  lines.forEach((l,line)=>{for(let i=1;i<l.points.length;i++){
    const a=l.points[i-1],b=l.points[i];
    for(let y=Math.floor((Math.min(a[1],b[1])-snap)/cell);y<=Math.floor((Math.max(a[1],b[1])+snap)/cell);y++)
      for(let x=Math.floor((Math.min(a[0],b[0])-snap)/cell);x<=Math.floor((Math.max(a[0],b[0])+snap)/cell);x++){
        const k=`${x},${y}`;(grid.get(k)??grid.set(k,[]).get(k)!).push({line,i});
      }
  }});
  for(const e of endpoints) {
    const hits=new Map<number,{t:number;d:number;q:Pt}>();
    for(const s of grid.get(`${Math.floor(e.p[0]/cell)},${Math.floor(e.p[1]/cell)}`)??[]) {
      if(s.line===e.line)continue;
      const p=lines[s.line].points,pr=project(e.p,p[s.i-1],p[s.i]);
      if(pr.distance<=snap&&(!hits.has(s.line)||pr.distance<hits.get(s.line)!.d))hits.set(s.line,{t:s.i-1+pr.t,d:pr.distance,q:pr.point});
    }
    const hs=[...hits].sort((a,b)=>a[1].d-b[1].d||a[0]-b[0]);
    if(!hs.length)continue;
    // Multiple nearby parallel boundaries are ambiguous; exact junctions agree
    // in position and may safely share one node.
    const best=hs[0];
    if(hs.some(h=>h[1].d<best[1].d+snap*0.25&&distance(h[1].q,best[1].q)>snap*0.75))continue;
    cuts[best[0]].push({t:best[1].t,n:e.n});
  }
  if(includeCrossings) {
    const seen=new Set<string>(),cross=(a:Pt,b:Pt)=>a[0]*b[1]-a[1]*b[0];
    for(const bucket of grid.values())for(let i=0;i<bucket.length;i++)for(let j=i+1;j<bucket.length;j++) {
      const a=bucket[i],b=bucket[j];if(a.line===b.line&&Math.abs(a.i-b.i)<=1)continue;
      const ka=`${a.line}:${a.i}`,kb=`${b.line}:${b.i}`,key=ka<kb?ka+"/"+kb:kb+"/"+ka;
      if(seen.has(key))continue;seen.add(key);
      const ap=lines[a.line].points,bp=lines[b.line].points,p=ap[a.i-1],q=bp[b.i-1];
      const u=minus(ap[a.i],p),v=minus(bp[b.i],q),w=minus(q,p),den=cross(u,v);
      if(Math.abs(den)<1e-10)continue;
      const t=cross(w,v)/den,s=cross(w,u)/den;
      if(t<0||t>1||s<0||s>1)continue;
      const n=node(mix(p,ap[a.i],t));cuts[a.line].push({t:a.i-1+t,n});cuts[b.line].push({t:b.i-1+s,n});
    }
  }
  // Close self-loops explicitly, including skeleton chains.
  lines.forEach((l,i)=>{if(distance(l.points[0],l.points.at(-1)!)<Math.max(1e-6,snap*0.05))union(cuts[i][0].n,cuts[i][1].n);});
  cuts.forEach((cs,i)=>{
    cs.sort((a,b)=>a.t-b.t||a.n-b.n);
    const pp=lines[i].points,at=(t:number)=>mix(pp[Math.floor(t)],pp[Math.min(pp.length-1,Math.floor(t)+1)],t%1);
    for(let j=1;j<cs.length;j++)if(distance(at(cs[j].t),at(cs[j-1].t))<Math.max(1e-5,snap*0.1))union(cs[j].n,cs[j-1].n);
  });
  const edges:GraphEdge[]=[];
  lines.forEach((l,i)=>{
    const cs=cuts[i],pp=l.points,at=(t:number)=>mix(pp[Math.floor(t)],pp[Math.min(pp.length-1,Math.floor(t)+1)],t%1);
    for(let j=1;j<cs.length;j++) {
      const a=cs[j-1],b=cs[j];if(b.t-a.t<1e-7)continue;
      const points:Pt[]=[at(a.t)];for(let k=Math.floor(a.t)+1;k<b.t;k++)points.push(pp[k]);points.push(at(b.t));
      // Several projections/intersections at one contact can create a tiny
      // zero-node edge after union. It is not an enclosed face or a real cycle.
      if(find(a.n)===find(b.n)&&arcLengths(points).at(-1)!<Math.max(1e-5,snap*0.5))continue;
      edges.push({...l,points,u:find(a.n),v:find(b.n)});
    }
  });
  return {nodes,edges};
}

/** Edge-biconnected blocks, including parallel edges. Iterative Tarjan traversal
 * avoids recursion limits on detailed chain/mesh samples. */
export function cyclicBlocks(g:StrokeGraph):{ids:number[];rank:number}[] {
  const adj=new Map<number,number[]>();
  const add=(u:number,e:number)=>{(adj.get(u)??adj.set(u,[]).get(u)!).push(e);};
  g.edges.forEach((e,i)=>{add(e.u,i);add(e.v,i);});
  const tin=new Map<number,number>(),low=new Map<number,number>(),bridges=new Set<number>();let clock=0;
  for(const root of adj.keys()) {
    if(tin.has(root))continue;
    tin.set(root,++clock);low.set(root,clock);
    const stack=[{u:root,parent:-1,edge:-1,next:0}];
    while(stack.length) {
      const f=stack.at(-1)!,nb=adj.get(f.u)!;
      if(f.next===nb.length){stack.pop();if(f.edge>=0){low.set(f.parent,Math.min(low.get(f.parent)!,low.get(f.u)!));if(low.get(f.u)!>tin.get(f.parent)!)bridges.add(f.edge);}continue;}
      const ei=nb[f.next++];if(ei===f.edge)continue;
      const e=g.edges[ei],v=e.u===f.u?e.v:e.u;
      if(tin.has(v)){low.set(f.u,Math.min(low.get(f.u)!,tin.get(v)!));continue;}
      tin.set(v,++clock);low.set(v,clock);stack.push({u:v,parent:f.u,edge:ei,next:0});
    }
  }
  const seen=new Set<number>(),out:{ids:number[];rank:number}[]=[];
  for(let i=0;i<g.edges.length;i++) {
    if(bridges.has(i)||seen.has(i))continue;
    const ids:number[]=[],vs=new Set<number>(),queue=[i];seen.add(i);
    while(queue.length){const k=queue.pop()!,e=g.edges[k];ids.push(k);for(const v of [e.u,e.v]){vs.add(v);for(const n of adj.get(v)!)if(!bridges.has(n)&&!seen.has(n)){seen.add(n);queue.push(n);}}}
    out.push({ids,rank:ids.length-vs.size+1});
  }
  return out;
}

/** Enumerate bounded faces of the embedded stroke graph. A small bad junction
 * can sit on a LARGE closed product outline; bridge-connected components alone
 * would hide it inside that large cycle. */
function localCycleBlocks(g:StrokeGraph,scale:number):{ids:number[];rank:number}[] {
  const outgoing=new Map<number,{h:number;angle:number}[]>();
  g.edges.forEach((e,i)=>{for(const side of [0,1]) {
    const pp=side?[...e.points].reverse():e.points,n=side?e.v:e.u;
    const q=pp.find((p,k)=>k>0&&distance(p,pp[0])>0.1*scale)??pp.at(-1)!;
    const angle=Math.atan2(q[1]-pp[0][1],q[0]-pp[0][0]);
    (outgoing.get(n)??outgoing.set(n,[]).get(n)!).push({h:i*2+side,angle});
  }});
  for(const v of outgoing.values())v.sort((a,b)=>a.angle-b.angle||a.h-b.h);
  const next=new Map<number,number>();
  for(const v of outgoing.values())v.forEach((x,i)=>next.set(x.h^1,v[(i+v.length-1)%v.length].h));
  const used=new Set<number>(),faces:number[][]=[];
  for(let h=0;h<g.edges.length*2;h++) {
    if(used.has(h))continue;
    let cur=h;const hs:number[]=[],points:Pt[]=[];
    while(!used.has(cur)){used.add(cur);hs.push(cur);const e=g.edges[cur>>1];points.push(...(cur%2?[...e.points].reverse():e.points));cur=next.get(cur)!;}
    if(cur!==h||points.length<3)continue;
    const signed=points.reduce((s,p,i)=>{const q=points[(i+1)%points.length];return s+p[0]*q[1]-p[1]*q[0];},0)/2;
    if(signed<=0.01*scale*scale)continue;
    const set=new Set(hs),ids=[...new Set(hs.filter(x=>!set.has(x^1)).map(x=>x>>1))];
    if(!ids.length)continue;
    const pp=ids.flatMap(i=>g.edges[i].points),xs=pp.map(p=>p[0]),ys=pp.map(p=>p[1]);
    if(Math.hypot(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))<=24*scale)faces.push(ids);
  }
  const blocks=faces.map(ids=>({ids:new Set(ids),vs:new Set(ids.flatMap(i=>[g.edges[i].u,g.edges[i].v]))}));
  // Adjacent tiny faces belong to one knot. Do not grow along the entire
  // product boundary: the merged footprint must still be local.
  for(let i=0;i<blocks.length;i++)for(let j=i+1;j<blocks.length;j++) {
    const a=blocks[i],b=blocks[j];if(![...a.vs].some(v=>b.vs.has(v)))continue;
    const ids=new Set([...a.ids,...b.ids]),pp=[...ids].flatMap(k=>g.edges[k].points),xs=pp.map(p=>p[0]),ys=pp.map(p=>p[1]);
    if(Math.hypot(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))>24*scale)continue;
    a.ids=ids;a.vs=new Set([...a.vs,...b.vs]);blocks.splice(j--,1);
  }
  return blocks.map(b=>({ids:[...b.ids],rank:b.ids.size-b.vs.size+1})).filter(b=>b.rank>0);
}

/** Only a tiny cyclic junction with three external arms and an unambiguous
 * through-contour is eligible. Two-arm chain links, explicit closed contours,
 * text/facets and semantically protected parts are never collapsed. This is a
 * documented geometric prior, not a claim to recover arbitrary hidden topology. */
export function repairJunctionTopology(g:StrokeGraph,scale:number,enabled=true,canRepair?:(bounds:CycleDecision["bounds"],sources:number[])=>boolean):{graph:StrokeGraph;report:TopologyReport} {
  const global=cyclicBlocks(g),local=localCycleBlocks(g,scale),covered=new Set(local.flatMap(b=>b.ids));
  const blocks=[...local,...global.filter(b=>!b.ids.some(i=>covered.has(i)))];
  const report:TopologyReport={cyclesBefore:global.reduce((n,b)=>n+b.rank,0),cyclesAfter:0,repaired:[],deferred:[]};
  const edges=g.edges.map(e=>({...e,points:e.points.map(p=>[...p] as Pt)})),removed=new Set<number>(),touched=new Set<number>();
  const adj=new Map<number,number[]>();edges.forEach((e,i)=>{for(const n of [e.u,e.v])(adj.get(n)??adj.set(n,[]).get(n)!).push(i);});
  for(const block of blocks) {
    const set=new Set(block.ids),vs=new Set(block.ids.flatMap(i=>[edges[i].u,edges[i].v]));
    const pts=block.ids.flatMap(i=>edges[i].points),xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
    const bounds:[number,number,number,number]=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
    const diameter=Math.hypot(bounds[2]-bounds[0],bounds[3]-bounds[1]);
    const exits=[...new Set([...vs].flatMap(n=>adj.get(n)!).filter(i=>!set.has(i)))];
    const decision:CycleDecision={sources:[...new Set(block.ids.map(i=>edges[i].source))],cycleRank:block.rank,diameter:diameter/scale,exits:exits.length,reason:"",bounds};
    const defer=(reason:string)=>{decision.reason=reason;report.deferred.push(decision);};
    if([...block.ids,...exits].some(i=>edges[i].protected)){defer("protected_detail");continue;}
    if(diameter>24*scale||block.ids.length>20){defer("large_or_complex_cycle");continue;}
    if(exits.length!==3){defer("not_three_arm_junction");continue;}
    if(exits.some(i=>touched.has(i))){defer("neighboring_repair");continue;}
    const arms=exits.map(i=>{
      const e=edges[i],reverse=vs.has(e.v),pp=resample(reverse?[...e.points].reverse():e.points,scale*0.5),acc=arcLengths(pp);
      const index=acc.findIndex(x=>x>=Math.max(8*scale,diameter*0.6));
      const k=index<0?pp.length-1:index,k2=Math.min(pp.length-1,k+Math.ceil(8*scale/(scale*0.5)));
      return {i,e,reverse,pp,k,support:pp[k],t:unit(minus(pp[k2],pp[k])),length:acc.at(-1)!};
    });
    if(arms.some(a=>a.k+4>=a.pp.length)||arms.some(a=>a.length<14*scale)){defer("insufficient_outside_support");continue;}
    const pairs=arms.flatMap((a,i)=>arms.slice(i+1).map(b=>({a,b,score:-dot(a.t,b.t)}))).sort((a,b)=>b.score-a.score);
    const main=pairs[0];
    if(main.score<0.85||main.score-(pairs[1]?.score??0)<0.18){defer("ambiguous_main_direction");continue;}
    const a=main.a,b=main.b,c=arms.find(x=>x!==a&&x!==b)!,axis=minus(b.support,a.support);
    const cross=(x:Pt,y:Pt)=>x[0]*y[1]-x[1]*y[0],den=cross(axis,c.t);
    if(Math.abs(den)<distance(a.support,b.support)*0.3){defer("shallow_branch");continue;}
    let t=cross(minus(c.support,a.support),c.t)/den;
    let q=mix(a.support,b.support,t);
    // The side branch may be curved. Its distant tangent is not an exact
    // straight-line extrapolation through the knot. Keep the through-contour
    // and use the defect's projected centre when that extrapolation escapes.
    if(q[0]<bounds[0]-2*scale||q[0]>bounds[2]+2*scale||q[1]<bounds[1]-2*scale||q[1]>bounds[3]+2*scale) {
      const centre:Pt=[(bounds[0]+bounds[2])/2,(bounds[1]+bounds[3])/2];
      const pr=project(centre,a.support,b.support);t=pr.t;q=pr.point;
    }
    if(t<0.15||t>0.85||q[0]<bounds[0]-3*scale||q[0]>bounds[2]+3*scale||q[1]<bounds[1]-3*scale||q[1]>bounds[3]+3*scale){defer("junction_outside_defect");continue;}
    if(arms.some(x=>dot(unit(minus(x.support,q)),x.t)<0.8)){defer("backtracking_arm");continue;}
    const changedSources=[...new Set([...block.ids,...exits].map(i=>edges[i].source))];
    if(canRepair&&!canRepair(bounds,changedSources)){defer("external_contact_in_footprint");continue;}
    if(!enabled){defer("repair_disabled");continue;}
    // Replace only the local footprint. A short Hermite approach keeps the
    // observed outside tangent; both main arms share the SAME junction tangent.
    const newNode=g.nodes.length+report.repaired.length;
    const mainT=unit(axis);
    for(const arm of arms) {
      const tq=arm===a?[-mainT[0],-mainT[1]] as Pt:arm===b?mainT:arm.t;
      const L=distance(q,arm.support),p1:Pt=[q[0]+tq[0]*L/3,q[1]+tq[1]*L/3],p2:Pt=[arm.support[0]-arm.t[0]*L/3,arm.support[1]-arm.t[1]*L/3];
      const local:Pt[]=[];const n=Math.max(4,Math.ceil(L/(scale*0.5)));
      for(let j=0;j<=n;j++){const t=j/n,u=1-t;local.push([u*u*u*q[0]+3*u*u*t*p1[0]+3*u*t*t*p2[0]+t*t*t*arm.support[0],u*u*u*q[1]+3*u*u*t*p1[1]+3*u*t*t*p2[1]+t*t*t*arm.support[1]]);}
      const out=[...local,...arm.pp.slice(arm.k+1)];
      arm.e.points=arm.reverse?out.reverse():out;if(arm.reverse)arm.e.v=newNode;else arm.e.u=newNode;touched.add(arm.i);
    }
    block.ids.forEach(i=>removed.add(i));decision.sources=changedSources;decision.junction=q;decision.reason="three_arm_main_contour";report.repaired.push(decision);
  }
  const graph={nodes:[...g.nodes,...report.repaired.map(r=>r.junction!)],edges:edges.filter((_,i)=>!removed.has(i))};
  report.cyclesAfter=cyclicBlocks(graph).reduce((n,b)=>n+b.rank,0);
  return {graph,report};
}
