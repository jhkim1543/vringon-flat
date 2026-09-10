import { parsePath, serializePath, type Pt, type SubPath } from "../vector/pathdata.js";
import { fitSmoothSpline } from "../vector/fitSpline.js";
import { fitPolyline, segsToPathD } from "../vector/fitCurve.js";
import { arcLengths, boundedDeviation, crossingIndex, distance, dot, minus, project, properCrossings,
  resample, roughness, sampleSubpath, unit } from "../vector/curveGeometry.js";
import type { ScenePrimitive, StrokePrimitive, VectorScene } from "./types.js";

export interface CleanOptions {
  /** Scene coordinates per source image pixel. */
  scale: number;
  maxDeviationPx?: number;
  microGapPx?: number;
  removeSpurs?: boolean;
}
export interface CleanReport {
  spurIds: string[];
  trimmedHookIds: string[];
  speckIds: string[];
  joined: { kept: string; absorbed: string; gapSourcePx: number; evidence: "geometry-prior" }[];
  smoothed: { id: string; anchorsBefore: number; anchorsAfter: number; deviationSourcePx: number;
    roughnessBefore: number; roughnessAfter: number }[];
  deferred: { id: string; reason: string }[];
  anchorsBefore: number;
  anchorsAfter: number;
}
const anchors=(d:string)=>parsePath(d).reduce((n,s)=>n+1+s.segs.length,0);
const eligible=(p:ScenePrimitive):p is StrokePrimitive=>p.cls==="STRUCTURAL_STROKE" &&
  !p.route.features.cleanProtected && !p.route.features.glyph && !p.route.features.facet;
const removalProtected=(p:ScenePrimitive)=>Boolean(p.route.features.cleanDetailProtected)||
  /chain|stitch|lace|lattice|mesh|letter|logo|text|engrav/i.test(p.partId??"");
const envNumber=(key:string,fallback:number)=>{
  const n=Number(process.env[key]??fallback);return Number.isFinite(n)&&n>=0?n:fallback;
};
const oneOpen=(p:StrokePrimitive)=>{
  const s=parsePath(p.d);return s.length===1&&!s[0].closed&&s[0].segs.length?s[0]:null;
};
function reverse(s:SubPath):SubPath {
  const starts=[s.start,...s.segs.map(x=>x.end)];
  return {start:starts.at(-1)!,closed:false,segs:s.segs.map((x,i)=>x.type==="L"?{type:"L" as const,end:starts[i]}:
    {type:"C" as const,end:starts[i],c1:x.c2,c2:x.c1}).reverse()};
}

/** Drop a short one-ended hair only when it touches the INTERIOR of a much
 * longer continuation. Two-ended bridges, closed eyelets and declared stitches
 * are excluded. This is an explicit cleanup policy, not a semantic classifier. */
export function removeTerminalSpurs(prims:ScenePrimitive[],scale:number):string[] {
  const all=prims.filter(eligible).map(p=>{
    const s=oneOpen(p),pts=s?sampleSubpath(s,scale):[];
    return {p,s,pts,length:arcLengths(pts).at(-1)??0};
  }).filter(x=>x.s&&x.pts.length>1);
  const drop=new Set<string>();
  for(const c of all) {
    if(removalProtected(c.p))continue;
    if(c.length>envNumber("V4_CLEAN_SPUR_PX",18)*scale||c.length<0.25*scale)continue;
    const ends=[c.pts[0],c.pts.at(-1)!];
    const attachments=ends.map(e=>{
      let best:{owner:typeof c; index:number; distance:number}|null=null;
      for(const o of all) {
        if(o===c||o.length<Math.max(40*scale,c.length*6)||drop.has(o.p.id))continue;
        const acc=arcLengths(o.pts);
        for(let i=1;i<o.pts.length;i++) {
          if(acc[i]<10*scale||o.length-acc[i]<10*scale)continue;
          const d=project(e,o.pts[i-1],o.pts[i]).distance;
          if(d<=Math.max(0.65*scale,o.p.width*0.55)&&(!best||d<best.distance))best={owner:o,index:i,distance:d};
        }
      }
      return best;
    });
    if(Boolean(attachments[0])===Boolean(attachments[1]))continue;
    const side=attachments[0]?0:1,a=attachments[side]!,free=ends[1-side];
    // A nearby third endpoint can be the other half of a real short connector.
    const nearOther=all.some(o=>o!==c&&o!==a.owner&&[o.pts[0],o.pts.at(-1)!].some(p=>distance(p,free)<3*scale));
    if(nearOther)continue;
    const i=a.index,op=a.owner.pts;
    const lo=op[Math.max(0,i-Math.ceil(5*scale/scale))],hi=op[Math.min(op.length-1,i+5)];
    const tangent=unit(minus(hi,lo)),branch=unit(minus(free,ends[side]));
    if(Math.abs(dot(tangent,branch))>0.8)continue; // collinear continuation is not a hair
    if(c.p.partId&&a.owner.p.partId&&c.p.partId!==a.owner.p.partId)continue;
    drop.add(c.p.id);
  }
  for(let i=prims.length-1;i>=0;i--)if(drop.has(prims[i].id))prims.splice(i,1);
  return [...drop];
}

/**
 * 긴 윤곽 옆의 작은 조각 제거 — **기본 끔(0). 켜지 말 것.**
 *
 * 세 번째로 같은 실패를 봤다. 이 규칙 모양은 "작은 잔여물"과 "작은 진짜 디테일"을
 * 기하로 가르려 하는데, 도면에서 둘은 구별되지 않는다.
 *
 *   · v7.5 우리 `pruneStrokes` 의 고립 티끌 규칙 — 작은 디테일 회수율 0.94 → 0.81, 껐다.
 *   · v7.9 이 규칙 — 9종 실측에서 **shoe_3 한 종에서만 발동**해 레이스 눈금 3개를 지우고
 *     충실도 게이트를 깼다(회수율 0.625). 9종 전체에서 얻은 앵커는 **6개(0.04%)** 뿐이다.
 *
 * 보호 목록을 partId 정규식(`logo|letter|text|chain|stitch|...`)으로 두는 방식도 근본이
 * 아니다 — shoe_3 이 걸린 이유가 바로 `laces`·`loop` 가 목록에 없어서였고, 다음 제품은
 * 또 다른 이름을 들고 온다. 이름을 늘리는 것은 두더지잡기다.
 *
 * 지울 값어치가 있으려면 **지워도 QA 의 디테일 회수율이 안 떨어진다는 것을 재서** 알아야
 * 하는데, 그 측정은 이 단계에서 할 수 없다. 그래서 지우지 않는다.
 * `V4_CLEAN_SPECK_PX=<px>` 로 켤 수 있게만 남긴다.
 */
export function removeNearContourSpecks(prims:ScenePrimitive[],scale:number):string[] {
  const limit=envNumber("V4_CLEAN_SPECK_PX",0)*scale;if(!limit)return [];
  const long=prims.filter(eligible).map(p=>({p,pts:parsePath(p.d).flatMap(s=>sampleSubpath(s,scale))}))
    .filter(x=>(arcLengths(x.pts).at(-1)??0)>100*scale);
  const removed:string[]=[];
  for(const p of prims) {
    if(removalProtected(p)||!("d"in p)||p.route.features.glyph||p.route.features.cleanProtected||p.route.features.facet||
      /logo|letter|text|chain|stitch|pattern|engrav|detail/i.test(p.partId??""))continue;
    const sub=parsePath(p.d);if(sub.length!==1)continue;
    const pts=sampleSubpath(sub[0],scale*0.5),len=arcLengths(pts).at(-1)??0;
    if(!pts.length)continue;
    if(eligible(p)) {if(sub[0].closed||len>limit)continue;}
    else if(p.cls==="OUTLINE_SHAPE") {
      const xs=pts.map(q=>q[0]),ys=pts.map(q=>q[1]);
      const area=Math.abs(pts.reduce((a,q,i)=>{const r=pts[(i+1)%pts.length];return a+q[0]*r[1]-q[1]*r[0];},0)/2);
      if(area>8*scale*scale||Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))>limit)continue;
    } else continue;
    const neighbors=long.filter(o=>o.p!==p&&(!p.partId||!o.p.partId||p.partId===o.p.partId)).filter(o=>
      pts.some(q=>o.pts.some((b,i)=>i>0&&project(q,o.pts[i-1],b).distance<8*scale)));
    if(neighbors.length!==1)continue;
    // If both endpoints touch existing ink, this might be a short bridge.
    const attached=pts.length>1&&[pts[0],pts.at(-1)!].every(q=>prims.some(o=>o!==p&&"d"in o&&
      parsePath(o.d).some(s=>sampleSubpath(s,scale).some((b,i,pp)=>i>0&&project(q,pp[i-1],b).distance<3*scale))));
    if(attached)continue;
    removed.push(p.id);
  }
  const ids=new Set(removed);for(let i=prims.length-1;i>=0;i--)if(ids.has(prims[i].id))prims.splice(i,1);
  return removed;
}

/** A previous join can hide a spur in the tail of a long path. Only trim at
 * an existing anchor that is also a long continuation's endpoint. No interior
 * contour is invented, and two-ended connectors are protected. */
export function trimTerminalHooks(prims:ScenePrimitive[],scale:number):string[] {
  const changed:string[]=[],all=prims.filter(eligible);
  for(const p of all)for(const reverseEnd of [false,true]) {
    if(removalProtected(p))continue;
    const original=oneOpen(p);if(!original||original.segs.length<2)continue;
    const s=reverseEnd?reverse(original):original;
    const whole=sampleSubpath(s,scale),total=arcLengths(whole).at(-1)!;
    for(let j=s.segs.length-2;j>=0;j--) {
      const q=s.segs[j].end;
      const tail:SubPath={start:q,segs:s.segs.slice(j+1),closed:false};
      const tp=sampleSubpath(tail,scale*0.5),len=arcLengths(tp).at(-1)!;
      if(len>envNumber("V4_CLEAN_SPUR_PX",18)*scale)break;
      if(len<scale||total-len<Math.max(60*scale,len*6))continue;
      const candidates=all.filter(o=>o!==p&&(!o.partId||!p.partId||o.partId===p.partId))
        .flatMap(o=>endData(o,scale)).filter(e=>distance(e.point,q)<0.2*scale&&e.length>Math.max(40*scale,len*6));
      if(candidates.length!==1)continue;
      const e=candidates[0],body:SubPath={start:s.start,segs:s.segs.slice(0,j+1),closed:false};
      const bp=resample(sampleSubpath(body,scale),scale);
      const incoming=unit(minus(bp.at(-1)!,bp[Math.max(0,bp.length-10)]));
      const continuation:Pt=[-e.t[0],-e.t[1]];
      if(dot(incoming,continuation)<0.9||dot(unit(minus(tp.at(-1)!,q)),continuation)>0.9)continue;
      const free=tp.at(-1)!;
      if(all.some(o=>o!==p&&endData(o,scale).some(a=>distance(a.point,free)<3*scale)))continue;
      p.d=serializePath([reverseEnd?reverse(body):body]);p.route.features.terminalHookRemoved=true;
      changed.push(p.id);break;
    }
  }
  return [...new Set(changed)];
}

/** Arc-window tangents do not inherit tiny terminal hook handles. */
function endData(p:StrokePrimitive,scale:number) {
  const s=oneOpen(p);if(!s)return [];
  const pts=resample(sampleSubpath(s,scale*0.6),scale),length=arcLengths(pts).at(-1)!;
  const k=Math.min(pts.length-1,Math.max(2,Math.round(Math.min(12*scale,length*0.2)/scale)));
  return [
    {p,s,side:0,point:pts[0],t:unit(minus(pts[0],pts[k])),length},
    {p,s,side:1,point:pts.at(-1)!,t:unit(minus(pts.at(-1)!,pts[pts.length-1-k])),length},
  ];
}

export function joinMicroGaps(prims:ScenePrimitive[],scale:number,maxGapSource:number):CleanReport["joined"] {
  const out:CleanReport["joined"]=[];
  if(!(maxGapSource>0))return out;
  for(let pass=0;pass<12;pass++) {
    const ends=prims.filter(eligible).filter(p=>!removalProtected(p)).flatMap(p=>endData(p,scale));
    const dead=new Set<string>();let joined=0;
    const compatible=(a:typeof ends[number],b:typeof ends[number])=>{
      if(a.p===b.p||dead.has(a.p.id)||dead.has(b.p.id))return false;
      if(a.p.color!==b.p.color)return false;
      if(a.p.partId&&b.p.partId&&a.p.partId!==b.p.partId&&
        !a.p.shared?.includes(b.p.partId)&&!b.p.shared?.includes(a.p.partId))return false;
      const g=distance(a.point,b.point),w=Math.min(a.p.width,b.p.width);
      if(g>Math.min(maxGapSource*scale,Math.max(1.5*scale,8*w)))return false;
      if(Math.min(a.length,b.length)<Math.max(12*scale,g*6))return false;
      if(Math.max(a.p.width,b.p.width)/Math.max(1e-6,w)>1.8)return false;
      if(g<0.015*scale)return dot(a.t,b.t)<-0.92;
      const v=unit(minus(b.point,a.point));
      if(g>3*scale) {
        if(Math.min(a.length,b.length)<Math.max(50*scale,10*g)||dot(a.t,v)<0.985||dot(b.t,v)>-0.985||dot(a.t,b.t)>-0.97)return false;
        // Both ends must actually be free. A line touching another contour may
        // end intentionally there; do not continue it through an occlusion.
        for(const p of prims)if(p!==a.p&&p!==b.p&&"d"in p) {
          for(const s of parsePath(p.d)){const pp=sampleSubpath(s,scale);
            for(let i=1;i<pp.length;i++)if(project(a.point,pp[i-1],pp[i]).distance<2*scale||project(b.point,pp[i-1],pp[i]).distance<2*scale)return false;
          }
        }
      }
      return dot(a.t,v)>0.92&&dot(b.t,v)<-0.92&&dot(a.t,b.t)<-0.92;
    };
    const best=(a:typeof ends[number])=>{
      const c=ends.filter(b=>compatible(a,b)).sort((b,c)=>distance(a.point,b.point)-distance(a.point,c.point)||b.p.id.localeCompare(c.p.id));
      if(c.length>1&&distance(a.point,c[1].point)<distance(a.point,c[0].point)+scale)return null;
      return c[0]??null;
    };
    for(const a of ends) {
      if(dead.has(a.p.id))continue;
      const b=best(a);if(!b||best(b)!==a)continue;
      const g=distance(a.point,b.point);
      const keep=a.side===0?reverse(a.s):a.s,take=b.side===1?reverse(b.s):b.s;
      const c1:Pt=[a.point[0]+a.t[0]*g/3,a.point[1]+a.t[1]*g/3];
      const c2:Pt=[b.point[0]+b.t[0]*g/3,b.point[1]+b.t[1]*g/3];
      const bridge:SubPath={start:a.point,closed:false,segs:[{type:"C",c1,c2,end:b.point}]};
      const bridgePts=sampleSubpath(bridge,0.4*scale);
      // Do not cross other strokes or a glyph boundary. A blocked interval is a
      // possible occlusion, so the conservative micro-gap pass defers it.
      let blocked=false;
      for(const p of prims) {
        if(g<0.015*scale)break; // No new geometry: an existing T node stays attached.
        if(p===a.p||p===b.p||!("d"in p))continue;
        const subs=parsePath(p.d),lines=subs.map(s=>sampleSubpath(s,scale));
        if(p.cls==="OUTLINE_SHAPE"||p.cls==="FACE_FILL"||p.cls==="TEXTURE_TONE") {
          const inside=(q:Pt)=>{
            let odd=false;
            for(const ring of lines)for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
              const a=ring[i],b=ring[j];
              if((a[1]>q[1])!==(b[1]>q[1])&&q[0]<(b[0]-a[0])*(q[1]-a[1])/(b[1]-a[1])+a[0])odd=!odd;
            }
            return odd;
          };
          if(bridgePts.some(inside)){blocked=true;break;}
        }
        const radius=(p.cls==="STRUCTURAL_STROKE"||p.cls==="DASH_OR_STITCH")?Math.max(scale*0.4,p.width*0.5):scale;
        for(const pts of lines)for(const q of bridgePts.slice(1,-1)) {
          for(let j=1;j<pts.length;j++)if(project(q,pts[j-1],pts[j]).distance<radius){blocked=true;break;}
          if(blocked)break;
        }
        if(blocked)break;
      }
      if(blocked)continue;
      if(g>=0.015*scale)keep.segs.push(...bridge.segs);
      keep.segs.push(...take.segs);a.p.d=serializePath([keep]);
      a.p.shared=[...new Set([...(a.p.shared??[]),...(b.p.shared??[]),b.p.partId].filter((x):x is string=>!!x&&x!==a.p.partId))];
      if(!a.p.partId)a.p.partId=b.p.partId;
      a.p.route.features.inferredMicroGap=true;
      a.p.route.why+=" · 짧은 틈 접선 연결(형상 추정)";
      prims.splice(prims.indexOf(b.p),1);dead.add(a.p.id);dead.add(b.p.id);joined++;
      out.push({kept:a.p.id,absorbed:b.p.id,gapSourcePx:g/scale,evidence:"geometry-prior"});
    }
    if(!joined)break;
  }
  return out;
}

/** One fitted curve over a whole stroke, with pinned ends, sharp corners and
 * existing T-junction contacts. The tolerance is checked against PRE-fit data. */
function smoothStrokeCandidate(d:string,scale:number,tolerance:number,pins:Pt[],fitFactor:number) {
  const subs=parsePath(d),before=anchors(d);
  if(subs.length!==1||subs[0].closed||subs[0].segs.length<2)return {d,changed:false,reason:"protected_or_minimal"};
  const raw=sampleSubpath(subs[0],0.5*scale),pts=resample(raw,0.7*scale);
  if(pts.length>12000)return {d,changed:false,reason:"sampling_budget"};
  const cuts=new Set<number>([0,pts.length-1]),corners=new Set<number>();
  // True corners persist at two physical window sizes; a short wiggle does not.
  const turn=(i:number,k:number)=>Math.acos(Math.max(-1,Math.min(1,dot(unit(minus(pts[i],pts[i-k])),unit(minus(pts[i+k],pts[i]))))));
  const k=6;
  for(let i=k*2;i<pts.length-k*2;i++) if(turn(i,k)>Math.PI/3&&turn(i,k*2)>Math.PI/3) {
    let best=i;
    for(let j=i+1;j<=Math.min(i+k,pts.length-k*2-1);j++)if(turn(j,k)>turn(best,k))best=j;
    cuts.add(best);corners.add(best);i=best+k;
  }
  for(const pin of pins) {
    let best=-1,bd=0.7*scale;
    for(let i=1;i<pts.length-1;i++){const dd=distance(pin,pts[i]);if(dd<bd){bd=dd;best=i;}}
    if(best>=0){pts[best]=pin;cuts.add(best);}
  }
  const indices=[...cuts].sort((a,b)=>a-b),fitted:string[]=[];
  for(let ci=1;ci<indices.length;ci++) {
    const p=pts.slice(indices[ci-1],indices[ci]+1),smooth:Pt[]=p.map(x=>[...x]);
    const radius=5;
    for(let i=1;i<p.length-1;i++) {
      let w=0,x=0,y=0;
      const r=Math.min(radius,i,p.length-1-i);
      for(let j=-r;j<=r;j++){const q=Math.exp(-j*j/8);w+=q;x+=q*p[i+j][0];y+=q*p[i+j][1];}
      const q:Pt=[x/w,y/w],delta=distance(q,p[i]);
      const blend=Math.min(0.7,tolerance*0.45/Math.max(1e-12,delta));
      smooth[i]=[p[i][0]+blend*(q[0]-p[i][0]),p[i][1]+blend*(q[1]-p[i][1])];
    }
    const segs=fitSmoothSpline(smooth,tolerance*fitFactor,20) ?? fitPolyline(smooth,{maxError:tolerance*fitFactor*0.86,cornerTurnDeg:70,minCornerGapPx:4*scale,minSpanPx:scale});
    if(!segs.length)return {d,changed:false,reason:"fit_failed"};
    fitted.push(segsToPathD(segs,false));
  }
  const joined=parsePath(fitted[0])[0];
  for(let i=1;i<fitted.length;i++) {
    const sub=parsePath(fitted[i])[0],prev=joined.segs.at(-1)!,next=sub.segs[0];
    if(!corners.has(indices[i])&&prev.type==="C"&&next.type==="C") {
      const q=prev.end,u=unit(minus(q,prev.c2!)),v=unit(minus(next.c1!,q));
      if(dot(u,v)>0.5) {
        const t=unit([u[0]+v[0],u[1]+v[1]]),la=distance(q,prev.c2!),lb=distance(q,next.c1!);
        prev.c2=[q[0]-t[0]*la,q[1]-t[1]*la];next.c1=[q[0]+t[0]*lb,q[1]+t[1]*lb];
      }
    }
    joined.segs.push(...sub.segs);
  }
  const nd=serializePath([joined]),candidate=sampleSubpath(joined,0.5*scale);
  const dev=boundedDeviation(raw,candidate,tolerance);
  if(dev>tolerance)return {d,changed:false,reason:"deviation"};
  if(properCrossings(candidate)>0)return {d,changed:false,reason:"intersection"};
  const rb=roughness(raw,scale),ra=roughness(candidate,scale);
  if(anchors(nd)>before||ra>rb*1.05+0.01)return {d,changed:false,reason:"complexity_or_roughness",candidateAnchors:anchors(nd),inputAnchors:before,rb,ra};
  if(anchors(nd)===before&&ra>rb*0.9)return {d,changed:false,reason:"no_gain"};
  return {d:nd,changed:true,reason:"accepted",deviation:dev,roughnessBefore:rb,roughnessAfter:ra};
}

/** Try several fitting budgets against the SAME final deviation gate. A loose
 * fit that overshoots is rejected, not evidence that the whole stroke cannot
 * be simplified. Selection is deterministic and favors fewer anchors. */
export function smoothStroke(d:string,scale:number,tolerance:number,pins:Pt[]=[]) {
  const trials=[0.7,1.05,1.4].map(f=>smoothStrokeCandidate(d,scale,tolerance,pins,f));
  // Matching a contact tangent can push an otherwise valid fit just outside
  // the final distance budget. Retry a tighter initial fit, keeping the SAME
  // final budget; raising the allowed displacement is unnecessary.
  if(!trials.some(r=>r.changed)&&trials.some(r=>r.reason==="deviation"))
    trials.push(...[0.35,0.5].map(f=>smoothStrokeCandidate(d,scale,tolerance,pins,f)));
  const accepted=trials.filter(r=>r.changed).sort((a,b)=>anchors(a.d)-anchors(b.d)||
    (a.roughnessAfter??Infinity)-(b.roughnessAfter??Infinity));
  return accepted[0]??trials[0];
}

export function cleanContours(scene:VectorScene,opts:CleanOptions,say?:(m:string)=>void):CleanReport {
  const scale=opts.scale;if(!(scale>0&&Number.isFinite(scale)))throw new Error("Invalid source scale");
  const prims=scene.primitives,strokes=()=>prims.filter(eligible);
  const protectedParts=new Set(scene.parts.filter(p=>/chain|stitch|lace|lattice|mesh|letter|logo|text|engrav|사슬|체인|바느질|레이스|글자/i.test(p.id+" "+p.label)).map(p=>p.id));
  for(const p of prims)if(p.partId&&protectedParts.has(p.partId))p.route.features.cleanDetailProtected=true;
  const report:CleanReport={spurIds:[],trimmedHookIds:[],speckIds:[],joined:[],smoothed:[],deferred:[],
    anchorsBefore:strokes().reduce((n,p)=>n+anchors(p.d),0),anchorsAfter:0};
  if(opts.removeSpurs!==false&&process.env.V4_CLEAN_SPURS!=="0") {
    report.trimmedHookIds=trimTerminalHooks(prims,scale);
    report.spurIds=removeTerminalSpurs(prims,scale);
    report.speckIds=removeNearContourSpecks(prims,scale);
  }
  report.joined=joinMicroGaps(prims,scale,opts.microGapPx??envNumber("V4_CLEAN_GAP_PX",12));
  // A backbone split into short paths fails the long-parent hair test. Once
  // joins restore its actual length, revisit leaves BEFORE pinning contacts.
  if(opts.removeSpurs!==false&&process.env.V4_CLEAN_SPURS!=="0"&&report.joined.length) {
    report.spurIds.push(...removeTerminalSpurs(prims,scale));
    report.speckIds.push(...removeNearContourSpecks(prims,scale));
  }
  const all=strokes();
  const support=prims.filter((p):p is StrokePrimitive=>p.cls==="STRUCTURAL_STROKE"||p.cls==="DASH_OR_STITCH");
  const ends=support.flatMap(p=>endData(p,scale).filter(e=>e.length>0.25*scale).map(e=>({p,point:e.point})));
  const tol=scale*(opts.maxDeviationPx??envNumber("V4_CLEAN_DEV_PX",2));
  const geometry=new Map(support.map(p=>[p,parsePath(p.d).flatMap(s=>sampleSubpath(s,scale*0.5))]));
  const collisions=new Map(support.map(p=>[p,crossingIndex(geometry.get(p)!,8*scale)]));
  for(const p of all) {
    const pts=parsePath(p.d).flatMap(s=>sampleSubpath(s,scale));
    const pins:Pt[]=[],contacts:{point:Pt;distance:number}[]=[];
    for(const e of ends) {
      if(e.p===p)continue;
      let best:Pt|null=null,bd=3*scale;
      for(let i=1;i<pts.length;i++) {const pr=project(e.point,pts[i-1],pts[i]);if(pr.distance<bd){bd=pr.distance;best=pr.point;}}
      if(best){pins.push(best);contacts.push({point:e.point,distance:bd});}
    }
    const before=anchors(p.d),r=smoothStroke(p.d,scale,tol,pins);
    if(r.changed) {
      const proposed=parsePath(r.d).flatMap(s=>sampleSubpath(s,scale*0.5));
      const lostContact=contacts.some(c=>{
        let near=Infinity;for(let i=1;i<proposed.length;i++)near=Math.min(near,project(c.point,proposed[i-1],proposed[i]).distance);
        return near>c.distance+0.05*scale;
      });
      if(lostContact){report.deferred.push({id:p.id,reason:"junction_contact_loss"});continue;}
      const crossed=support.some(o=>o!==p&&collisions.get(o)!(proposed)>collisions.get(o)!(geometry.get(p)!));
      if(crossed){report.deferred.push({id:p.id,reason:"new_cross_path_intersection"});continue;}
      geometry.set(p,proposed);collisions.set(p,crossingIndex(proposed,8*scale));
      p.d=r.d;report.smoothed.push({id:p.id,anchorsBefore:before,anchorsAfter:anchors(p.d),
        deviationSourcePx:r.deviation!/scale,roughnessBefore:r.roughnessBefore!,roughnessAfter:r.roughnessAfter!});
      p.route.features.contourSmoothed=true;
    } else report.deferred.push({id:p.id,reason:r.reason});
  }
  for(const p of all) {
    const pts=parsePath(p.d).flatMap(s=>sampleSubpath(s,scale));
    if(pts.length)p.bbox=[Math.min(...pts.map(x=>x[0])),Math.min(...pts.map(x=>x[1])),Math.max(...pts.map(x=>x[0])),Math.max(...pts.map(x=>x[1]))];
  }
  // Joins and removals happen after the old shared-boundary table was built.
  scene.sharedBoundaries=prims.filter(p=>p.partId&&p.shared?.length).map(p=>({primitiveId:p.id,between:[p.partId!,...p.shared!]}));
  report.anchorsAfter=strokes().reduce((n,p)=>n+anchors(p.d),0);
  say?.(`선 정리 — 잔가지 ${report.spurIds.length} · 끝 갈고리 ${report.trimmedHookIds.length} · 작은 잔흔 ${report.speckIds.length} · 미세 틈 ${report.joined.length} · 곡선 ${report.smoothed.length} · 구조선 앵커 ${report.anchorsBefore} → ${report.anchorsAfter}`);
  return report;
}
