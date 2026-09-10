import type { Pt } from "./pathdata.js";
import type { CubicSeg } from "./fitCurve.js";
import { arcLengths, distance } from "./curveGeometry.js";

function basis(u:number,knots:number[],count:number):number[] {
  if(u>=1){const b=Array(count).fill(0);b[count-1]=1;return b;}
  let b=Array(knots.length-1).fill(0).map((_,i)=>u>=knots[i]&&u<knots[i+1]?1:0);
  for(let degree=1;degree<=3;degree++) {
    const next=Array(knots.length-degree-1).fill(0);
    for(let i=0;i<next.length;i++) {
      const a=knots[i+degree]-knots[i],c=knots[i+degree+1]-knots[i+1];
      next[i]=(a?(u-knots[i])*b[i]/a:0)+(c?(knots[i+degree+1]-u)*b[i+1]/c:0);
    }
    b=next;
  }
  return b.slice(0,count);
}
function solve(A:number[][],b:number[]):number[]|null {
  const n=b.length,m=A.map((r,i)=>[...r,b[i]]);
  for(let k=0;k<n;k++) {
    let pivot=k;for(let i=k+1;i<n;i++)if(Math.abs(m[i][k])>Math.abs(m[pivot][k]))pivot=i;
    if(Math.abs(m[pivot][k])<1e-10)return null;
    [m[k],m[pivot]]=[m[pivot],m[k]];
    for(let i=k+1;i<n;i++) {
      const f=m[i][k]/m[k][k];
      for(let j=k;j<=n;j++)m[i][j]-=f*m[k][j];
    }
  }
  const x=Array(n).fill(0);
  for(let i=n-1;i>=0;i--){let v=m[i][n];for(let j=i+1;j<n;j++)v-=m[i][j]*x[j];x[i]=v/m[i][i];}
  return x.every(Number.isFinite)?x:null;
}
const evaluate=(u:number,k:number[],c:Pt[]):Pt=>{
  const b=basis(u,k,c.length);return c.reduce((p,q,i)=>[p[0]+b[i]*q[0],p[1]+b[i]*q[1]] as Pt,[0,0] as Pt);
};

/** Global cubic B-spline LS, pinned endpoints, adaptive knots and monotone
 * correspondence updates. C2 continuity is intrinsic at all simple knots.
 * Returns null rather than accepting an over-budget or degenerate fit. */
export function fitSmoothSpline(points:Pt[],tolerance:number,maxControls=20):CubicSeg[]|null {
  if(points.length<4)return null;
  const arc=arcLengths(points),length=arc.at(-1)!;if(length<1e-8)return null;
  let u=arc.map(a=>a/length),knots=[0,0,0,0,1,1,1,1];
  for(let count=4;count<=maxControls;count++) {
    let best:{controls:Pt[];u:number[];error:number;index:number}|null=null;
    for(let it=0;it<12;it++) {
      const n=count-2,A=Array.from({length:n},()=>Array(n).fill(0)),bx=Array(n).fill(0),by=Array(n).fill(0);
      const first=points[0],last=points.at(-1)!;
      for(let i=0;i<points.length;i++) {
        const b=basis(u[i],knots,count),rx=points[i][0]-b[0]*first[0]-b[count-1]*last[0],
          ry=points[i][1]-b[0]*first[1]-b[count-1]*last[1];
        for(let j=0;j<n;j++)if(b[j+1]) {
          bx[j]+=b[j+1]*rx;by[j]+=b[j+1]*ry;
          for(let k=0;k<n;k++)if(b[k+1])A[j][k]+=b[j+1]*b[k+1];
        }
      }
      // A small second-difference penalty discourages unnecessary oscillation.
      for(let j=0;j<count-2;j++) {
        const row=Array(n).fill(0);let fixedX=0,fixedY=0;
        for(let k=0;k<3;k++) {
          const idx=j+k,v=[1,-2,1][k];
          if(idx===0){fixedX+=v*first[0];fixedY+=v*first[1];}
          else if(idx===count-1){fixedX+=v*last[0];fixedY+=v*last[1];}
          else row[idx-1]=v;
        }
        const lambda=1e-5;
        for(let a=0;a<n;a++){bx[a]-=lambda*row[a]*fixedX;by[a]-=lambda*row[a]*fixedY;
          for(let b=0;b<n;b++)A[a][b]+=lambda*row[a]*row[b];}
      }
      const x=solve(A,bx),y=solve(A,by);if(!x||!y)break;
      const c:Pt[]=[first,...x.map((v,i)=>[v,y[i]] as Pt),last];
      let error=0,index=1;
      for(let i=1;i<points.length-1;i++){const d=distance(evaluate(u[i],knots,c),points[i]);if(d>error){error=d;index=i;}}
      if(!best||error<best.error)best={controls:c,u:[...u],error,index};
      if(error<=tolerance)break;
      const next=[...u];
      for(let i=1;i<points.length-1;i++) {
        const lo=Math.max(0,u[i]-1e-4),hi=Math.min(1,u[i]+1e-4),p=evaluate(u[i],knots,c),a=evaluate(lo,knots,c),b=evaluate(hi,knots,c);
        const dx=(b[0]-a[0])/(hi-lo),dy=(b[1]-a[1])/(hi-lo),den=dx*dx+dy*dy;
        if(den>1e-10)next[i]=Math.max(0,Math.min(1,u[i]-Math.max(-0.04,Math.min(0.04,((p[0]-points[i][0])*dx+(p[1]-points[i][1])*dy)/den))));
      }
      if(next.some((v,i)=>i>0&&v<=next[i-1]))break;
      u=next;
    }
    if(!best)return null;
    if(best.error<=tolerance) {
      const out:CubicSeg[]=[];const c=best.controls;
      for(let i=3;i<knots.length-4;i++) {
        const a=knots[i],b=knots[i+1];if(b-a<1e-8)continue;
        const p0=evaluate(a,knots,c),p3=evaluate(b,knots,c),v=evaluate(a+(b-a)/3,knots,c),w=evaluate(a+2*(b-a)/3,knots,c);
        const A:Pt=[27*v[0]-8*p0[0]-p3[0],27*v[1]-8*p0[1]-p3[1]],B:Pt=[27*w[0]-p0[0]-8*p3[0],27*w[1]-p0[1]-8*p3[1]];
        out.push({p0,p3,c1:[(2*A[0]-B[0])/18,(2*A[1]-B[1])/18],c2:[(2*B[0]-A[0])/18,(2*B[1]-A[1])/18]});
      }
      return out;
    }
    u=best.u;let knot=u[best.index];
    if(knots.some(k=>Math.abs(k-knot)<0.015)) {
      let widest=0;
      for(let i=3;i<knots.length-4;i++)if(knots[i+1]-knots[i]>widest){widest=knots[i+1]-knots[i];knot=(knots[i]+knots[i+1])/2;}
    }
    knots.push(knot);knots.sort((a,b)=>a-b);
  }
  return null;
}
