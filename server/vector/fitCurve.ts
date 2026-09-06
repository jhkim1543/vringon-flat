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

export interface FitOpts {
  /** 재구성 허용오차(px) */
  maxError?: number;
  /** 진행 방향이 이보다 크게 꺾이면 코너로 자른다(도). **꺾인 각** 기준이다. */
  cornerTurnDeg?: number;
  /** 코너 컷 사이 최소 거리(px) — 둥근 모서리를 여러 번 찍지 않게 */
  minCornerGapPx?: number;
  /** 이보다 짧은 구간은 더 쪼개지 않는다(px) — 잔조각 폭주 방지 */
  minSpanPx?: number;
}

/** 누적 호 길이 */
function arcAcc(pts: Pt[]): Float64Array {
  const acc = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    acc[i] = acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return acc;
}

/**
 * 코너 위치를 고른다. 셋을 지킨다.
 *
 *  - **거리 기준 창** — 방향을 샘플 *개수*로 재면 점이 촘촘한 곳에서 픽셀 잡음이 코너로 보인다.
 *    항상 같은 물리 거리(px)만큼 앞뒤를 본다.
 *  - **비최대 억제** — 둥근 모서리는 여러 점이 한꺼번에 임계를 넘는다. 그 덩어리에서 가장
 *    많이 꺾인 점 **하나만** 남긴다. 안 그러면 모서리 하나에 앵커가 대여섯 개 박힌다.
 *  - **최소 간격** — 채택된 컷끼리 px 거리로 떨어뜨리고, 양 끝에 붙은 컷은 버린다.
 */
function cornerCuts(pts: Pt[], turnDeg: number, lookPx: number, gapPx: number): number[] {
  const n = pts.length;
  const acc = arcAcc(pts);
  const turn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let a = i;
    while (a > 0 && acc[i] - acc[a] < lookPx) a--;
    let b = i;
    while (b < n - 1 && acc[b] - acc[i] < lookPx) b++;
    if (a === i || b === i) continue;
    const c = dot(normalize(sub(pts[i], pts[a])), normalize(sub(pts[b], pts[i])));
    turn[i] = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  }

  const cuts = [0];
  let i = 1;
  while (i < n - 1) {
    if (turn[i] <= turnDeg) { i++; continue; }
    // 임계를 넘은 지점부터 gapPx 안쪽을 한 덩어리로 보고 가장 날카로운 점만 취한다
    let j = i, best = i;
    while (j + 1 < n - 1 && acc[j + 1] - acc[i] <= gapPx) {
      j++;
      if (turn[j] > turn[best]) best = j;
    }
    if (acc[best] - acc[cuts[cuts.length - 1]] >= gapPx && acc[n - 1] - acc[best] >= gapPx) {
      cuts.push(best);
    }
    i = j + 1;
  }
  cuts.push(n - 1);
  return cuts;
}

/** 폴리라인을 코너에서 잘라 구간별로 피팅한다. */
export function fitPolyline(pts: Pt[], opts: FitOpts = {}): CubicSeg[] {
  const maxError = opts.maxError ?? 1.5;
  const turnDeg = opts.cornerTurnDeg ?? 60;
  const gapPx = opts.minCornerGapPx ?? Math.max(2, maxError * 1.5);
  const minSpan = opts.minSpanPx ?? maxError * 2.5;

  if (pts.length < 2) return [];
  if (pts.length === 2) return [lineSeg(pts[0], pts[1])];

  const cuts = cornerCuts(pts, turnDeg, Math.max(2, maxError), gapPx);

  const out: CubicSeg[] = [];
  for (let c = 0; c + 1 < cuts.length; c++) {
    const seg = pts.slice(cuts[c], cuts[c + 1] + 1);
    if (seg.length < 2) continue;
    const tanL = computeTangent(seg, true);
    const tanR = computeTangent(seg, false);
    fitCubicRec(seg, tanL, tanR, maxError, out, 0, minSpan);
  }
  return out;
}

/**
 * 점들에 **큐빅 하나만** 맞춘다 — 쪼개지 않는다.
 *
 * 앵커를 하나 빼도 되는지 판단하려면 "양옆 두 조각을 하나로 합쳤을 때 얼마나 어긋나나"를
 * 알아야 한다. `fitPolyline` 은 오차가 크면 스스로 쪼개 버려서 그 답을 주지 못한다.
 */
export function fitSingleCubic(pts: Pt[]): CubicSeg | null {
  if (pts.length < 2) return null;
  if (pts.length === 2) return lineSeg(pts[0], pts[1]);
  const tanL = computeTangent(pts, true);
  const tanR = computeTangent(pts, false);
  let u = chordLengthParams(pts);
  let seg = generateBezier(pts, u, tanL, tanR);
  for (let it = 0; it < 2; it++) {
    u = reparameterize(pts, u, seg);
    seg = generateBezier(pts, u, tanL, tanR);
  }
  return seg;
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
  // **상한도 잘라야 한다.** 최소자승은 접선 방향이 조금만 틀려도 α 를 현의 수십 배로
  // 풀 수 있다 — 그 곡선은 부풀거나 고리를 만든다. 실측: 상한 없이 .ai 5종에서 제어
  // 핸들이 현보다 20px 이상 뻗은 세그먼트가 1,250개(6.1%)였다. 이탈 검사는 샘플 지점의
  // 최근접 거리만 보므로 앵커 근처로 되돌아오는 고리를 못 잡는다 — 생성 지점에서 막는다.
  const aMax = Math.max(segLen, 1) * 1.2;
  if (aL > aMax || aR > aMax) {
    aL = Math.min(aL, aMax);
    aR = Math.min(aR, aMax);
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
  minSpan: number,
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
  // **짧은 구간은 더 쪼개지 않는다.** 코너를 제대로 잘라내고 나면 남는 고오차 지점은
  // 대개 픽셀 잡음이다. 그걸 재귀로 따라가면 몇 px 안에 앵커가 대여섯 개 박힌다 —
  // 형상은 그만큼 좋아지지 않는데 편집만 불가능해진다.
  const span = arcAcc(pts)[pts.length - 1];
  if (err <= maxError || depth > 12 || pts.length < 5 || span < minSpan) {
    out.push(seg);
    return;
  }
  // 최악 지점에서 분할, 접선은 이웃 점으로
  const centerTan = normalize(sub(pts[Math.max(0, idx - 1)], pts[Math.min(pts.length - 1, idx + 1)]));
  fitCubicRec(pts.slice(0, idx + 1), tanL, centerTan, maxError, out, depth + 1, minSpan);
  fitCubicRec(pts.slice(idx), scale(centerTan, -1), tanR, maxError, out, depth + 1, minSpan);
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
  opts: {
    baseError?: number;
    /** @deprecated **내각** 기준(180 − 꺾인각). V2/V3 호출부 호환용. */
    cornerAngleDeg?: number;
    /** **꺾인각** 기준(도). 이쪽을 쓴다. */
    cornerTurnDeg?: number;
    minCornerGapPx?: number;
    minSpanPx?: number;
    maxAnchorsPerPx?: number;
  } = {},
): { segs: CubicSeg[]; usedError: number } {
  const base = opts.baseError ?? 1.2;
  // 예전 호출부는 내각으로 넘긴다 — 꺾인각으로 옮겨 준다
  const turnDeg =
    opts.cornerTurnDeg ?? (opts.cornerAngleDeg != null ? 180 - opts.cornerAngleDeg : 60);
  const maxDensity = opts.maxAnchorsPerPx ?? 0.08; // 앵커/px — 이보다 촘촘하면 과밀
  const fit = (e: number) =>
    fitPolyline(pts, {
      maxError: e,
      cornerTurnDeg: turnDeg,
      minCornerGapPx: opts.minCornerGapPx,
      minSpanPx: opts.minSpanPx,
    });

  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (len < 1) return { segs: fit(base), usedError: base };

  let err = base;
  let segs = fit(err);
  // 1) 앵커 과밀이면 허용오차를 키워 다시 (최대 2배까지, 형상 손실 방지)
  for (let it = 0; it < 3 && segs.length / len > maxDensity && err < base * 2; it++) {
    err *= 1.25;
    segs = fit(err);
  }
  // 2) 긴 구조선인데 실제 재구성 오차가 예산을 넘으면 허용오차를 줄여 다시
  if (len > 80) {
    const worst = maxDeviation(pts, segs);
    if (worst > base * 1.6 && err > base * 0.6) {
      err = Math.max(base * 0.6, err * 0.75);
      segs = fit(err);
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
