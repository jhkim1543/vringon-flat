/**
 * **증거 기반 먼 틈 잇기** — 도면에 선이 남아 있는 자리만 잇는다.
 *
 * `bridgeGaps` 는 짧은 틈(≤16px)만 다룬다. 그런데 실측(외부 리뷰 v0.4, shoe_1)에서 앞코의
 * 틈은 **29.7px**, 선 굵기의 9.3배였다 — 도면에는 선이 이어져 있는데 벡터에서만 빠진 자리다.
 * 문턱을 그냥 올리면 엉뚱한 것을 잇는다. 그래서 **거리 대신 증거**로 가른다.
 *
 * v0.4 가 제시한 다섯 자를 그대로 쓴다(우리 잉크는 이진이 아니라 실제 농도 0~1 이다):
 *   ① 스케일 상대 상한 — min(12×굵기, 0.015×장면대각). 큰 그림의 큰 틈도 같은 잣대로 본다.
 *   ② 접선을 **호 길이 4×굵기** 로 재고, 끝 조각의 미분과 40° 넘게 어긋나면 불안정으로 기각.
 *   ③ 잉크 근거는 **직선이 아니라 실제 놓일 곡선 위**에서 — 평균·하위10%·연속지지율.
 *   ④ **국소 대비** — 다리 양옆 4×굵기의 배경보다 0.15 이상 진해야 한다. 이게 "여기 잉크가
 *      있다" 와 "여기 **선이** 있다" 를 가른다. 넓은 검은 면 위를 지나는 다리는 이걸로 걸린다.
 *   ⑤ **평행선 경쟁자** — 다리를 따라 나란히 달리는 다른 획이 있으면 그 잉크를 빌린 것이므로
 *      보류한다(짧은 옆가지는 길이 방향 겹침으로 걸러 낸다).
 *
 * 다리는 **접선을 이은 큐빅 하나**다 — 직선(L)으로 이으면 이음매가 꺾여 보인다. 제어점은
 * P1 = P0 + ta·d/3, P2 = P3 + tb·d/3 이고 세 제어변이 모두 전진해야(단조) 고리가 안 생긴다.
 */
import { parsePath, serializePath, type Pt, type SubPath } from "../vector/pathdata.js";
import type { ScenePrimitive, StrokePrimitive } from "./types.js";
import { sampleSubpath } from "../vector/curveGeometry.js";

/** 굵기의 몇 배까지 이을 것인가 */
const MAX_W = Number(process.env.V4_GAP_MAX_WIDTHS ?? 12);
/** 장면 대각의 몇 배까지 (큰 그림에서 상한이 폭주하지 않게) */
const MAX_DIAG = Number(process.env.V4_GAP_MAX_DIAG ?? 0.015);
/** 이보다 가까우면 bridgeGaps 몫이다 */
const MIN_GAP = Number(process.env.V4_GAP_MIN ?? 6);
/** 획이 굵기의 몇 배는 길어야 후보가 되나 — 짧은 토막은 방향을 못 믿는다 */
const MIN_LEN_W = Number(process.env.V4_GAP_MIN_LEN_WIDTHS ?? 8);
/** 접선을 재는 호 길이(굵기 배수)와 불안정 상한(°) */
const TAN_SPAN_W = Number(process.env.V4_GAP_TAN_SPAN ?? 4);
const TAN_UNSTABLE = Number(process.env.V4_GAP_TAN_UNSTABLE ?? 40);
/** 두 접선이 서로를 향하는 정렬 상한(°) */
const MAX_ANGLE = Number(process.env.V4_GAP_ANGLE ?? 35);
/** 잉크 근거 (농도 0~1) */
const INK_MEAN = Number(process.env.V4_GAP_INK_MEAN ?? 0.35);
const INK_Q10 = Number(process.env.V4_GAP_INK_Q10 ?? 0.2);
const INK_TH = Number(process.env.V4_GAP_INK_TH ?? 0.25);
const INK_FRAC = Number(process.env.V4_GAP_INK_FRAC ?? 0.9);
const INK_REL = Number(process.env.V4_GAP_INK_REL ?? 0.8);
const CONTRAST = Number(process.env.V4_GAP_CONTRAST ?? 0.15);
/** 평행 경쟁자 판정 여유(굵기 배수) */
const PARALLEL_W = Number(process.env.V4_GAP_PARALLEL ?? 2.5);
/** 두 후보 점수가 이보다 가까우면 둘 다 보류 */
const AMBIGUITY = Number(process.env.V4_GAP_AMBIGUITY ?? 0.08);

export interface GapReport {
  /** 이은 다리 수 */
  bridged: number;
  /** 기각·보류 사유별 수 */
  rejected: Record<string, number>;
  /** 후보로 오른 쌍 */
  candidates: number;
}

interface End {
  prim: StrokePrimitive;
  sub: SubPath;
  side: "head" | "tail";
  p: Pt;
  /** 바깥쪽 단위 접선 (호 길이 span 으로 잰 것) */
  t: Pt;
  /** 끝 근처 잉크 농도 기준값 (q60) */
  ref: number;
  idx: number;
}

const med = (v: number[]) => { const s = [...v].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const quant = (v: number[], q: number) => {
  if (!v.length) return 0;
  const s = [...v].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** 획을 촘촘히 표본 — 길이·접선·충돌 판정의 공통 재료 */
function samples(sub: SubPath, step: number): Pt[] {
  // A fixed 64-sample ceiling can skip a real crossing on a long cubic.
  return sampleSubpath(sub,step);
}

const polyLen = (pts: Pt[]) => {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
};

/** 끝에서 호 길이 `span` 만큼 들어간 점 */
function inward(pts: Pt[], fromTail: boolean, span: number): Pt {
  const seq = fromTail ? [...pts].reverse() : pts;
  let acc = 0;
  for (let i = 1; i < seq.length; i++) {
    acc += Math.hypot(seq[i][0] - seq[i - 1][0], seq[i][1] - seq[i - 1][1]);
    if (acc >= span) return seq[i];
  }
  return seq[seq.length - 1];
}

/** 큐빅 위의 점과 접선 */
function cubicAt(P0: Pt, P1: Pt, P2: Pt, P3: Pt, t: number): { p: Pt; d: Pt } {
  const u = 1 - t;
  const p: Pt = [
    u * u * u * P0[0] + 3 * u * u * t * P1[0] + 3 * u * t * t * P2[0] + t * t * t * P3[0],
    u * u * u * P0[1] + 3 * u * u * t * P1[1] + 3 * u * t * t * P2[1] + t * t * t * P3[1],
  ];
  const d: Pt = [
    3 * u * u * (P1[0] - P0[0]) + 6 * u * t * (P2[0] - P1[0]) + 3 * t * t * (P3[0] - P2[0]),
    3 * u * u * (P1[1] - P0[1]) + 6 * u * t * (P2[1] - P1[1]) + 3 * t * t * (P3[1] - P2[1]),
  ];
  return { p, d };
}

function reverseSub(sp: SubPath): SubPath {
  const pts: { p: Pt; c1?: Pt; c2?: Pt; type: "L" | "C" }[] = [];
  let cur = sp.start;
  for (const s of sp.segs) { pts.push({ p: cur, c1: s.c1, c2: s.c2, type: s.type }); cur = s.end; }
  const out: SubPath = { start: cur, segs: [], closed: false };
  for (let i = pts.length - 1; i >= 0; i--) {
    const s = pts[i];
    out.segs.push(s.type === "L" ? { type: "L", end: s.p } : { type: "C", c1: s.c2, c2: s.c1, end: s.p });
  }
  return out;
}

export function bridgeEvidenceGaps(
  primitives: ScenePrimitive[],
  gray: Float32Array,
  W: number, H: number,
  say?: (m: string) => void,
): GapReport {
  const rep: GapReport = { bridged: 0, rejected: {}, candidates: 0 };
  if (process.env.V4_GAP === "0") return rep;
  const no = (why: string) => { rep.rejected[why] = (rep.rejected[why] ?? 0) + 1; };
  /** 잉크 농도 (0=흰 · 1=검정), 이중선형 */
  const ink = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return 0;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const g = (xx: number, yy: number) => gray[yy * W + xx];
    return (g(x0, y0) * (1 - fx) + g(x1, y0) * fx) * (1 - fy) + (g(x0, y1) * (1 - fx) + g(x1, y1) * fx) * fy;
  };

  // ── 후보 획과 끝점 ──────────────────────────────────────
  const strokes: { prim: StrokePrimitive; sub: SubPath; pts: Pt[]; len: number }[] = [];
  for (const p of primitives) {
    if (p.cls !== "STRUCTURAL_STROKE") continue;
    const prim = p as StrokePrimitive;
    const subs = parsePath(prim.d);
    if (subs.length !== 1 || subs[0].closed || !subs[0].segs.length) continue;
    const pts = samples(subs[0], Math.max(1, prim.width * 0.5));
    const len = polyLen(pts);
    strokes.push({ prim, sub: subs[0], pts, len });
  }
  // 충돌·평행 판정용 격자 (모든 획의 표본)
  const cell = 24;
  const grid = new Map<string, { si: number; p: Pt }[]>();
  strokes.forEach((s, si) => {
    for (const q of s.pts) {
      const k = `${Math.floor(q[0] / cell)},${Math.floor(q[1] / cell)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push({ si, p: q });
    }
  });
  const near = (p: Pt, r: number) => {
    const out: { si: number; p: Pt }[] = [];
    const g0x = Math.floor((p[0] - r) / cell), g1x = Math.floor((p[0] + r) / cell);
    const g0y = Math.floor((p[1] - r) / cell), g1y = Math.floor((p[1] + r) / cell);
    for (let gx = g0x; gx <= g1x; gx++) for (let gy = g0y; gy <= g1y; gy++) {
      for (const t of grid.get(`${gx},${gy}`) ?? []) if (Math.hypot(t.p[0] - p[0], t.p[1] - p[1]) <= r) out.push(t);
    }
    return out;
  };

  const ends: End[] = [];
  strokes.forEach((s, si) => {
    const w = s.prim.width;
    if (s.len < MIN_LEN_W * w) { no("too_short"); return; }
    for (const side of ["head", "tail"] as const) {
      const p: Pt = side === "head" ? s.sub.start : s.sub.segs[s.sub.segs.length - 1].end;
      // 이미 다른 획에 붙어 있으면 틈이 아니다 (attachPass 가 붙인 자리 포함)
      if (near(p, Math.max(0.5, w * 0.6)).some((t) => t.si !== si)) { no("already_attached"); continue; }
      const inner = inward(s.pts, side === "tail", Math.min(TAN_SPAN_W * w, s.len * 0.3));
      const tx = p[0] - inner[0], ty = p[1] - inner[1];
      const tn = Math.hypot(tx, ty);
      if (tn < 1e-6) { no("no_tangent"); continue; }
      // 끝 조각의 미분과 크게 어긋나면 끝이 흔들린 것이다
      const seg = side === "head" ? s.sub.segs[0] : s.sub.segs[s.sub.segs.length - 1];
      const near1 = side === "head" ? (seg.type === "C" ? seg.c1! : seg.end)
        : (seg.type === "C" ? seg.c2! : (s.sub.segs.length > 1 ? s.sub.segs[s.sub.segs.length - 2].end : s.sub.start));
      const lx = p[0] - near1[0], ly = p[1] - near1[1], ln = Math.hypot(lx, ly);
      if (ln > 1e-6) {
        const cos = (tx * lx + ty * ly) / (tn * ln);
        if (cos < Math.cos((TAN_UNSTABLE * Math.PI) / 180)) { no("unstable_tangent"); continue; }
      }
      // 끝 근처 잉크 기준값 — 안쪽 0.5w..4w 의 상위 40% 지점
      const refs: number[] = [];
      for (let k = 0; k < 9; k++) {
        const d = w * 0.5 + (Math.min(w * 4, s.len * 0.3) - w * 0.5) * (k / 8);
        const q = inward(s.pts, side === "tail", d);
        refs.push(ink(q[0], q[1]));
      }
      ends.push({ prim: s.prim, sub: s.sub, side, p, t: [tx / tn, ty / tn], ref: quant(refs, 0.6), idx: si });
    }
  });
  if (ends.length < 2) return rep;

  // ── 후보 쌍 ────────────────────────────────────────────
  const diag = Math.hypot(W, H);
  const cosLimit = Math.cos((MAX_ANGLE * Math.PI) / 180);
  type Cand = { a: number; b: number; score: number; d: number; bridge: [Pt, Pt, Pt, Pt] };
  const cands: Cand[] = [];
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const A = ends[i], B = ends[j];
      if (A.prim === B.prim) continue;
      const w = A.prim.width;
      if (Math.abs(w - B.prim.width) > 1e-6) continue;                       // 굵기가 다르면 다른 선이다
      if ((A.prim.qaWidth ?? w) !== (B.prim.qaWidth ?? B.prim.width)) continue;
      if (A.prim.partId && B.prim.partId && A.prim.partId !== B.prim.partId) continue;
      const dist = Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1]);
      const limit = Math.min(MAX_W * w, MAX_DIAG * diag);
      if (dist <= MIN_GAP || dist > limit) continue;
      const ux = (B.p[0] - A.p[0]) / dist, uy = (B.p[1] - A.p[1]) / dist;
      const align = Math.min(A.t[0] * ux + A.t[1] * uy, B.t[0] * -ux + B.t[1] * -uy);
      if (align < cosLimit) { no("misaligned"); continue; }

      const P0 = A.p, P3 = B.p;
      const P1: Pt = [P0[0] + A.t[0] * dist / 3, P0[1] + A.t[1] * dist / 3];
      const P2: Pt = [P3[0] + B.t[0] * dist / 3, P3[1] + B.t[1] * dist / 3];
      // 단조 — 세 제어변이 모두 전진해야 다리가 되돌지 않는다
      const fwd = [[P1, P0], [P2, P1], [P3, P2]].map(([q, p]) => (q[0] - p[0]) * ux + (q[1] - p[1]) * uy);
      if (Math.min(...fwd) <= 0) { no("nonmonotone"); continue; }

      // ── 잉크 근거 (실제 놓일 곡선 위) ────────────────────
      const n = Math.max(17, Math.ceil(dist * 2));
      const vals: number[] = [], diffs: number[] = [];
      let collided = false;
      for (let k = 0; k < n; k++) {
        const t = 0.08 + (0.84 * k) / (n - 1);
        const { p, d } = cubicAt(P0, P1, P2, P3, t);
        const dn = Math.hypot(d[0], d[1]) || 1;
        const nx = -d[1] / dn, ny = d[0] / dn;
        const v = ink(p[0], p[1]);
        vals.push(v);
        diffs.push(v - (ink(p[0] + nx * w * 4, p[1] + ny * w * 4) + ink(p[0] - nx * w * 4, p[1] - ny * w * 4)) / 2);
        // 제3의 획을 관통하면 안 된다 (양 끝 1.5w 는 제외)
        if (t > 0.15 && t < 0.85) {
          if (near(p, w * 0.75).some((q) => q.si !== A.idx && q.si !== B.idx)) collided = true;
        }
      }
      if (collided) { no("collision"); continue; }
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      const q10 = quant(vals, 0.1);
      const frac = vals.filter((v) => v >= INK_TH).length / vals.length;
      const reference = Math.max(A.ref, B.ref);
      if (Math.min(A.ref, B.ref) < INK_TH) { no("faint_endpoint"); continue; }
      if (mean < INK_MEAN || q10 < INK_Q10 || frac < INK_FRAC || mean / Math.max(reference, 1e-9) < INK_REL) {
        no("no_ink_evidence"); continue;
      }
      if (med(diffs) < CONTRAST) { no("flat_or_broad_ink"); continue; }

      // ── 평행 경쟁자 — 다리를 따라 나란히 달리는 획의 잉크를 빌린 것 ──
      let parallel = false;
      const probe: Pt[] = [];
      for (let k = 0; k < 7; k++) probe.push(cubicAt(P0, P1, P2, P3, 0.15 + (0.7 * k) / 6).p);
      const byStroke = new Map<number, Pt[]>();
      for (const q of probe) {
        for (const t of near(q, PARALLEL_W * w)) {
          if (t.si === A.idx || t.si === B.idx) continue;
          (byStroke.get(t.si) ?? byStroke.set(t.si, []).get(t.si)!).push(t.p);
        }
      }
      for (const [si, hits] of byStroke) {
        if (hits.length < 5) continue;                                        // 표본 7개 중 5개 이상 곁에 있어야
        const spread = Math.max(...hits.map((q) => q[0] * ux + q[1] * uy)) - Math.min(...hits.map((q) => q[0] * ux + q[1] * uy));
        if (spread < dist * 0.5) continue;                                    // 옆에서 끝나는 짧은 가지는 경쟁자가 아니다
        const s2 = strokes[si];
        const first = s2.pts[0], last = s2.pts[s2.pts.length - 1];
        const vx = last[0] - first[0], vy = last[1] - first[1], vn = Math.hypot(vx, vy) || 1;
        if (Math.abs((vx * ux + vy * uy) / vn) > 0.9) { parallel = true; break; }
      }
      if (parallel) { no("parallel_competitor"); continue; }

      cands.push({ a: i, b: j, d: dist, bridge: [P0, P1, P2, P3],
        score: 0.55 * align + 0.35 * mean + 0.1 * (1 - dist / limit) });
    }
  }
  rep.candidates = cands.length;
  if (!cands.length) return rep;

  // ── 보수적 매칭 — 끝점마다 하나, 비슷한 후보가 둘이면 보류 ──
  const byEnd = new Map<number, number[]>();
  for (const c of cands) for (const e of [c.a, c.b]) (byEnd.get(e) ?? byEnd.set(e, []).get(e)!).push(c.score);
  const ambiguous = new Set<number>();
  for (const [e, list] of byEnd) {
    if (list.length < 2) continue;
    const s = [...list].sort((x, y) => y - x);
    if (s[0] - s[1] < AMBIGUITY) ambiguous.add(e);
  }
  const used = new Set<number>();
  const chosen: Cand[] = [];
  for (const c of [...cands].sort((x, y) => y.score - x.score)) {
    if (ambiguous.has(c.a) || ambiguous.has(c.b)) { no("ambiguous"); continue; }
    if (used.has(c.a) || used.has(c.b)) { no("endpoint_taken"); continue; }
    used.add(c.a); used.add(c.b);
    chosen.push(c);
  }

  // ── 잇기 — 접선 큐빅 하나로 두 획을 한 획으로 ──────────────
  const absorbed = new Set<StrokePrimitive>();
  const frozen = new Set<StrokePrimitive>();
  const subOf = new Map<StrokePrimitive, SubPath>();
  for (const s of strokes) subOf.set(s.prim, s.sub);
  for (const c of chosen) {
    const A = ends[c.a], B = ends[c.b];
    if (absorbed.has(A.prim) || absorbed.has(B.prim) || frozen.has(A.prim) || frozen.has(B.prim)) { no("stale"); continue; }
    let keep = subOf.get(A.prim)!, take = subOf.get(B.prim)!;
    if (A.side === "head") keep = reverseSub(keep);
    if (B.side === "tail") take = reverseSub(take);
    const [, P1, P2, P3] = c.bridge;
    keep.segs.push({ type: "C", c1: P1, c2: P2, end: P3 });
    keep.segs.push(...take.segs);
    A.prim.d = serializePath([keep]);
    subOf.set(A.prim, keep);
    A.prim.area += B.prim.area;
    const bb = A.prim.bbox, b2 = B.prim.bbox;
    A.prim.bbox = [Math.min(bb[0], b2[0]), Math.min(bb[1], b2[1]), Math.max(bb[2], b2[2]), Math.max(bb[3], b2[3])];
    if (B.prim.partId && B.prim.partId !== A.prim.partId) {
      A.prim.shared = [...new Set([...(A.prim.shared ?? []), B.prim.partId])];
    }
    absorbed.add(B.prim);
    frozen.add(A.prim);
    rep.bridged++;
  }
  if (absorbed.size) {
    for (let i = primitives.length - 1; i >= 0; i--) {
      const p = primitives[i];
      if (p.cls === "STRUCTURAL_STROKE" && absorbed.has(p as StrokePrimitive)) primitives.splice(i, 1);
    }
  }
  if (rep.bridged) {
    const top = Object.entries(rep.rejected).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k} ${v}`).join(" · ");
    say?.(`먼 틈 잇기 — 도면 잉크 근거로 ${rep.bridged}곳 (후보 ${rep.candidates} · 기각 ${top})`);
  }
  return rep;
}
