/**
 * **연속성 감사** — 선이 이어져 보이는가를 패스 수준에서 센다.
 *
 * 외부 리뷰 v0.6 §3 의 지적: 선 F@2 와 앵커 수로는 연속성을 못 잰다. 짧은 틈 몇 개가
 * 전체 픽셀에서 차지하는 비중은 작고, 같은 자리에서 끝나는 별도 패스는 픽셀로 완전히
 * 같아도 편집기에서 잡으면 두 개다. 그래서 따로 센다.
 *
 * 다만 **모든 자유끝이 결함은 아니다.** 집게·파베·스티치처럼 짧은 부속은 끝이 떠 있는 것이
 * 정상이다(실측 링: 자유끝의 대부분이 그 영역). 사용자가 "끊겼다"고 보는 것은 **긴 경계**가
 * 중간에서 멈춘 자리이므로 그 수를 따로 낸다.
 *
 * 아직 게이트를 가르지 않는다 — 무엇이 "필수 곡선"인지에 대한 정답이 없기 때문이다.
 * 지금은 재서 보고하고, 판단은 사람이 한다.
 */
import { parsePath, type Pt } from "../vector/pathdata.js";

/** 이 반경 안에 다른 획이 없으면 자유끝 (px) */
const R = Number(process.env.V4_CONT_R ?? 1.5);
/** 이 길이 이상인 획의 끝만 "구조 경계"로 센다 (px) */
const LONG = Number(process.env.V4_CONT_LONG ?? 40);

export interface ContinuityReport {
  /** 열린 획의 끝점 총수 */
  ends: number;
  /** 다른 획이 반경 안에 없는 끝 */
  free: number;
  /** 긴 획(LONG px 이상)의 끝점 수 */
  longEnds: number;
  /** 긴 획의 자유끝 — 눈에 보이는 끊긴 경계 */
  freeLong: number;
  /** 그중 채움 도형에 닿아 끝난 것 (선이 면으로 넘어간 자리) */
  freeLongAtFill: number;
  /** 두 획의 끝이 만나는데 서로 다른 패스인 자리 — 픽셀로는 이어져 보인다 */
  splitJoins: number;
}

interface S { pts: Pt[]; ends: Pt[]; len: number }

function sampleSubs(d: string): S[] {
  const out: S[] = [];
  for (const sub of parsePath(d)) {
    const pts: Pt[] = [sub.start];
    let cur = sub.start;
    for (const s of sub.segs) {
      if (s.type === "L") {
        const n = Math.max(1, Math.ceil(Math.hypot(s.end[0] - cur[0], s.end[1] - cur[1]) / 2));
        for (let i = 1; i <= n; i++) pts.push([cur[0] + (s.end[0] - cur[0]) * i / n, cur[1] + (s.end[1] - cur[1]) * i / n]);
      } else {
        const rough = Math.hypot(s.end[0] - cur[0], s.end[1] - cur[1]) + Math.hypot(s.c1![0] - cur[0], s.c1![1] - cur[1]);
        const n = Math.max(2, Math.min(64, Math.ceil(rough / 2)));
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          pts.push([
            u * u * u * cur[0] + 3 * u * u * t * s.c1![0] + 3 * u * t * t * s.c2![0] + t * t * t * s.end[0],
            u * u * u * cur[1] + 3 * u * u * t * s.c1![1] + 3 * u * t * t * s.c2![1] + t * t * t * s.end[1],
          ]);
        }
      }
      cur = s.end;
    }
    const closed = sub.closed || Math.hypot(pts[0][0] - cur[0], pts[0][1] - cur[1]) < 0.5;
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    out.push({ pts, ends: closed ? [] : [pts[0], pts[pts.length - 1]], len });
  }
  return out;
}

export function auditContinuity(
  prims: { cls: string; d?: string }[],
): ContinuityReport {
  const strokes: S[] = [];
  const fill: Pt[] = [];
  for (const p of prims) {
    if (typeof p.d !== "string" || !p.d) continue;
    if (p.cls === "STRUCTURAL_STROKE" || p.cls === "DASH_OR_STITCH") strokes.push(...sampleSubs(p.d));
    else for (const f of sampleSubs(p.d)) fill.push(...f.pts);
  }
  const CELL = Math.max(2, R * 2);
  const grid = new Map<string, { si: number; pi: number }[]>();
  strokes.forEach((s, si) => s.pts.forEach((p, pi) => {
    const k = `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push({ si, pi });
  }));
  const FCELL = 8;
  const fgrid = new Map<string, Pt[]>();
  for (const q of fill) {
    const k = `${Math.floor(q[0] / FCELL)},${Math.floor(q[1] / FCELL)}`;
    (fgrid.get(k) ?? fgrid.set(k, []).get(k)!).push(q);
  }
  const nearFill = (p: Pt, r: number): boolean => {
    const gx = Math.floor(p[0] / FCELL), gy = Math.floor(p[1] / FCELL), reach = Math.ceil(r / FCELL);
    for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++) {
      for (const q of fgrid.get(`${gx + i},${gy + j}`) ?? []) if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= r) return true;
    }
    return false;
  };

  const rep: ContinuityReport = { ends: 0, free: 0, longEnds: 0, freeLong: 0, freeLongAtFill: 0, splitJoins: 0 };
  strokes.forEach((s, si) => {
    for (const e of s.ends) {
      rep.ends++;
      const isLong = s.len >= LONG;
      if (isLong) rep.longEnds++;
      const gx = Math.floor(e[0] / CELL), gy = Math.floor(e[1] / CELL);
      let touched = false, meetsEnd = false;
      for (let i = -1; i <= 1 && !meetsEnd; i++) for (let j = -1; j <= 1 && !meetsEnd; j++) {
        for (const h of grid.get(`${gx + i},${gy + j}`) ?? []) {
          if (h.si === si) continue;
          const q = strokes[h.si].pts[h.pi];
          if (Math.hypot(q[0] - e[0], q[1] - e[1]) > R) continue;
          touched = true;
          if (strokes[h.si].ends.some((oe) => Math.hypot(oe[0] - e[0], oe[1] - e[1]) <= R)) { meetsEnd = true; break; }
        }
      }
      if (!touched) {
        rep.free++;
        if (isLong) { rep.freeLong++; if (nearFill(e, 6)) rep.freeLongAtFill++; }
      } else if (meetsEnd) rep.splitJoins++;
    }
  });
  return rep;
}
