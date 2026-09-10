import { parsePath, type Pt, type SubPath } from "./pathdata.js";

export const distance = (a: Pt, b: Pt) => Math.hypot(a[0]-b[0], a[1]-b[1]);
export const unit = (a: Pt): Pt => { const n = Math.hypot(...a); return n > 1e-12 ? [a[0]/n,a[1]/n] : [0,0]; };
export const dot = (a: Pt,b: Pt) => a[0]*b[0]+a[1]*b[1];
export const minus = (a: Pt,b: Pt): Pt => [a[0]-b[0],a[1]-b[1]];
export const mix = (a: Pt,b: Pt,t: number): Pt => [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];

export function sampleSubpath(sp: SubPath, step = 1): Pt[] {
  const out: Pt[] = [sp.start]; let p = sp.start;
  for (const s of sp.segs) {
    if (s.type === "L") {
      const n = Math.max(1, Math.ceil(distance(p,s.end)/step));
      if (n > 100000) throw new Error("Curve sampling budget exceeded");
      for (let i=1;i<=n;i++) out.push(mix(p,s.end,i/n));
    } else {
      const length = distance(p,s.c1!)+distance(s.c1!,s.c2!)+distance(s.c2!,s.end);
      const n = Math.max(4, Math.ceil(length/step));
      if (n > 100000) throw new Error("Curve sampling budget exceeded");
      for(let i=1;i<=n;i++) {
        const t=i/n,u=1-t;
        out.push([u*u*u*p[0]+3*u*u*t*s.c1![0]+3*u*t*t*s.c2![0]+t*t*t*s.end[0],
          u*u*u*p[1]+3*u*u*t*s.c1![1]+3*u*t*t*s.c2![1]+t*t*t*s.end[1]]);
      }
    }
    p=s.end;
  }
  if(sp.closed && distance(p,sp.start)>1e-8) {
    const n=Math.max(1,Math.ceil(distance(p,sp.start)/step));
    for(let i=1;i<=n;i++) out.push(mix(p,sp.start,i/n));
  }
  return out;
}

export function resample(points: Pt[], step: number): Pt[] {
  if(points.length<2) return points;
  const a=arcLengths(points), total=a.at(-1)!;
  if(total<1e-8) return [points[0],points.at(-1)!];
  const n=Math.max(2,Math.ceil(total/step));
  if(n>100000) throw new Error("Curve resampling budget exceeded");
  let j=1;const out:Pt[]=[points[0]];
  for(let i=1;i<n;i++) {
    const d=total*i/n;
    while(j<a.length-1 && a[j]<d) j++;
    out.push(mix(points[j-1],points[j],(d-a[j-1])/Math.max(1e-12,a[j]-a[j-1])));
  }
  out.push(points.at(-1)!);return out;
}

export function arcLengths(points: Pt[]): number[] {
  const a=[0];for(let i=1;i<points.length;i++)a.push(a[i-1]+distance(points[i-1],points[i]));return a;
}

export function project(p: Pt,a: Pt,b: Pt): {point:Pt; t:number; distance:number} {
  const d=minus(b,a), t=Math.max(0,Math.min(1,dot(minus(p,a),d)/Math.max(1e-20,dot(d,d))));
  const point=mix(a,b,t);return {point,t,distance:distance(p,point)};
}

/** Point-to-segment, not point-to-point: a long straight cubic must not fail
 * merely because its two equally valid samplings have different densities. */
export function maxDistanceToPolyline(points:Pt[],line:Pt[]):number {
  let worst=0;
  for(const p of points) {
    let best=Infinity;
    for(let i=1;i<line.length;i++) best=Math.min(best,project(p,line[i-1],line[i]).distance);
    worst=Math.max(worst,best);
  }
  return worst;
}

export function boundedDeviation(a:Pt[],b:Pt[],limit:number):number {
  // Spatial cells only need to contain segments in the acceptance corridor.
  const one=(src:Pt[],dst:Pt[])=>{
    const cell=Math.max(1,limit*2), grid=new Map<string,number[]>();
    for(let i=1;i<dst.length;i++) {
      const p=dst[i-1],q=dst[i];
      for(let y=Math.floor(Math.min(p[1],q[1])/cell);y<=Math.floor(Math.max(p[1],q[1])/cell);y++)
        for(let x=Math.floor(Math.min(p[0],q[0])/cell);x<=Math.floor(Math.max(p[0],q[0])/cell);x++) {
          const k=`${x},${y}`;(grid.get(k)??grid.set(k,[]).get(k)!).push(i);
        }
    }
    let worst=0;
    for(const p of src) {
      const gx=Math.floor(p[0]/cell),gy=Math.floor(p[1]/cell);let best=Infinity;
      for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++)for(const i of grid.get(`${gx+x},${gy+y}`)??[])
        best=Math.min(best,project(p,dst[i-1],dst[i]).distance);
      if(best>limit)return best;worst=Math.max(worst,best);
    }
    return worst;
  };
  const ab=one(a,b);return ab>limit?ab:Math.max(ab,one(b,a));
}

export function properCrossings(pts:Pt[]):number {
  const cross=(a:Pt,b:Pt)=>a[0]*b[1]-a[1]*b[0];let count=0;
  for(let i=1;i<pts.length;i++)for(let j=i+2;j<pts.length;j++) {
    const a=pts[i-1],b=pts[i],c=pts[j-1],d=pts[j];
    if(Math.max(a[0],b[0])<Math.min(c[0],d[0])||Math.max(c[0],d[0])<Math.min(a[0],b[0])||
      Math.max(a[1],b[1])<Math.min(c[1],d[1])||Math.max(c[1],d[1])<Math.min(a[1],b[1]))continue;
    const u=minus(b,a),v=minus(d,c),w=minus(c,a),den=cross(u,v);
    if(Math.abs(den)<1e-12)continue;
    const t=cross(w,v)/den,s=cross(w,u)/den;
    if(t>1e-7&&t<1-1e-7&&s>1e-7&&s<1-1e-7)count++;
  }
  return count;
}

/** Total variation of discrete turning angle, on equal arc-length samples. */
export function roughness(pts:Pt[], step=1):number {
  const p=resample(pts,step), angles:number[]=[];
  for(let i=1;i<p.length-1;i++) {
    const a=unit(minus(p[i],p[i-1])),b=unit(minus(p[i+1],p[i]));
    angles.push(Math.atan2(a[0]*b[1]-a[1]*b[0],dot(a,b)));
  }
  let v=0;for(let i=1;i<angles.length;i++)v+=Math.abs(angles[i]-angles[i-1]);return v;
}

export function pathPoints(d:string,step=1):Pt[][] { return parsePath(d).map(s=>sampleSubpath(s,step)); }

/** Spatial index for cross-path collision checks. Shared path endpoints are
 * contacts, not new crossings. Duplicates at sampling vertices count once. */
export function crossingIndex(line:Pt[],cell=8):(points:Pt[])=>number {
  const grid=new Map<string,number[]>(),cross=(a:Pt,b:Pt)=>a[0]*b[1]-a[1]*b[0];
  const cells=(a:Pt,b:Pt)=>{
    const keys:string[]=[];
    for(let y=Math.floor(Math.min(a[1],b[1])/cell);y<=Math.floor(Math.max(a[1],b[1])/cell);y++)
      for(let x=Math.floor(Math.min(a[0],b[0])/cell);x<=Math.floor(Math.max(a[0],b[0])/cell);x++)keys.push(`${x},${y}`);
    return keys;
  };
  for(let j=1;j<line.length;j++)for(const key of cells(line[j-1],line[j]))(grid.get(key)??grid.set(key,[]).get(key)!).push(j);
  return points=>{
    const hits=new Set<string>();
    for(let i=1;i<points.length;i++) {
      const a=points[i-1],b=points[i],u=minus(b,a),ids=new Set(cells(a,b).flatMap(k=>grid.get(k)??[]));
      for(const j of ids) {
        const c=line[j-1],v=minus(line[j],c),den=cross(u,v);if(Math.abs(den)<1e-10)continue;
        const w=minus(c,a),t=cross(w,v)/den,s=cross(w,u)/den;
        if(t<0||t>1||s<0||s>1)continue;
        if((i===1&&t<1e-7)||(i===points.length-1&&t>1-1e-7)||
          (j===1&&s<1e-7)||(j===line.length-1&&s>1-1e-7))continue;
        const q=mix(a,b,t);hits.add(`${q[0].toFixed(4)},${q[1].toFixed(4)}`);
      }
    }
    return hits.size;
  };
}
