/**
 * **주기 테두리 압축** — 물결·구슬·스캘럽처럼 한 줄로 이어진 주기적 굽이를,
 * 굽이 한 개(모티프) + 배치 목록으로 접는다.
 *
 * `findPatterns` 는 서로 떨어진 같은 모양 덩어리만 묶는다 — 이어진 한 획 안의 반복은
 * 못 본다. 그래서 주얼리 비즈 테두리 하나가 앵커 수백 개를 먹었다(실측 s_jewelry_06).
 *
 * 방법: 획을 호길이 등간격으로 샘플하고, **꺾임각 신호의 자기상관**으로 주기를 찾는다.
 * 주기를 찾아도 바로 믿지 않는다 — 마디마다 모티프를 (회전+이동+배율)로 앉혀 보고
 * **실제 어긋남**을 잰다. 한 마디라도 허용을 넘으면 통째로 포기한다. 반쯤 패턴으로
 * 바꾸면 이음매가 눈에 띄고, 원본을 지키는 쪽이 항상 덜 나쁘다.
 *
 * `V4_PERIODIC=0` 으로 끈다.
 */
import { parsePath, type Pt } from "../vector/pathdata.js";
import { fitAdaptive, segsToPathD } from "../vector/fitCurve.js";

export interface PeriodicResult {
  motif: string;
  motifSize: [number, number];
  instances: { x: number; y: number; scale: number; rotate: number }[];
  /** 원래 앵커 수 → 모티프 앵커 수 (저장 기준 절감을 판단할 근거) */
  anchorsBefore: number;
  motifAnchors: number;
  period: number;
  deviation: number;
}

const STEP = 1.5;

/** d 를 호길이 등간격 폴리라인으로 편다 */
function flatten(d: string): { pts: Pt[]; closed: boolean } | null {
  const subs = parsePath(d);
  if (subs.length !== 1) return null;
  const sp = subs[0];
  const raw: Pt[] = [sp.start];
  let cur = sp.start;
  for (const s of sp.segs) {
    if (s.type === "L") { raw.push(s.end); cur = s.end; continue; }
    const [x0, y0] = cur, [x1, y1] = s.c1!, [x2, y2] = s.c2!, [x3, y3] = s.end;
    const rough = Math.hypot(x3 - x0, y3 - y0) + Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x3 - x2, y3 - y2);
    const n = Math.max(2, Math.min(48, Math.ceil(rough / STEP)));
    for (let i = 1; i <= n; i++) {
      const t = i / n, m = 1 - t;
      raw.push([
        m * m * m * x0 + 3 * m * m * t * x1 + 3 * m * t * t * x2 + t * t * t * x3,
        m * m * m * y0 + 3 * m * m * t * y1 + 3 * m * t * t * y2 + t * t * t * y3,
      ]);
    }
    cur = s.end;
  }
  // 등간격 재샘플
  const pts: Pt[] = [raw[0]];
  let acc = 0;
  for (let i = 1; i < raw.length; i++) {
    let seg = Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
    let from = raw[i - 1];
    while (acc + seg >= STEP) {
      const t = (STEP - acc) / seg;
      const q: Pt = [from[0] + (raw[i][0] - from[0]) * t, from[1] + (raw[i][1] - from[1]) * t];
      pts.push(q);
      seg = Math.hypot(raw[i][0] - q[0], raw[i][1] - q[1]);
      from = q;
      acc = 0;
    }
    acc += seg;
  }
  return { pts, closed: sp.closed };
}

/** 샘플 i 에서의 꺾임각(라디안, 부호 포함) */
function turnSignal(pts: Pt[], closed: boolean): number[] {
  const n = pts.length;
  const out = new Array<number>(n).fill(0);
  const at = (i: number) => pts[((i % n) + n) % n];
  const lim = closed ? n : n - 1;
  for (let i = closed ? 0 : 1; i < lim; i++) {
    const a = at(i - 1), b = at(i), c = at(i + 1);
    const v1: Pt = [b[0] - a[0], b[1] - a[1]];
    const v2: Pt = [c[0] - b[0], c[1] - b[1]];
    const cross = v1[0] * v2[1] - v1[1] * v2[0];
    const dot = v1[0] * v2[0] + v1[1] * v2[1];
    out[i] = Math.atan2(cross, dot);
  }
  return out;
}

/** 정규화 자기상관 — lag 샘플 수 단위 */
function bestPeriod(sig: number[], minLag: number, maxLag: number): { lag: number; corr: number } | null {
  const n = sig.length;
  const mean = sig.reduce((a, b) => a + b, 0) / n;
  const c = sig.map((v) => v - mean);
  const denom = c.reduce((a, b) => a + b * b, 0);
  if (denom < 1e-9) return null;
  let best: { lag: number; corr: number } | null = null;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0;
    for (let i = 0; i + lag < n; i++) num += c[i] * c[i + lag];
    const corr = num / denom;
    if (!best || corr > best.corr) best = { lag, corr };
  }
  return best;
}

/** 마디 [a..b) 의 코드 변환으로 모티프를 앉혔을 때의 최대 어긋남 */
function fitInstance(
  motifPts: Pt[], motifChord: number,
  pts: Pt[], a: number, b: number,
): { x: number; y: number; scale: number; rotate: number; dev: number } | null {
  const p0 = pts[a], p1 = pts[Math.min(b, pts.length - 1)];
  const chord = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (chord < 1e-6 || motifChord < 1e-6) return null;
  const scale = chord / motifChord;
  if (scale < 0.6 || scale > 1.7) return null;   // 배율이 크게 다르면 같은 모티프가 아니다
  const rotate = (Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) * 180) / Math.PI;
  const r = (rotate * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
  // 변환된 모티프 vs 실제 마디 — 양쪽 다 등간격이므로 인덱스 대응으로 잰다
  const m = b - a;
  let worst = 0;
  for (let i = 0; i < motifPts.length; i++) {
    const t = i / (motifPts.length - 1);
    const j = a + Math.round(t * m);
    const q = pts[Math.min(j, pts.length - 1)];
    const mx = motifPts[i][0] * scale, my = motifPts[i][1] * scale;
    const tx = p0[0] + mx * cs - my * sn;
    const ty = p0[1] + mx * sn + my * cs;
    const dd = Math.hypot(tx - q[0], ty - q[1]);
    if (dd > worst) worst = dd;
    if (worst > 1e4) break;
  }
  return { x: p0[0], y: p0[1], scale, rotate, dev: worst };
}

/**
 * 획 하나를 주기 패턴으로 접어 본다. 실패하면 null — 원본을 그대로 쓴다.
 *
 * @param tol 허용 어긋남(px). 선 굵기의 절반쯤이 적당하다.
 */
export function compressPeriodic(d: string, tol: number): PeriodicResult | null {
  if (process.env.V4_PERIODIC === "0") return null;
  const fl = flatten(d);
  if (!fl) return null;
  const { pts, closed } = fl;
  const n = pts.length;
  const len = n * STEP;
  if (n < 120 || len < 180) return null;          // 짧으면 접어도 이득이 없다

  const sig = turnSignal(pts, closed);
  const minLag = Math.max(8, Math.round(12 / STEP));
  const maxLag = Math.floor(n / 4);
  if (maxLag <= minLag) return null;
  const per = bestPeriod(sig, minLag, maxLag);
  if (!per || per.corr < 0.72) return null;

  const P = per.lag;
  const reps = Math.floor(n / P);
  if (reps < 4) return null;
  // 닫힌 획은 총 길이가 주기의 정수배에 가까워야 한다 — 아니면 마지막 마디가 어긋난다
  if (closed && Math.abs(n - reps * P) > P * 0.25) return null;

  // 모티프 = 첫 마디, 로컬 좌표(시작점 원점) — **회전은 인스턴스가 맡는다**
  const a0 = 0, b0 = P;
  const p0 = pts[a0], p1 = pts[b0];
  const baseRot = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  const cs = Math.cos(-baseRot), sn = Math.sin(-baseRot);
  const motifPts: Pt[] = [];
  for (let i = a0; i <= b0; i++) {
    const dx = pts[i][0] - p0[0], dy = pts[i][1] - p0[1];
    motifPts.push([dx * cs - dy * sn, dx * sn + dy * cs]);
  }
  const motifChord = Math.hypot(motifPts[motifPts.length - 1][0], motifPts[motifPts.length - 1][1]);

  // 모든 마디를 앉혀 보고 하나라도 넘으면 포기
  const instances: PeriodicResult["instances"] = [];
  let worst = 0;
  for (let k = 0; k < reps; k++) {
    const a = k * P;
    const b = k === reps - 1 && closed ? n : Math.min((k + 1) * P, n - 1);
    const inst = fitInstance(motifPts, motifChord, pts, a, b);
    if (!inst || inst.dev > tol) return null;
    if (inst.dev > worst) worst = inst.dev;
    instances.push({ x: inst.x, y: inst.y, scale: inst.scale, rotate: inst.rotate });
  }
  // 열린 획의 꼬리(마지막 불완전 마디)가 주기의 1/3을 넘으면 포기 — 꼬리를 버릴 수는 없다
  if (!closed && n - reps * P > P / 3) return null;

  // 모티프를 큐빅으로
  const { segs } = fitAdaptive(motifPts, { baseError: Math.max(0.8, tol * 0.5), cornerTurnDeg: 62 });
  if (!segs.length) return null;
  const motifD = segsToPathD(segs, false);
  const motifAnchors = (motifD.match(/[MLC]/g) ?? []).length;
  const anchorsBefore = (d.match(/[MLC]/g) ?? []).length;
  // 저장 기준으로도 이득이어야 한다 — 모티프가 원본만큼 크면 접는 의미가 없다
  if (motifAnchors * 2 >= anchorsBefore) return null;

  let w = 0, h = 0;
  for (const p of motifPts) { w = Math.max(w, Math.abs(p[0])); h = Math.max(h, Math.abs(p[1])); }
  return {
    motif: motifD,
    motifSize: [Math.ceil(w), Math.ceil(Math.max(1, h * 2))],
    instances,
    anchorsBefore, motifAnchors,
    period: P * STEP,
    deviation: worst,
  };
}

// ── 닮은 획 군집 ────────────────────────────────────────────
//
// 구슬·스티치 조각·아일릿은 **서로 떨어진 닮은 작은 획**이다. 실측(x6_j06): 앵커 1,772가
// 획 337개에 분산 — 획당 5개라 주기 압축(한 획 안의 반복)이 잡을 것이 없다. 잡아야 할
// 것은 획 사이의 반복이다.
//
// 떨어진 획이므로 주기 압축과 달리 **부분 채택이 안전하다** — 안 맞는 멤버는 개별 획으로
// 남기면 되고, 이음매가 생기지 않는다.

export interface StrokeClusterItem {
  d: string;
  width: number;
  partId?: string;
  shared?: string[];
}

export interface StrokeCluster {
  motif: string;
  motifSize: [number, number];
  strokeWidth: number;
  instances: { x: number; y: number; scale: number; rotate: number; partId?: string }[];
  /** 소비한 원본 인덱스 */
  members: number[];
  anchorsBefore: number;
  motifAnchors: number;
}

/** 열린 획을 코드(시작→끝) 정렬 로컬 폴리라인으로 */
function normalizeOpen(d: string): { pts: Pt[]; chord: number; p0: Pt; rot: number } | null {
  const fl = flatten(d);
  if (!fl || fl.closed) return null;
  const { pts } = fl;
  if (pts.length < 6) return null;
  const p0 = pts[0], p1 = pts[pts.length - 1];
  const chord = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (chord < 4) return null;
  const rot = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  const cs = Math.cos(-rot), sn = Math.sin(-rot);
  const out: Pt[] = pts.map((q) => {
    const dx = q[0] - p0[0], dy = q[1] - p0[1];
    return [(dx * cs - dy * sn) / chord, (dx * sn + dy * cs) / chord];
  });
  return { pts: out, chord, p0, rot };
}

/**
 * 정규화 좌표에서 두 획의 **최대** 거리 — 인덱스 대응 (양쪽 다 등간격).
 * 평균으로 쟀더니 한쪽 끝이 크게 다른 획들이 묶여 선 충실도가 무너졌다(실측 x7·x8).
 */
function shapeDist(a: Pt[], b: Pt[]): number {
  const n = 24;
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const pa = a[Math.min(a.length - 1, Math.round(t * (a.length - 1)))];
    const pb = b[Math.min(b.length - 1, Math.round(t * (b.length - 1)))];
    const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * 닮은 열린 획을 군집으로 묶는다.
 *
 * @param tolShape 정규화 좌표(코드=1)에서의 평균 거리 허용 — 0.06 이면 꽤 엄격
 * @param minMembers 이보다 적으면 묶지 않는다 (묶어도 이득이 없다)
 */
export function clusterStrokes(
  items: StrokeClusterItem[],
  opts: { tolShape?: number; minMembers?: number } = {},
): StrokeCluster[] {
  // **기본 꺼짐 — 옵트인.** 최대 거리 검증까지 넣었는데도 실측에서 해가 남았다:
  // s_shoe_2 의 작은 디테일 2개가 대표 모티프로 대체되며 2px 밖으로 어긋나 소실됐고
  // (디테일 88% → 75%, 충실도 게이트 탈락), 이득은 앵커 -1.4% 뿐이었다.
  // 손그림 디테일은 하나하나 달라서 이 방식의 거래가 성립하지 않는다.
  // 도장 찍듯 동일한 반복이 확실한 도면에서만 V4_STROKE_CLUSTER=1 로 켠다.
  if (process.env.V4_STROKE_CLUSTER !== "1") return [];
  const tolShape = opts.tolShape ?? 0.06;
  const minMembers = opts.minMembers ?? 6;

  interface Cand { idx: number; norm: NonNullable<ReturnType<typeof normalizeOpen>>; anchors: number; width: number }
  const cands: Cand[] = [];
  for (let i = 0; i < items.length; i++) {
    const anchors = (items[i].d.match(/[MLC]/g) ?? []).length;
    if (anchors < 3 || anchors > 16) continue;          // 너무 단순하거나 너무 복잡한 것은 제외
    const norm = normalizeOpen(items[i].d);
    if (!norm) continue;
    if (norm.chord < 8 || norm.chord > 220) continue;   // 구슬·스티치 크기 범위
    cands.push({ idx: i, norm, anchors, width: items[i].width });
  }
  if (cands.length < minMembers) return [];

  // 그리디 군집 — 대표와의 형상 거리 + 굵기 비
  const used = new Set<number>();
  const out: StrokeCluster[] = [];
  for (let i = 0; i < cands.length; i++) {
    if (used.has(i)) continue;
    const rep = cands[i];
    const members: Cand[] = [rep];
    for (let j = i + 1; j < cands.length; j++) {
      if (used.has(j)) continue;
      const c = cands[j];
      const wr = Math.max(rep.width, c.width) / Math.max(0.5, Math.min(rep.width, c.width));
      if (wr > 1.6) continue;
      const sd = Math.min(
        shapeDist(rep.norm.pts, c.norm.pts),
        // 반대 방향으로 그려진 같은 모양도 잡는다
        shapeDist(rep.norm.pts, [...c.norm.pts].reverse().map((p) => [1 - p[0], -p[1]] as Pt)),
      );
      if (sd > tolShape) continue;
      // **실측 px 로도 확인한다.** 정규화 거리 0.06 은 코드가 200px 면 12px 어긋남까지
      // 통과시킨다 — 그렇게 묶었더니 선 F@2 가 0.989 → 0.934 로 무너졌다(실측 x7_j06).
      // 대표를 이 획의 코드에 앉혔을 때의 실거리로 다시 재고, 넘으면 안 묶는다.
      if (sd * c.norm.chord > Math.max(1.2, c.width * 0.4)) continue;
      members.push(c);
    }
    if (members.length < minMembers) continue;

    // 모티프 = 대표를 실좌표 크기로 (코드 길이의 중앙값 배율)
    const chords = members.map((m) => m.norm.chord).sort((a, b) => a - b);
    const midChord = chords[chords.length >> 1];
    const motifPts: Pt[] = rep.norm.pts.map((p) => [p[0] * midChord, p[1] * midChord]);
    const { segs } = fitAdaptive(motifPts, { baseError: 0.8, cornerTurnDeg: 62 });
    if (!segs.length) continue;
    const motifD = segsToPathD(segs, false);
    const motifAnchors = (motifD.match(/[MLC]/g) ?? []).length;
    const anchorsBefore = members.reduce((a, m) => a + m.anchors, 0);
    if (motifAnchors + members.length >= anchorsBefore) continue;   // 이득이 없다

    for (const m of members) used.add(cands.indexOf(m));
    let w = 0, h = 0;
    for (const p of motifPts) { w = Math.max(w, Math.abs(p[0])); h = Math.max(h, Math.abs(p[1])); }
    out.push({
      motif: motifD,
      motifSize: [Math.ceil(Math.max(1, w)), Math.ceil(Math.max(1, h * 2))],
      strokeWidth: members.reduce((a, m) => a + m.width, 0) / members.length,
      instances: members.map((m) => ({
        x: m.norm.p0[0], y: m.norm.p0[1],
        scale: m.norm.chord / midChord,
        rotate: (m.norm.rot * 180) / Math.PI,
        partId: items[m.idx].partId,
      })),
      members: members.map((m) => m.idx),
      anchorsBefore, motifAnchors,
    });
  }
  return out;
}
