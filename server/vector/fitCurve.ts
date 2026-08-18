import type { Pt } from "./pathdata.js";

/**
 * 최소자승 큐빅 베지어 피팅 — Schneider, "An Algorithm for Automatically
 * Fitting Digitized Curves" (Graphics Gems, 1990).
 *
 * 기존 구현은 RDP로 점을 솎은 뒤 Catmull-Rom **보간**을 했다. 보간은 남은
 * 점들을 통과만 시키므로 어느 점을 남기느냐에 따라 곡선이 뻣뻣해지거나
 * 물결친다(실측: 가방 주름선이 직선처럼 굳음). 피팅은 원본 점 전체와의
 * 오차를 최소화하는 제어점을 풀기 때문에 훨씬 부드럽고 충실하다.
 *
 * 코너 처리: 진행 방향이 급하게 꺾이는 점에서 폴리라인을 먼저 자른 뒤
 * 구간별로 피팅한다 — 코너를 곡선으로 뭉개지 않기 위함이다.
 */

export interface CubicSeg {
  p0: Pt;
  c1: Pt;
  c2: Pt;
  p3: Pt;
}

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const scale = (a: Pt, s: number): Pt => [a[0] * s, a[1] * s];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const norm = (a: Pt) => Math.hypot(a[0], a[1]);
const normalize = (a: Pt): Pt => {
  const n = norm(a) || 1;
  return [a[0] / n, a[1] / n];
};

/** 폴리라인을 코너에서 잘라 구간별로 피팅한다. */
export function fitPolyline(
  pts: Pt[],
  maxError = 1.5,
  cornerAngleDeg = 55,
): CubicSeg[] {
  if (pts.length < 2) return [];
  if (pts.length === 2) return [lineSeg(pts[0], pts[1])];

  // 코너 검출 — 앞뒤 방향 벡터 사이 각
  const cornerCos = Math.cos(((180 - cornerAngleDeg) * Math.PI) / 180);
  const cuts = [0];
  const LOOK = 2; // 픽셀 노이즈에 강하도록 2칸 떨어진 방향으로 판단
  for (let i = LOOK; i < pts.length - LOOK; i++) {
    const din = normalize(sub(pts[i], pts[i - LOOK]));
    const dout = normalize(sub(pts[i + LOOK], pts[i]));
    if (dot(din, dout) < cornerCos) {
      if (i - cuts[cuts.length - 1] >= 2) cuts.push(i);
    }
  }
  cuts.push(pts.length - 1);

  const out: CubicSeg[] = [];
  for (let c = 0; c + 1 < cuts.length; c++) {
    const seg = pts.slice(cuts[c], cuts[c + 1] + 1);
    if (seg.length < 2) continue;
    const tanL = computeTangent(seg, true);
    const tanR = computeTangent(seg, false);
    fitCubicRec(seg, tanL, tanR, maxError, out, 0);
  }
  return out;
}

function lineSeg(a: Pt, b: Pt): CubicSeg {
  return {
    p0: a,
    c1: add(a, scale(sub(b, a), 1 / 3)),
    c2: add(a, scale(sub(b, a), 2 / 3)),
    p3: b,
  };
}

function computeTangent(pts: Pt[], left: boolean): Pt {
  const k = Math.min(3, pts.length - 1);
  return left
    ? normalize(sub(pts[k], pts[0]))
    : normalize(sub(pts[pts.length - 1 - k], pts[pts.length - 1]));
}

function chordLengthParams(pts: Pt[]): number[] {
  const u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + norm(sub(pts[i], pts[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

const B0 = (u: number) => (1 - u) ** 3;
const B1 = (u: number) => 3 * u * (1 - u) ** 2;
const B2 = (u: number) => 3 * u * u * (1 - u);
const B3 = (u: number) => u ** 3;

function bezierPoint(s: CubicSeg, u: number): Pt {
  return [
    B0(u) * s.p0[0] + B1(u) * s.c1[0] + B2(u) * s.c2[0] + B3(u) * s.p3[0],
    B0(u) * s.p0[1] + B1(u) * s.c1[1] + B2(u) * s.c2[1] + B3(u) * s.p3[1],
  ];
}

/** 최소자승으로 c1·c2 길이(α)를 푼다 */
function generateBezier(pts: Pt[], u: number[], tanL: Pt, tanR: Pt): CubicSeg {
  const first = pts[0], last = pts[pts.length - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;

  for (let i = 0; i < pts.length; i++) {
    const A0 = scale(tanL, B1(u[i]));
    const A1 = scale(tanR, B2(u[i]));
    c00 += dot(A0, A0);
    c01 += dot(A0, A1);
    c11 += dot(A1, A1);
    const tmp = sub(pts[i], [
      B0(u[i]) * first[0] + B1(u[i]) * first[0] + B2(u[i]) * last[0] + B3(u[i]) * last[0],
      B0(u[i]) * first[1] + B1(u[i]) * first[1] + B2(u[i]) * last[1] + B3(u[i]) * last[1],
    ]);
    x0 += dot(A0, tmp);
    x1 += dot(A1, tmp);
  }

  const det = c00 * c11 - c01 * c01;
  let aL = det ? (x0 * c11 - x1 * c01) / det : 0;
  let aR = det ? (c00 * x1 - c01 * x0) / det : 0;

  const segLen = norm(sub(last, first));
  const eps = 1e-6 * segLen;
  if (aL < eps || aR < eps) {
    // 퇴화 시 Wu/Barsky 휴리스틱
    aL = aR = segLen / 3;
  }
  return {
    p0: first,
    c1: add(first, scale(tanL, aL)),
    c2: add(last, scale(tanR, aR)),
    p3: last,
  };
}

function maxErrorOf(pts: Pt[], seg: CubicSeg, u: number[]): { err: number; idx: number } {
  let err = 0, idx = (pts.length / 2) | 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = bezierPoint(seg, u[i]);
    const d = norm(sub(p, pts[i]));
    if (d > err) { err = d; idx = i; }
  }
  return { err, idx };
}

/** 뉴턴-랩슨으로 파라미터 재배치 (피팅 품질 향상) */
function reparameterize(pts: Pt[], u: number[], s: CubicSeg): number[] {
  return u.map((ui, i) => {
    const d: Pt = sub(bezierPoint(s, ui), pts[i]);
    const d1: Pt = [
      3 * (1 - ui) ** 2 * (s.c1[0] - s.p0[0]) + 6 * (1 - ui) * ui * (s.c2[0] - s.c1[0]) + 3 * ui * ui * (s.p3[0] - s.c2[0]),
      3 * (1 - ui) ** 2 * (s.c1[1] - s.p0[1]) + 6 * (1 - ui) * ui * (s.c2[1] - s.c1[1]) + 3 * ui * ui * (s.p3[1] - s.c2[1]),
    ];
    const num = dot(d, d1);
    const den = dot(d1, d1);
    const next = den ? ui - num / den : ui;
    return Math.max(0, Math.min(1, next));
  });
}

function fitCubicRec(
  pts: Pt[],
  tanL: Pt,
  tanR: Pt,
  maxError: number,
  out: CubicSeg[],
  depth: number,
): void {
  if (pts.length === 2) {
    out.push(lineSeg(pts[0], pts[1]));
    return;
  }
  let u = chordLengthParams(pts);
  let seg = generateBezier(pts, u, tanL, tanR);
  let { err, idx } = maxErrorOf(pts, seg, u);

  if (err > maxError && err < maxError * 4) {
    // 재파라미터화 2회로 개선 시도
    for (let it = 0; it < 2; it++) {
      u = reparameterize(pts, u, seg);
      seg = generateBezier(pts, u, tanL, tanR);
      ({ err, idx } = maxErrorOf(pts, seg, u));
      if (err <= maxError) break;
    }
  }
  if (err <= maxError || depth > 12 || pts.length < 5) {
    out.push(seg);
    return;
  }
  // 최악 지점에서 분할, 접선은 이웃 점으로
  const centerTan = normalize(sub(pts[Math.max(0, idx - 1)], pts[Math.min(pts.length - 1, idx + 1)]));
  fitCubicRec(pts.slice(0, idx + 1), tanL, centerTan, maxError, out, depth + 1);
  fitCubicRec(pts.slice(idx), scale(centerTan, -1), tanR, maxError, out, depth + 1);
}

/**
 * 오차 예산 기반 적응 피팅 — AmodalSVG(2026)의 ALV 사상.
 *
 * 고정 허용오차는 두 방향으로 실패한다: 너무 크면 형상이 뭉개지고(실측:
 * 2.0px에서 선F1 93→88%), 너무 작으면 골격의 픽셀 진동까지 따라가 앵커가
 * 폭주한다. 여기서는 체인마다 "재구성 오차 예산"을 정하고, 피팅 후 실제
 * 최대 오차·앵커 수를 보고 허용오차를 재조정한다.
 *
 *  - 긴 구조선(윤곽·주요 절개선): 오차 예산 엄격 (형상 보존 우선)
 *  - 짧은 디테일(스티치·장식): 앵커 예산 엄격 (과밀 방지)
 *
 * 반환값은 최종 채택된 세그먼트와 사용된 허용오차.
 */
export function fitAdaptive(
  pts: Pt[],
  opts: { baseError?: number; cornerAngleDeg?: number; maxAnchorsPerPx?: number } = {},
): { segs: CubicSeg[]; usedError: number } {
  const base = opts.baseError ?? 1.2;
  const corner = opts.cornerAngleDeg ?? 55;
  const maxDensity = opts.maxAnchorsPerPx ?? 0.08; // 앵커/px — 이보다 촘촘하면 과밀

  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (len < 1) return { segs: fitPolyline(pts, base, corner), usedError: base };

  let err = base;
  let segs = fitPolyline(pts, err, corner);
  // 1) 앵커 과밀이면 허용오차를 키워 다시 (최대 2배까지, 형상 손실 방지)
  for (let it = 0; it < 3 && segs.length / len > maxDensity && err < base * 2; it++) {
    err *= 1.25;
    segs = fitPolyline(pts, err, corner);
  }
  // 2) 긴 구조선인데 실제 재구성 오차가 예산을 넘으면 허용오차를 줄여 다시
  if (len > 80) {
    const worst = maxDeviation(pts, segs);
    if (worst > base * 1.6 && err > base * 0.6) {
      err = Math.max(base * 0.6, err * 0.75);
      segs = fitPolyline(pts, err, corner);
    }
  }
  return { segs, usedError: err };
}

/** 원본 점들이 피팅 곡선에서 얼마나 벗어나는지 (최대값) */
function maxDeviation(pts: Pt[], segs: CubicSeg[]): number {
  if (!segs.length) return Infinity;
  // 각 세그먼트를 촘촘히 샘플링해 최근접 거리로 근사
  const samples: Pt[] = [];
  for (const s of segs) {
    for (let t = 0; t <= 1; t += 0.05) samples.push(bezierPoint(s, t));
  }
  let worst = 0;
  const step = Math.max(1, Math.floor(pts.length / 60));
  for (let i = 0; i < pts.length; i += step) {
    let best = Infinity;
    for (const q of samples) {
      const d = Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]);
      if (d < best) best = d;
    }
    if (best > worst) worst = best;
  }
  return worst;
}

/** CubicSeg 배열 → SVG path d (열린/닫힌) */
export function segsToPathD(segs: CubicSeg[], closed: boolean): string {
  if (!segs.length) return "";
  const f = (n: number) => {
    const r = Math.round(n * 100) / 100;
    return Object.is(r, -0) ? "0" : String(r);
  };
  let d = `M${f(segs[0].p0[0])} ${f(segs[0].p0[1])}`;
  for (const s of segs) {
    d += `C${f(s.c1[0])} ${f(s.c1[1])} ${f(s.c2[0])} ${f(s.c2[1])} ${f(s.p3[0])} ${f(s.p3[1])}`;
  }
  if (closed) d += "Z";
  return d;
}
