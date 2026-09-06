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
 */
import { parsePath, serializePath, type Pt, type SubPath } from "../vector/pathdata.js";
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

function joinOk(a: End, b: End): boolean {
  const gap = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]);
  if (gap > NEAR_FAR) return false;
  const na = Math.hypot(a.t[0], a.t[1]), nb = Math.hypot(b.t[0], b.t[1]);
  if (na < 1e-6 || nb < 1e-6) return false;
  // 마주 보며 이어지려면 바깥 방향이 서로 반대여야 한다
  const cos = (a.t[0] * b.t[0] + a.t[1] * b.t[1]) / (na * nb);
  const turn = (Math.acos(Math.max(-1, Math.min(1, -cos))) * 180) / Math.PI;
  if (gap <= NEAR) return turn <= TURN;
  // 먼 쌍 — 곧게 이어질 때만: 꺾임을 조이고, b 가 a 의 연장선에서 벗어나면 옆줄이다
  if (turn > TURN_FAR) return false;
  const ux = a.t[0] / na, uy = a.t[1] / na;
  const vx = b.p[0] - a.p[0], vy = b.p[1] - a.p[1];
  const lateral = Math.abs(vx * -uy + vy * ux);
  const forward = vx * ux + vy * uy;
  return forward > 0 && lateral <= Math.max(3, gap * 0.35);
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

/**
 * 프리미티브 배열을 제자리에서 수리한다. 반환은 { closed, joined } 개수.
 * 단순함을 위해 **서브패스 하나짜리 획만** 잇는다(실측 대상의 대부분이다).
 */
export function bridgeGaps(
  primitives: ScenePrimitive[],
  say?: (m: string) => void,
): { closed: number; joined: number } {
  const strokes = primitives.filter(
    (p): p is StrokePrimitive => p.cls === "STRUCTURAL_STROKE",
  );

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
      if (!joinOk(ends[0], ends[1])) continue;
      sub.closed = true;
      changed = true;
      closed++;
    }
    if (changed) prim.d = serializePath(subs);
  }

  // ── 2) 획 잇기: 다른 획의 끝점끼리 상호 최근접이면 한 획으로 ─────────
  //
  // **패스를 여러 번 돈다.** 한 번 이은 획은 그 패스에서 동결되지만(끝점 정보가
  // 낡는다), A-B 를 이은 뒤 그 결과가 다시 C 와 이어질 수 있다 — 세 토막 난 한
  // 줄이 실제로 있었다. 수렴할 때까지(최대 4패스) 반복한다.
  let joined = 0;
  const absorbed = new Set<StrokePrimitive>();
  for (let pass = 0; pass < 4; pass++) {
    const j = joinPass(primitives, absorbed);
    joined += j;
    if (!j) break;
  }
  // 교차점 관통 — 일반 잇기가 "상호 최근접"에서 거부한 격자선을 직진성으로 잇는다
  let through = 0;
  if (process.env.V4_JUNCTION !== "0") {
    for (let pass = 0; pass < 4; pass++) {
      const j = junctionPass(primitives, absorbed);
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
  if (closed || joined || through) {
    say?.(`끝점 잇기 — 고리 닫음 ${closed} · 획 이음 ${joined} · 교차점 관통 ${through}`);
  }
  return { closed, joined: joined + through };
}

/**
 * 교차점 관통 패스 — 직진성만으로 짝을 고른다.
 * 반환은 이은 수. `absorbed` 에 흡수된 획을 표시한다.
 */
function junctionPass(
  primitives: ScenePrimitive[],
  absorbed: Set<StrokePrimitive>,
): number {
  const strokes = primitives.filter(
    (p): p is StrokePrimitive => p.cls === "STRUCTURAL_STROKE" && !absorbed.has(p as StrokePrimitive),
  );
  const single = new Map<StrokePrimitive, SubPath>();
  for (const prim of strokes) {
    const subs = parsePath(prim.d);
    if (subs.length === 1 && !subs[0].closed && subs[0].segs.length) single.set(prim, subs[0]);
  }
  const all: End[] = [];
  for (const [prim, sub] of single) all.push(...endpoints(prim, sub));

  const cell = Math.max(JUNC_R, 2);
  const grid = new Map<string, End[]>();
  for (const e of all) {
    const k = `${Math.floor(e.p[0] / cell)},${Math.floor(e.p[1] / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(e);
  }
  const near9 = (p: Pt): End[] => {
    const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
    const out: End[] = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) out.push(...(grid.get(`${gx + i},${gy + j}`) ?? []));
    return out;
  };

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
      if (b.prim === a.prim || dead.has(b.prim)) continue;
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
  const dead = new Set<StrokePrimitive>();
  const isDead = (p: StrokePrimitive) => absorbed.has(p) || frozen.has(p) || dead.has(p);
  for (const e of all) {
    if (isDead(e.prim)) continue;
    const m = straightBest(e, new Set([...absorbed, ...frozen, ...dead]));
    if (!m) continue;
    // 반대편에서도 이쪽이 최선이어야 한다 — 아니면 더 곧은 짝이 따로 있다
    const back = straightBest(m.e, new Set([...absorbed, ...frozen, ...dead]));
    if (!back || back.e.prim !== e.prim) continue;

    let keep = single.get(e.prim)!;
    let take = single.get(m.e.prim)!;
    if (e.side === "head") keep = reverseSub(keep);
    if (m.e.side === "tail") take = reverseSub(take);
    const gap = Math.hypot(m.e.p[0] - e.p[0], m.e.p[1] - e.p[1]);
    if (gap > 0.05) keep.segs.push({ type: "L", end: take.start });
    keep.segs.push(...take.segs);
    e.prim.d = serializePath([keep]);
    single.set(e.prim, keep);
    e.prim.area += m.e.prim.area;
    const bb = e.prim.bbox, b2 = m.e.prim.bbox;
    e.prim.bbox = [Math.min(bb[0], b2[0]), Math.min(bb[1], b2[1]), Math.max(bb[2], b2[2]), Math.max(bb[3], b2[3])];
    if (m.e.prim.partId && m.e.prim.partId !== e.prim.partId) {
      e.prim.shared = [...new Set([...(e.prim.shared ?? []), m.e.prim.partId])];
    }
    absorbed.add(m.e.prim);
    single.delete(m.e.prim);
    frozen.add(e.prim);
    joined++;
  }
  return joined;
}

/** 한 패스의 획 잇기 — 이은 수를 돌려준다 */
function joinPass(
  primitives: ScenePrimitive[],
  absorbed: Set<StrokePrimitive>,
): number {
  const strokes = primitives.filter(
    (p): p is StrokePrimitive => p.cls === "STRUCTURAL_STROKE" && !absorbed.has(p as StrokePrimitive),
  );
  const single = new Map<StrokePrimitive, SubPath>();
  for (const prim of strokes) {
    const subs = parsePath(prim.d);
    if (subs.length === 1 && !subs[0].closed && subs[0].segs.length) single.set(prim, subs[0]);
  }
  const all: End[] = [];
  for (const [prim, sub] of single) all.push(...endpoints(prim, sub));

  const cell = Math.max(NEAR_FAR, 2);
  const grid = new Map<string, End[]>();
  for (const e of all) {
    const k = `${Math.floor(e.p[0] / cell)},${Math.floor(e.p[1] / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(e);
  }
  const near9 = (p: Pt): End[] => {
    const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
    const out: End[] = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) out.push(...(grid.get(`${gx + i},${gy + j}`) ?? []));
    return out;
  };
  const bestOf = (e: End, absorbedSet: Set<StrokePrimitive>, frozenSet: Set<StrokePrimitive>): End | null => {
    let best: End | null = null, bd = Infinity;
    for (const c of near9(e.p)) {
      if (c.prim === e.prim || absorbedSet.has(c.prim) || frozenSet.has(c.prim)) continue;
      if (!joinOk(e, c)) continue;
      const d = Math.hypot(e.p[0] - c.p[0], e.p[1] - c.p[1]);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  };

  let joined = 0;
  /** 이번 패스에서 더 잇지 않을 획 (좌표가 바뀌어 끝점 정보가 낡았다) */
  const frozen = new Set<StrokePrimitive>();
  const dead = (p: StrokePrimitive) => absorbed.has(p) || frozen.has(p);
  // 상호 최근접만 잇는다 — 한쪽만의 최근접은 세 갈래 교차점을 잘못 삼킬 수 있다
  for (const e of all) {
    if (dead(e.prim)) continue;
    const m = bestOf(e, absorbed, frozen);
    if (!m || bestOf(m, absorbed, frozen) !== e) continue;

    // e.prim 을 살리고 m.prim 을 흡수한다. e 쪽이 tail 이 되도록 뒤집고,
    // m 쪽은 head 가 이어지도록 뒤집는다.
    let keep = single.get(e.prim)!;
    let take = single.get(m.prim)!;
    if (e.side === "head") keep = reverseSub(keep);
    if (m.side === "tail") take = reverseSub(take);
    // 다리: 틈이 있으면 L 로 잇고, 이어서 흡수한 획의 세그를 붙인다
    const gap = Math.hypot(m.p[0] - e.p[0], m.p[1] - e.p[1]);
    if (gap > 0.05) keep.segs.push({ type: "L", end: take.start });
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
    absorbed.add(m.prim);
    single.delete(m.prim);
    joined++;
    // 좌표가 바뀐 끝점 정보는 낡았다 — 보수적으로 이 획의 추가 병합은 다음 기회로
    frozen.add(e.prim);
  }
  return joined;
}
