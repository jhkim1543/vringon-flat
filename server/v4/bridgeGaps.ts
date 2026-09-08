/**
 * **열린 끝점 잇기** — 얇은 선화가 도형을 온전히 이루게 한다.
 *
 * 실측(v6.7 th_ 샘플): 열린 끝점의 28~32% 가 바로 옆에 이어붙일 짝이 있었다
 * (jewelry_1 142개 중 23쌍 · shoe_1 956개 중 133쌍, 대부분 같은 프리미티브 안).
 * 끊긴 획은 끝점마다 앵커를 하나씩 먹고, 앵커 솎기는 서브패스 안에서만 돌므로
 * 그 끝점들을 영영 못 없앤다 — 그리고 무엇보다 도형이 안 닫혀 보인다.
 *
 * 판정은 tools/joinable.ts 의 자와 같다: 끝점 거리 ≤ NEAR, 접선이 마주 보며
 * 이어지는 꺾임 ≤ TURN. 같은 서브패스의 양끝이면 닫고(Z), 다른 획이면 한 획으로
 * 잇는다. 대시(DASH_OR_STITCH)는 일부러 열려 있는 것이라 건드리지 않는다.
 *
 * v7.1 (2026-09-07 외부 리뷰 반영) 셋을 더했다:
 *   ① **코너 이음** — 두 획이 코너에서 맞닿은 2갈래 접촉은 꺾임이 커도 한 획으로.
 *      끝점 둘(앵커 2)이 코너 앵커 하나가 되고, 디자이너가 "한 줄"로 잡는다.
 *   ② **잉크 근거** — 먼 다리(> NEAR)는 도면 잉크가 그 사이를 실제로 잇고 있어야 한다.
 *      지표 하나 낮추려고 빈 곳을 메우지 않는다.
 *   ③ **이은 획 재피팅** — 이음매에 남는 끝점 앵커 둘을 dpMerge 로 한 번 더 솎는다.
 *      잇기는 솎기 뒤에 도는데, 솎기는 서브패스 안에서만 돌아 이음매를 못 본다.
 */
import { parsePath, serializePath, type Pt, type SubPath } from "../vector/pathdata.js";
import { thinAnchors, pathDeviation } from "./refit.js";
import type { ScenePrimitive, StrokePrimitive } from "./types.js";

/**
 * 문턱은 **거리에 따라 계단식**이다. 가까우면(≤6px) 접선이 꽤 꺾여도 같은 획이지만,
 * 멀수록(≤16px) 곧게 이어질 때만 믿는다 — 굵은 선이 다른 선과 교차하며 끊긴 자리는
 * 틈이 교차선 굵기만큼(10~20px) 벌어져 있었다(실측 la_jewelry_2: 6px 문턱 밖 끊김이
 * 12px 에서 2배, 20px 에서 3배). 먼 쌍은 옆줄 이탈(lateral)도 본다.
 */
const NEAR = Number(process.env.V4_BRIDGE_NEAR ?? 6);
const TURN = Number(process.env.V4_BRIDGE_TURN ?? 60);
const NEAR_FAR = Number(process.env.V4_BRIDGE_FAR ?? 16);
const TURN_FAR = Number(process.env.V4_BRIDGE_FAR_TURN ?? 30);
/**
 * **코너 이음 상한(°).** 접촉한(≤ NEAR) 두 끝점이 서로에게 유일한 이웃(2갈래)이면
 * 꺾임이 이만큼 커도 잇는다 — 코너를 지나는 한 획이다. 150° 를 넘으면 되접힌 선
 * (같은 자리를 되돌아 그린 것)이라 따로 둔다. 실측 v7e 9종: 2갈래 60~150° 쌍이
 * shoe_3 132 · shoe_2 58 · bag_2 49 … 합계 약 370 — 쌍마다 앵커 1·패스 1 이 준다.
 * 0 이면 끔.
 */
const CORNER_TURN = Number(process.env.V4_BRIDGE_CORNER ?? 150);
/**
 * **잉크 근거 하한.** 먼 다리(> NEAR)의 안쪽 표본 중 도면 잉크(3×3 이웃) 위에 있는
 * 비율이 이보다 낮으면 잇지 않는다. 골격이 교차점에서 끊긴 자리는 잉크가 이어져 있고,
 * 도면이 정말 비운 자리는 잉크가 없다 — 둘을 가르는 자가 이것이다. 0 이면 끔.
 */
const INK_MIN = Number(process.env.V4_BRIDGE_INK ?? 0.6);
/** 이은 획을 dpMerge 로 다시 솎는가 (V4_BRIDGE_REFIT=0 이면 끔) */
const REFIT = process.env.V4_BRIDGE_REFIT !== "0";
/**
 * **교차점 관통 연결.** 격자·메시의 선은 골격화가 교차점마다 끊는다 — 한 줄이
 * 셀 수만큼 토막 난다(실측 sf_shoe_2: 스트로크 앵커의 51%가 60px 미만 조각,
 * 그중 1,016개가 곧은 열린 조각으로 앵커 2,190개를 먹었다).
 *
 * 일반 잇기는 "상호 최근접"을 요구하는데, 4갈래 교차점에서는 어느 쪽도 서로의
 * 최근접이 아니라 전부 거부된다. 여기서는 **거리 대신 직진성**으로 짝을 고른다 —
 * 교차점을 곧게 관통하는 짝만 잇는다. 문턱이 높아야 진짜 코너를 안 삼킨다.
 */
const JUNC_R = Number(process.env.V4_JUNCTION_R ?? 26);
/** 관통 판정 cos 하한 (0.985 ≈ 10°) */
const JUNC_COS = Number(process.env.V4_JUNCTION_COS ?? 0.985);

export interface BridgeCtx {
  /** 도면 잉크(1 = 선). 장면과 같은 좌표계(W×H) */
  ink?: Uint8Array;
  W?: number;
  H?: number;
  /** 이은 획 재피팅 허용오차(px). 없으면 재피팅하지 않는다 */
  refitTol?: number;
  /** 먼저 시도하는 넓은 허용오차 — 이탈이 devLimit 안일 때만 채택 (v0.2 리뷰: 1.5 가 최적) */
  refitWide?: number;
  /** 재피팅 전후 양방향 이탈 상한(px) */
  devLimit?: number;
}

export interface BridgeReport {
  closed: number;
  /** 매끈한 이음 + 코너 이음 + 교차점 관통 */
  joined: number;
  corner: number;
  through: number;
  /** 잉크 근거가 없어 기각한 먼 다리 */
  inkRejected: number;
  /** 재피팅으로 줄인 앵커 수 */
  refitSaved: number;
  /** 다른 획 안쪽에 붙인 끝점 수 */
  attached: number;
}

interface End {
  prim: StrokePrimitive;
  sub: SubPath;
  /** "head"=start 쪽 · "tail"=끝 쪽 */
  side: "head" | "tail";
  p: Pt;
  /** 바깥쪽(획이 계속됐을) 방향 */
  t: Pt;
}

function endpoints(prim: StrokePrimitive, sub: SubPath): End[] {
  if (sub.closed || !sub.segs.length) return [];
  const first = sub.segs[0];
  const headIn = first.type === "L" ? first.end : first.c1!;
  const last = sub.segs[sub.segs.length - 1];
  const prev = sub.segs.length > 1 ? sub.segs[sub.segs.length - 2].end : sub.start;
  const tailIn = last.type === "L" ? prev : last.c2!;
  const tailP = last.end;
  return [
    { prim, sub, side: "head", p: sub.start, t: [sub.start[0] - headIn[0], sub.start[1] - headIn[1]] },
    { prim, sub, side: "tail", p: tailP, t: [tailP[0] - tailIn[0], tailP[1] - tailIn[1]] },
  ];
}

function turnDeg(a: End, b: End): number | null {
  const na = Math.hypot(a.t[0], a.t[1]), nb = Math.hypot(b.t[0], b.t[1]);
  if (na < 1e-6 || nb < 1e-6) return null;
  // 마주 보며 이어지려면 바깥 방향이 서로 반대여야 한다
  const cos = (a.t[0] * b.t[0] + a.t[1] * b.t[1]) / (na * nb);
  return (Math.acos(Math.max(-1, Math.min(1, -cos))) * 180) / Math.PI;
}

type JoinKind = "smooth" | "corner" | false;

/**
 * **굵기가 같은 획만 잇는다.** 패스는 굵기를 하나만 가진다 — 1.2px 획이 3.2px 획을 흡수하면
 * 흡수된 쪽이 얇게 그려져 충실도가 깎이고, 디자이너는 굵은 선이 사라진 것을 본다.
 * 실측(v7.1 B): jewelry_1 코너 후보 8쌍 중 6쌍이 굵기가 달랐고, 그대로 이었더니
 * 선 F@2 가 0.9715 → 0.9473 으로 떨어져 충실도 게이트를 놓쳤다. 채점 폭(qaWidth)도 본다.
 */
function sameWidth(a: StrokePrimitive, b: StrokePrimitive): boolean {
  if (Math.abs(a.width - b.width) > 1e-6) return false;
  const qa = (a as { qaWidth?: number }).qaWidth, qb = (b as { qaWidth?: number }).qaWidth;
  return (qa ?? a.width) === (qb ?? b.width);
}

/**
 * 잇는가. `deg2` 는 두 끝점이 NEAR 안에서 서로에게 유일한 이웃인지 — 코너 이음은
 * 그때만 허용한다(세 갈래 이상은 어느 둘을 이을지 모호하다).
 */
function joinOk(a: End, b: End, deg2: boolean): JoinKind {
  const gap = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]);
  if (gap > NEAR_FAR) return false;
  const turn = turnDeg(a, b);
  if (turn == null) return false;
  if (gap <= NEAR) {
    if (turn <= TURN) return "smooth";
    if (deg2 && CORNER_TURN > 0 && turn <= CORNER_TURN) return "corner";
    return false;
  }
  // 먼 쌍 — 곧게 이어질 때만: 꺾임을 조이고, b 가 a 의 연장선에서 벗어나면 옆줄이다
  if (turn > TURN_FAR) return false;
  const na = Math.hypot(a.t[0], a.t[1]);
  const ux = a.t[0] / na, uy = a.t[1] / na;
  const vx = b.p[0] - a.p[0], vy = b.p[1] - a.p[1];
  const lateral = Math.abs(vx * -uy + vy * ux);
  const forward = vx * ux + vy * uy;
  return forward > 0 && lateral <= Math.max(3, gap * 0.35) ? "smooth" : false;
}

/**
 * 두 끝점 사이 **안쪽**(t 0.15~0.85)에 도면 잉크가 있는 비율. 끝점 자체는 이미
 * 잉크 위라 세지 않는다. 골격이 실제 선 중앙에서 1px 쯤 비껴 있을 수 있어 3×3 을 본다.
 */
function inkSupport(ctx: BridgeCtx, a: Pt, b: Pt): number {
  const { ink, W, H } = ctx;
  if (!ink || !W || !H) return 1;
  const gap = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(5, Math.ceil(gap * 2));
  let hit = 0;
  for (let i = 0; i < n; i++) {
    const t = 0.15 + (0.7 * i) / (n - 1);
    const x = Math.round(a[0] + (b[0] - a[0]) * t), y = Math.round(a[1] + (b[1] - a[1]) * t);
    let on = false;
    for (let dy = -1; dy <= 1 && !on; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        if (ink[yy * W + xx]) { on = true; break; }
      }
    }
    if (on) hit++;
  }
  return hit / n;
}

function subLen(sp: SubPath): number {
  let L = 0, cur = sp.start;
  for (const s of sp.segs) { L += Math.hypot(s.end[0] - cur[0], s.end[1] - cur[1]); cur = s.end; }
  return L;
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

/** 끝점 쌍의 열쇠 — 같은 쌍을 패스마다 다시 세지 않기 위해 */
function pairKey(a: End, b: End): string {
  const ka = `${a.prim.id}:${a.side}`, kb = `${b.prim.id}:${b.side}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function anchorCount(d: string): number {
  return (d.match(/[MLC]/g) ?? []).length;
}

/**
 * 틈을 잇는 세그먼트 — **접선을 이은 큐빅**이 기본이고, 되돌아가는 모양이면 직선으로 떨어진다.
 *
 * 직선(L)으로 이으면 이음매가 꺾여 보인다(외부 리뷰 v0.4 의 지적). 제어점을 양쪽 바깥 접선
 * 방향으로 d/3 만큼 내밀면 원래 획의 방향을 이어받는다. 다만 코너 이음처럼 두 접선이 크게
 * 꺾인 자리는 큐빅이 부풀거나 되돌 수 있어, **세 제어변이 모두 전진할 때만** 큐빅을 쓴다.
 */
function bridgeSeg(e: End, m: End, from: Pt, to: Pt): { type: "L" | "C"; c1?: Pt; c2?: Pt; end: Pt } {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const dist = Math.hypot(dx, dy);
  const na = Math.hypot(e.t[0], e.t[1]), nb = Math.hypot(m.t[0], m.t[1]);
  if (dist < 1e-6 || na < 1e-6 || nb < 1e-6) return { type: "L", end: to };
  const ux = dx / dist, uy = dy / dist;
  const c1: Pt = [from[0] + (e.t[0] / na) * dist / 3, from[1] + (e.t[1] / na) * dist / 3];
  const c2: Pt = [to[0] + (m.t[0] / nb) * dist / 3, to[1] + (m.t[1] / nb) * dist / 3];
  const fwd = [[c1, from], [c2, c1], [to, c2]].map(([q, r]) => (q[0] - r[0]) * ux + (q[1] - r[1]) * uy);
  if (Math.min(...fwd) <= 0) return { type: "L", end: to };
  return { type: "C", c1, c2, end: to };
}

/** e.prim 이 m.prim 을 흡수한다 — e 쪽이 tail 이 되도록, m 쪽이 head 로 이어지도록 뒤집는다 */
function absorb(e: End, m: End, single: Map<StrokePrimitive, SubPath>): void {
  let keep = single.get(e.prim)!;
  let take = single.get(m.prim)!;
  if (e.side === "head") keep = reverseSub(keep);
  if (m.side === "tail") take = reverseSub(take);
  // 다리: 틈이 있으면 접선 큐빅(또는 직선)으로 잇고, 이어서 흡수한 획의 세그를 붙인다
  const gap = Math.hypot(m.p[0] - e.p[0], m.p[1] - e.p[1]);
  const from: Pt = keep.segs.length ? keep.segs[keep.segs.length - 1].end : keep.start;
  if (gap > 0.05) keep.segs.push(process.env.V4_BRIDGE_CUBIC === "0"
    ? { type: "L", end: take.start }
    : bridgeSeg(e, m, from, take.start));
  keep.segs.push(...take.segs);
  e.prim.d = serializePath([keep]);
  single.set(e.prim, keep);
  e.prim.area += m.prim.area;
  const bb = e.prim.bbox, b2 = m.prim.bbox;
  e.prim.bbox = [
    Math.min(bb[0], b2[0]), Math.min(bb[1], b2[1]),
    Math.max(bb[2], b2[2]), Math.max(bb[3], b2[3]),
  ];
  if (m.prim.partId && m.prim.partId !== e.prim.partId) {
    e.prim.shared = [...new Set([...(e.prim.shared ?? []), m.prim.partId])];
  }
  single.delete(m.prim);
}

/** 서브패스 하나짜리 열린 획만 모은다 — 잇기의 대상이다 */
function collectSingles(
  primitives: ScenePrimitive[],
  absorbed: Set<StrokePrimitive>,
): { single: Map<StrokePrimitive, SubPath>; all: End[] } {
  const single = new Map<StrokePrimitive, SubPath>();
  for (const p of primitives) {
    if (p.cls !== "STRUCTURAL_STROKE" || absorbed.has(p as StrokePrimitive)) continue;
    const prim = p as StrokePrimitive;
    const subs = parsePath(prim.d);
    if (subs.length === 1 && !subs[0].closed && subs[0].segs.length) single.set(prim, subs[0]);
  }
  const all: End[] = [];
  for (const [prim, sub] of single) all.push(...endpoints(prim, sub));
  return { single, all };
}

function makeGrid(all: End[], cell: number): (p: Pt) => End[] {
  const grid = new Map<string, End[]>();
  for (const e of all) {
    const k = `${Math.floor(e.p[0] / cell)},${Math.floor(e.p[1] / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(e);
  }
  return (p: Pt): End[] => {
    const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
    const out: End[] = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) out.push(...(grid.get(`${gx + i},${gy + j}`) ?? []));
    return out;
  };
}

/**
 * 프리미티브 배열을 제자리에서 수리한다.
 * 단순함을 위해 **서브패스 하나짜리 획만** 잇는다(실측 대상의 대부분이다).
 */
export function bridgeGaps(
  primitives: ScenePrimitive[],
  say?: (m: string) => void,
  ctx: BridgeCtx = {},
): BridgeReport {
  const strokes = primitives.filter(
    (p): p is StrokePrimitive => p.cls === "STRUCTURAL_STROKE",
  );
  const modified = new Set<StrokePrimitive>();
  const stats = { corner: 0, inkRejected: new Set<string>() };

  let closed = 0;

  // ── 1) 자기 닫기: 한 서브패스의 양끝이 만나면 Z 로 닫는다 ────────────
  for (const prim of strokes) {
    const subs = parsePath(prim.d);
    let changed = false;
    for (const sub of subs) {
      if (sub.closed || sub.segs.length < 2) continue;
      const ends = endpoints(prim, sub);
      if (ends.length !== 2) continue;
      const gap = Math.hypot(ends[0].p[0] - ends[1].p[0], ends[0].p[1] - ends[1].p[1]);
      if (gap > NEAR) continue;
      // 점 같은 조각을 고리로 오므리면 안 된다 — 둘레가 틈의 4배는 되어야 도형이다
      if (subLen(sub) < Math.max(12, gap * 4)) continue;
      if (!joinOk(ends[0], ends[1], false)) continue;
      sub.closed = true;
      changed = true;
      closed++;
    }
    if (changed) { prim.d = serializePath(subs); modified.add(prim); }
  }

  // ── 2) 획 잇기: 다른 획의 끝점끼리 상호 최근접이면 한 획으로 ─────────
  //
  // **패스를 여러 번 돈다.** 한 번 이은 획은 그 패스에서 동결되지만(끝점 정보가
  // 낡는다), A-B 를 이은 뒤 그 결과가 다시 C 와 이어질 수 있다 — 세 토막 난 한
  // 줄이 실제로 있었다. 수렴할 때까지(최대 4패스) 반복한다.
  let joined = 0;
  const absorbed = new Set<StrokePrimitive>();
  for (let pass = 0; pass < 4; pass++) {
    const j = joinPass(primitives, absorbed, modified, ctx, stats);
    joined += j;
    if (!j) break;
  }
  // 교차점 관통 — 일반 잇기가 "상호 최근접"에서 거부한 격자선을 직진성으로 잇는다
  let through = 0;
  if (process.env.V4_JUNCTION !== "0") {
    for (let pass = 0; pass < 4; pass++) {
      const j = junctionPass(primitives, absorbed, modified, ctx, stats);
      through += j;
      if (!j) break;
    }
  }
  if (absorbed.size) {
    for (let i = primitives.length - 1; i >= 0; i--) {
      const p = primitives[i];
      if (p.cls === "STRUCTURAL_STROKE" && absorbed.has(p as StrokePrimitive)) primitives.splice(i, 1);
    }
  }

  // ── 3) 이은 획 재피팅 ──────────────────────────────────────
  //
  // 이음매에는 앵커가 둘 남는다(A 의 끝, B 의 시작 — 틈이 있었으면 L 다리까지).
  // 솎기는 이미 돌았지만 서브패스 안에서만 돌아 이음매를 넘어 합치지 못했다.
  // **바뀐 획만** 다시 솎는다 — 안 바뀐 획을 다시 솎으면 오차만 쌓인다.
  let refitSaved = 0;
  if (REFIT && ctx.refitTol && ctx.refitTol > 0) {
    for (const prim of modified) {
      if (absorbed.has(prim)) continue;
      const r = guardedThin(prim.d, ctx.refitTol, ctx.refitWide ?? ctx.refitTol, ctx.devLimit ?? 2.0);
      if (r.saved > 0) { prim.d = r.d; refitSaved += r.saved; }
    }
  }

  // ── 4) 가지 붙이기 — 끝점이 다른 획의 **안쪽**에 닿아 있으면 그 위로 옮긴다 ──
  //
  // 끝점끼리만 이으면 T 자로 만나는 옆선(스티치 끝·패널 가지)은 영원히 "살짝 떠" 있다.
  // 외부 리뷰 v0.2 의 지적: 끝점-곡선 내부 접합이 외곽 연속성의 본체다. 끝점과 그 손잡이를
  // 같은 변위로 옮겨 접선을 지키고, 상대 획의 끝 근처(NEAR 안)는 제외한다(그건 잇기 몫).
  let attached = 0;
  if (process.env.V4_BRIDGE_ATTACH !== "0") attached = attachPass(primitives, absorbed, modified);

  if (closed || joined || through || attached) {
    const bits = [`고리 닫음 ${closed}`, `획 이음 ${joined}${stats.corner ? ` (코너 ${stats.corner})` : ""}`, `교차점 관통 ${through}`];
    if (attached) bits.push(`가지 붙임 ${attached}`);
    if (stats.inkRejected.size) bits.push(`잉크 없어 기각 ${stats.inkRejected.size}`);
    if (refitSaved) bits.push(`이음매 재피팅 앵커 −${refitSaved}`);
    say?.(`끝점 잇기 — ${bits.join(" · ")}`);
  }
  return { closed, joined: joined + through, corner: stats.corner, through, inkRejected: stats.inkRejected.size, refitSaved, attached };
}

/**
 * 교차점 관통 패스 — 직진성만으로 짝을 고른다.
 * 반환은 이은 수. `absorbed` 에 흡수된 획을 표시한다.
 */
function junctionPass(
  primitives: ScenePrimitive[],
  absorbed: Set<StrokePrimitive>,
  modified: Set<StrokePrimitive>,
  ctx: BridgeCtx,
  stats: { inkRejected: Set<string> },
): number {
  const { single, all } = collectSingles(primitives, absorbed);
  const near9 = makeGrid(all, Math.max(JUNC_R, 2));

  /**
   * a 에서 곧게 관통해 이어지는 최선의 짝. 판정 셋을 **모두** 넘어야 한다:
   *   ① a 의 진행 방향과 a→b 변위가 같은 방향   (교차점 너머로 나아간다)
   *   ② a 의 진행 방향과 b 의 진행 방향이 반대   (마주 보며 이어진다)
   *   ③ 옆으로 밀린 정도가 작다                  (평행한 옆줄이 아니다)
   */
  const straightBest = (a: End, dead: Set<StrokePrimitive>): { e: End; score: number } | null => {
    const na = Math.hypot(a.t[0], a.t[1]);
    if (na < 1e-6) return null;
    const ux = a.t[0] / na, uy = a.t[1] / na;
    let best: { e: End; score: number } | null = null;
    for (const b of near9(a.p)) {
      if (b.prim === a.prim || dead.has(b.prim) || !sameWidth(a.prim, b.prim)) continue;
      const vx = b.p[0] - a.p[0], vy = b.p[1] - a.p[1];
      const gap = Math.hypot(vx, vy);
      if (gap < 1e-6 || gap > JUNC_R) continue;
      const forward = (vx * ux + vy * uy) / gap;          // ①
      if (forward < JUNC_COS) continue;
      const nb = Math.hypot(b.t[0], b.t[1]);
      if (nb < 1e-6) continue;
      const opp = -(a.t[0] * b.t[0] + a.t[1] * b.t[1]) / (na * nb);   // ②
      if (opp < JUNC_COS) continue;
      const lateral = Math.abs(vx * -uy + vy * ux);        // ③
      if (lateral > Math.max(1.5, gap * 0.15)) continue;
      const score = forward + opp - gap / (JUNC_R * 20);
      if (!best || score > best.score) best = { e: b, score };
    }
    return best;
  };

  let joined = 0;
  const frozen = new Set<StrokePrimitive>();
  const isDead = (p: StrokePrimitive) => absorbed.has(p) || frozen.has(p);
  for (const e of all) {
    if (isDead(e.prim)) continue;
    const dead = new Set([...absorbed, ...frozen]);
    const m = straightBest(e, dead);
    if (!m) continue;
    // 반대편에서도 이쪽이 최선이어야 한다 — 아니면 더 곧은 짝이 따로 있다
    const back = straightBest(m.e, dead);
    if (!back || back.e.prim !== e.prim) continue;
    // 관통 다리도 도면 잉크 위를 지나야 한다 — 교차선을 건너는 자리는 잉크가 있다
    if (INK_MIN > 0 && inkSupport(ctx, e.p, m.e.p) < INK_MIN) { stats.inkRejected.add(pairKey(e, m.e)); continue; }

    absorb(e, m.e, single);
    absorbed.add(m.e.prim);
    modified.add(e.prim);
    frozen.add(e.prim);
    joined++;
  }
  return joined;
}

/** 한 패스의 획 잇기 — 이은 수를 돌려준다 */
function joinPass(
  primitives: ScenePrimitive[],
  absorbed: Set<StrokePrimitive>,
  modified: Set<StrokePrimitive>,
  ctx: BridgeCtx,
  stats: { corner: number; inkRejected: Set<string> },
): number {
  const { single, all } = collectSingles(primitives, absorbed);
  const near9 = makeGrid(all, Math.max(NEAR_FAR, 2));

  // 끝점마다 NEAR 안의 **다른 획** 끝점 수 — 1 이면 2갈래 접촉의 한쪽이다
  const degree = new Map<End, number>();
  for (const e of all) {
    let n = 0;
    for (const c of near9(e.p)) {
      if (c.prim === e.prim) continue;
      if (Math.hypot(e.p[0] - c.p[0], e.p[1] - c.p[1]) <= NEAR) n++;
    }
    degree.set(e, n);
  }
  const deg2 = (a: End, b: End) => degree.get(a) === 1 && degree.get(b) === 1;

  const bestOf = (e: End, dead: (p: StrokePrimitive) => boolean): { e: End; kind: JoinKind } | null => {
    let best: End | null = null, bk: JoinKind = false, bd = Infinity;
    for (const c of near9(e.p)) {
      if (c.prim === e.prim || dead(c.prim) || !sameWidth(e.prim, c.prim)) continue;
      const kind = joinOk(e, c, deg2(e, c));
      if (!kind) continue;
      const d = Math.hypot(e.p[0] - c.p[0], e.p[1] - c.p[1]);
      if (d < bd) { bd = d; best = c; bk = kind; }
    }
    return best ? { e: best, kind: bk } : null;
  };

  let joined = 0;
  /** 이번 패스에서 더 잇지 않을 획 (좌표가 바뀌어 끝점 정보가 낡았다) */
  const frozen = new Set<StrokePrimitive>();
  const dead = (p: StrokePrimitive) => absorbed.has(p) || frozen.has(p);
  // 상호 최근접만 잇는다 — 한쪽만의 최근접은 세 갈래 교차점을 잘못 삼킬 수 있다
  for (const e of all) {
    if (dead(e.prim)) continue;
    const m = bestOf(e, dead);
    if (!m || bestOf(m.e, dead)?.e !== e) continue;
    const gap = Math.hypot(m.e.p[0] - e.p[0], m.e.p[1] - e.p[1]);
    // 먼 다리는 도면 잉크가 사이를 잇고 있어야 한다
    if (gap > NEAR && INK_MIN > 0 && inkSupport(ctx, e.p, m.e.p) < INK_MIN) { stats.inkRejected.add(pairKey(e, m.e)); continue; }

    absorb(e, m.e, single);
    absorbed.add(m.e.prim);
    modified.add(e.prim);
    if (m.kind === "corner") stats.corner++;
    joined++;
    // 좌표가 바뀐 끝점 정보는 낡았다 — 보수적으로 이 획의 추가 병합은 다음 기회로
    frozen.add(e.prim);
  }
  return joined;
}


/**
 * **이탈을 재 가며 솎는다.** 넓은 허용오차(wide)로 먼저 솎고, 원래 패스 대비 양방향 이탈이
 * devLimit 안이면 채택, 넘으면 좁은 허용오차(tol)로 다시. 둘 다 넘으면 원본 유지.
 * v0.2 리뷰의 스윕(0.75/1.5/3.0 → 1.5 가 최소 앵커)을 우리 자(2px 게이트 창)로 받아들인 것.
 */
export function guardedThin(d: string, tol: number, wide: number, devLimit: number): { d: string; saved: number } {
  const before = anchorCount(d);
  const tries = wide > tol ? [wide, tol] : [tol];
  for (const t of tries) {
    const nd = thinAnchors(d, t);
    const after = anchorCount(nd);
    if (after >= before) continue;
    const dev = pathDeviation(d, nd, 0.5);
    if (Number.isFinite(dev) && dev <= devLimit) return { d: nd, saved: before - after };
  }
  return { d, saved: 0 };
}

/** 획을 촘촘히 표본 — 가지 붙이기의 과녁 */
function denseSamples(sub: SubPath, step = 2): Pt[] {
  const out: Pt[] = [sub.start];
  let cur = sub.start;
  for (const s of sub.segs) {
    if (s.type === "L") {
      const L = Math.hypot(s.end[0] - cur[0], s.end[1] - cur[1]);
      const n = Math.max(1, Math.ceil(L / step));
      for (let i = 1; i <= n; i++) out.push([cur[0] + (s.end[0] - cur[0]) * i / n, cur[1] + (s.end[1] - cur[1]) * i / n]);
    } else {
      const rough = Math.hypot(s.end[0] - cur[0], s.end[1] - cur[1]) + Math.hypot(s.c1![0] - cur[0], s.c1![1] - cur[1]);
      const n = Math.max(2, Math.min(64, Math.ceil(rough / step)));
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        out.push([
          u * u * u * cur[0] + 3 * u * u * t * s.c1![0] + 3 * u * t * t * s.c2![0] + t * t * t * s.end[0],
          u * u * u * cur[1] + 3 * u * u * t * s.c1![1] + 3 * u * t * t * s.c2![1] + t * t * t * s.end[1],
        ]);
      }
    }
    cur = s.end;
  }
  return out;
}

function attachPass(primitives: ScenePrimitive[], absorbed: Set<StrokePrimitive>, modified: Set<StrokePrimitive>): number {
  const strokes = primitives.filter(
    (p): p is StrokePrimitive => p.cls === "STRUCTURAL_STROKE" && !absorbed.has(p as StrokePrimitive),
  );
  // 과녁: 모든 획의 안쪽 표본 (양 끝 NEAR 안은 제외 — 끝점끼리는 잇기가 다룬다)
  type Target = { prim: StrokePrimitive; p: Pt };
  const cell = Math.max(NEAR, 2);
  const grid = new Map<string, Target[]>();
  const parsed = new Map<StrokePrimitive, SubPath[]>();
  for (const prim of strokes) {
    const subs = parsePath(prim.d);
    parsed.set(prim, subs);
    for (const sub of subs) {
      const pts = denseSamples(sub);
      const ends = sub.closed ? [] : [sub.start, pts[pts.length - 1]];
      for (const q of pts) {
        if (ends.some((e) => Math.hypot(e[0] - q[0], e[1] - q[1]) <= NEAR)) continue;
        const k = `${Math.floor(q[0] / cell)},${Math.floor(q[1] / cell)}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push({ prim, p: q });
      }
    }
  }
  let attached = 0;
  for (const prim of strokes) {
    const subs = parsed.get(prim)!;
    if (subs.length !== 1 || subs[0].closed || !subs[0].segs.length) continue;
    const sub = subs[0];
    let changed = false;
    for (const side of ["head", "tail"] as const) {
      const p: Pt = side === "head" ? sub.start : sub.segs[sub.segs.length - 1].end;
      const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
      let best: Target | null = null, bd = NEAR;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const t of grid.get(`${gx + i},${gy + j}`) ?? []) {
          if (t.prim === prim || !sameWidth(prim, t.prim)) continue;
          const d = Math.hypot(t.p[0] - p[0], t.p[1] - p[1]);
          if (d < bd) { bd = d; best = t; }
        }
      }
      if (!best || bd < 0.3) continue;
      const dx = best.p[0] - p[0], dy = best.p[1] - p[1];
      if (side === "head") {
        sub.start = [sub.start[0] + dx, sub.start[1] + dy];
        const f = sub.segs[0];
        if (f.type === "C") f.c1 = [f.c1![0] + dx, f.c1![1] + dy];
      } else {
        const l = sub.segs[sub.segs.length - 1];
        l.end = [l.end[0] + dx, l.end[1] + dy];
        if (l.type === "C") l.c2 = [l.c2![0] + dx, l.c2![1] + dy];
      }
      changed = true; attached++;
    }
    if (changed) { prim.d = serializePath([sub]); modified.add(prim); }
  }
  return attached;
}
