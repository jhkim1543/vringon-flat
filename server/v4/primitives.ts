/**
 * 기하 프리미티브 적합 — 원·타원·직선·둥근사각.
 *
 * 제품 도면에는 자유형 곡선보다 **정확한 원형**이 많다. 링, 버클 구멍, 에어홀, 리벳, 아일릿.
 * 그것을 베지어 수십 개로 근사하면 앵커가 낭비될 뿐 아니라 편집이 어렵다 — 반지름을 바꾸려면
 * 모든 앵커를 손대야 한다. 파라미터로 표현하면 값 하나다.
 *
 * **중요: 카테고리로 판단하지 않는다.** "링이니까 원"이 아니라, 실제로 적합해 보고 잔차가
 * 자유형 대비 충분히 낮을 때만 승격한다. 잔차 임계는 캔버스 크기에 비례시킨다.
 */
import type { Pt } from "./types.js";

export interface FitResult {
  kind: "circle" | "ellipse" | "line" | "roundedRect";
  params: Record<string, number>;
  /** 기하 잔차 — 점에서 도형까지의 실제 거리 */
  rms: number;
  max: number;
  /** 렌더용 패스 */
  d: string;
  /** 이 도형을 표현하는 데 필요한 앵커 수 */
  anchors: number;
}

const TAU = Math.PI * 2;

// ── 작은 대칭행렬 고유분해 (Jacobi) ─────────────────────────
function jacobiEigen(a: number[][], iters = 60): { values: number[]; vectors: number[][] } {
  const n = a.length;
  const m = a.map((r) => r.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < iters; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += m[i][j] * m[i][j];
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(m[p][q]) < 1e-15) continue;
        const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const mkp = m[k][p], mkq = m[k][q];
          m[k][p] = c * mkp - s * mkq;
          m[k][q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < n; k++) {
          const mpk = m[p][k], mqk = m[q][k];
          m[p][k] = c * mpk - s * mqk;
          m[q][k] = s * mpk + c * mqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: m.map((r, i) => r[i]), vectors: v };
}

// ── 원 ──────────────────────────────────────────────────────
/** Kåsa 대수 적합 후 기하 잔차 측정 */
export function fitCircle(pts: Pt[]): FitResult | null {
  const n = pts.length;
  if (n < 8) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (const p of pts) {
    const z = p.x * p.x + p.y * p.y;
    sx += p.x; sy += p.y; sz += z;
    sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y;
    sxz += p.x * z; syz += p.y * z;
  }
  const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const b = [sxz, syz, sz];
  const sol = solve3(A, b);
  if (!sol) return null;
  const cx = sol[0] / 2, cy = sol[1] / 2;
  const r = Math.sqrt(Math.max(0, sol[2] + cx * cx + cy * cy));
  if (!Number.isFinite(r) || r < 2) return null;

  let sum = 0, max = 0;
  for (const p of pts) {
    const e = Math.abs(Math.hypot(p.x - cx, p.y - cy) - r);
    sum += e * e;
    if (e > max) max = e;
  }
  return {
    kind: "circle",
    params: { cx: +cx.toFixed(2), cy: +cy.toFixed(2), r: +r.toFixed(2) },
    rms: +Math.sqrt(sum / n).toFixed(3),
    max: +max.toFixed(2),
    d: circlePath(cx, cy, r),
    anchors: 4,
  };
}

function solve3(A: number[][], b: number[]): number[] | null {
  const m = [[...A[0], b[0]], [...A[1], b[1]], [...A[2], b[2]]];
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(m[r][i]) > Math.abs(m[piv][i])) piv = r;
    if (Math.abs(m[piv][i]) < 1e-9) return null;
    [m[i], m[piv]] = [m[piv], m[i]];
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = m[r][i] / m[i][i];
      for (let c = i; c < 4; c++) m[r][c] -= f * m[i][c];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/** 원을 4개의 큐빅으로 — 앵커 4개 */
function circlePath(cx: number, cy: number, r: number): string {
  const k = 0.5522847498 * r;
  const f = (v: number) => Math.round(v * 100) / 100;
  return `M ${f(cx - r)} ${f(cy)}` +
    ` C ${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)}` +
    ` C ${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)}` +
    ` C ${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)}` +
    ` C ${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} Z`;
}

// ── 타원 ────────────────────────────────────────────────────
/**
 * 일반 conic 최소자승 적합 후 타원 판별.
 * 좌표를 중심화·정규화해 수치 안정성을 확보한다 — 안 하면 x² 항이 커서 행렬이 병든다.
 */
export function fitEllipse(pts: Pt[]): FitResult | null {
  const n = pts.length;
  if (n < 12) return null;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let s = 0;
  for (const p of pts) s = Math.max(s, Math.hypot(p.x - mx, p.y - my));
  if (s < 2) return null;

  // S = DᵀD, D 행 = [x², xy, y², x, y, 1]
  const S = Array.from({ length: 6 }, () => new Array(6).fill(0));
  for (const p of pts) {
    const x = (p.x - mx) / s, y = (p.y - my) / s;
    const row = [x * x, x * y, y * y, x, y, 1];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) S[i][j] += row[i] * row[j];
  }
  const { values, vectors } = jacobiEigen(S);
  let best = 0;
  for (let i = 1; i < 6; i++) if (values[i] < values[best]) best = i;
  const c = vectors.map((r) => r[best]);
  const [A, B, C, D, E, F] = c;
  const disc = B * B - 4 * A * C;
  if (disc >= -1e-12) return null; // 타원이 아니다

  // 중심
  const cx0 = (2 * C * D - B * E) / disc;
  const cy0 = (2 * A * E - B * D) / disc;
  // 축
  const num = 2 * (A * E * E + C * D * D + F * B * B - B * D * E - 4 * A * C * F);
  const rt = Math.sqrt((A - C) * (A - C) + B * B);
  const a2 = num / (disc * ((C - A) - rt));
  const b2 = num / (disc * ((C - A) + rt));
  if (!(a2 > 0) || !(b2 > 0)) return null;
  let ra = Math.sqrt(a2) * s, rb = Math.sqrt(b2) * s;
  let phi = 0.5 * Math.atan2(B, A - C);
  if (rb > ra) { [ra, rb] = [rb, ra]; phi += Math.PI / 2; }
  const cx = cx0 * s + mx, cy = cy0 * s + my;
  if (!Number.isFinite(ra) || !Number.isFinite(rb) || rb < 1.5) return null;

  // 기하 잔차 — 타원 위 가장 가까운 점까지 (매개변수 탐색으로 근사)
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  let sum = 0, max = 0;
  for (const p of pts) {
    const dx = p.x - cx, dy = p.y - cy;
    const u = dx * cosP + dy * sinP, v = -dx * sinP + dy * cosP;
    // 초기 각도에서 몇 번 뉴턴 반복
    let t = Math.atan2(v / rb, u / ra);
    for (let k = 0; k < 4; k++) {
      const ex = ra * Math.cos(t), ey = rb * Math.sin(t);
      const gx = -ra * Math.sin(t), gy = rb * Math.cos(t);
      const num2 = (u - ex) * gx + (v - ey) * gy;
      const den = gx * gx + gy * gy + (u - ex) * (-ra * Math.cos(t)) + (v - ey) * (-rb * Math.sin(t));
      if (Math.abs(den) < 1e-9) break;
      t -= num2 / den;
    }
    const e = Math.hypot(u - ra * Math.cos(t), v - rb * Math.sin(t));
    sum += e * e;
    if (e > max) max = e;
  }

  return {
    kind: "ellipse",
    params: {
      cx: +cx.toFixed(2), cy: +cy.toFixed(2),
      rx: +ra.toFixed(2), ry: +rb.toFixed(2),
      rotate: +((phi * 180) / Math.PI).toFixed(2),
    },
    rms: +Math.sqrt(sum / n).toFixed(3),
    max: +max.toFixed(2),
    d: ellipsePath(cx, cy, ra, rb, phi),
    anchors: 4,
  };
}

function ellipsePath(cx: number, cy: number, ra: number, rb: number, phi: number): string {
  const k = 0.5522847498;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const P = (u: number, v: number) => {
    const x = cx + u * cos - v * sin, y = cy + u * sin + v * cos;
    return `${Math.round(x * 100) / 100} ${Math.round(y * 100) / 100}`;
  };
  return `M ${P(-ra, 0)}` +
    ` C ${P(-ra, -k * rb)} ${P(-k * ra, -rb)} ${P(0, -rb)}` +
    ` C ${P(k * ra, -rb)} ${P(ra, -k * rb)} ${P(ra, 0)}` +
    ` C ${P(ra, k * rb)} ${P(k * ra, rb)} ${P(0, rb)}` +
    ` C ${P(-k * ra, rb)} ${P(-ra, k * rb)} ${P(-ra, 0)} Z`;
}

// ── 직선 ────────────────────────────────────────────────────
/** PCA 주축에 대한 잔차. 열린 성분(끝점 2개)에만 의미가 있다. */
export function fitLine(pts: Pt[]): FitResult | null {
  const n = pts.length;
  if (n < 4) return null;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const { values, vectors } = jacobiEigen([[sxx, sxy], [sxy, syy]]);
  const major = values[0] >= values[1] ? 0 : 1;
  const ux = vectors[0][major], uy = vectors[1][major];
  let tMin = Infinity, tMax = -Infinity, sum = 0, max = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my;
    const t = dx * ux + dy * uy;
    const e = Math.abs(-dx * uy + dy * ux);
    tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
    sum += e * e;
    if (e > max) max = e;
  }
  const f = (v: number) => Math.round(v * 100) / 100;
  const x1 = mx + ux * tMin, y1 = my + uy * tMin;
  const x2 = mx + ux * tMax, y2 = my + uy * tMax;
  return {
    kind: "line",
    params: { x1: +x1.toFixed(2), y1: +y1.toFixed(2), x2: +x2.toFixed(2), y2: +y2.toFixed(2) },
    rms: +Math.sqrt(sum / n).toFixed(3),
    max: +max.toFixed(2),
    d: `M ${f(x1)} ${f(y1)} L ${f(x2)} ${f(y2)}`,
    anchors: 2,
  };
}

// ── 둥근 사각형 (축 정렬) ───────────────────────────────────
export function fitRoundedRect(pts: Pt[]): FitResult | null {
  const n = pts.length;
  if (n < 12) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return null;

  // 반지름 후보를 몇 개 시험해 잔차가 가장 낮은 것을 고른다
  let bestR = 0, bestRms = Infinity, bestMax = 0;
  const rMax = Math.min(w, h) / 2;
  for (let k = 0; k <= 8; k++) {
    const r = (rMax * k) / 8;
    let sum = 0, mx = 0;
    for (const p of pts) {
      const e = distToRoundRect(p, x0, y0, x1, y1, r);
      sum += e * e;
      if (e > mx) mx = e;
    }
    const rms = Math.sqrt(sum / n);
    if (rms < bestRms) { bestRms = rms; bestR = r; bestMax = mx; }
  }
  const f = (v: number) => Math.round(v * 100) / 100;
  const r = bestR;
  const d = r < 0.5
    ? `M ${f(x0)} ${f(y0)} L ${f(x1)} ${f(y0)} L ${f(x1)} ${f(y1)} L ${f(x0)} ${f(y1)} Z`
    : `M ${f(x0 + r)} ${f(y0)} L ${f(x1 - r)} ${f(y0)} Q ${f(x1)} ${f(y0)} ${f(x1)} ${f(y0 + r)}` +
      ` L ${f(x1)} ${f(y1 - r)} Q ${f(x1)} ${f(y1)} ${f(x1 - r)} ${f(y1)}` +
      ` L ${f(x0 + r)} ${f(y1)} Q ${f(x0)} ${f(y1)} ${f(x0)} ${f(y1 - r)}` +
      ` L ${f(x0)} ${f(y0 + r)} Q ${f(x0)} ${f(y0)} ${f(x0 + r)} ${f(y0)} Z`;
  return {
    kind: "roundedRect",
    params: { x: +x0.toFixed(2), y: +y0.toFixed(2), w: +w.toFixed(2), h: +h.toFixed(2), r: +r.toFixed(2) },
    rms: +bestRms.toFixed(3),
    max: +bestMax.toFixed(2),
    d,
    anchors: r < 0.5 ? 4 : 8,
  };
}

function distToRoundRect(p: Pt, x0: number, y0: number, x1: number, y1: number, r: number): number {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const hw = (x1 - x0) / 2 - r, hh = (y1 - y0) / 2 - r;
  const dx = Math.abs(p.x - cx) - hw, dy = Math.abs(p.y - cy) - hh;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return Math.abs(outside + inside - r);
}

/**
 * 가장 잘 맞는 프리미티브를 고른다.
 *
 * `tolerance` 는 캔버스 최소변에 비례해야 한다 — 절대 px 로 두면 큰 캔버스에서 지나치게
 * 엄격하고 작은 캔버스에서 헐거워진다.
 */
export function bestFit(
  pts: Pt[],
  opts: { tolerance: number; closed: boolean },
): FitResult | null {
  if (pts.length < 4) return null;
  const cands: (FitResult | null)[] = opts.closed
    ? [fitCircle(pts), fitEllipse(pts), fitRoundedRect(pts)]
    : [fitLine(pts)];
  let best: FitResult | null = null;
  for (const c of cands) {
    if (!c) continue;
    // 최대 잔차만 보면 **대부분 어긋나는데 한 점만 우연히 가까운** 적합도 통과한다.
    // 실측: 신발 도면에서 351개가 타원으로 승격돼 선 충실도가 0.996 → 0.962 로 떨어졌다.
    // 평균(rms)도 함께 본다.
    if (c.max > opts.tolerance) continue;
    if (c.rms > opts.tolerance / 3) continue;
    // 앵커가 적을수록, 잔차가 낮을수록 좋다. 잔차를 우선한다.
    if (!best || c.rms < best.rms - 1e-6 || (Math.abs(c.rms - best.rms) < 1e-6 && c.anchors < best.anchors)) {
      best = c;
    }
  }
  void TAU;
  return best;
}
