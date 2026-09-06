/**
 * 열린 스트로크 병합 — **접합부에서 곧게 이어지는 체인끼리 한 패스로 잇는다.**
 *
 * 골격 추적은 접합부마다 체인을 끊는다. 끊긴 자리마다 앵커가 **두 개**(끝 하나, 다음
 * 획의 시작 하나) 박히고, 앵커 솎기는 서브패스 안에서만 도므로 그 둘을 영영 못 없앤다.
 * 실측(s_footwear_03): 전체 앵커 1,636 중 획 시작 545 + 획 끝 545 = **67% 가 끝점**이었다.
 * 사용자가 "같은 실선인데 앵커가 모여 있다"고 지적한 자리가 정확히 이것이다.
 *
 * **짝짓기는 서로가 서로의 최선일 때만 한다.** 먼저 찾은 것과 잇는 탐욕 방식은 세 갈래
 * 접합부에서 엉뚱한 팔과 이어 붙인다 — 한 번 잘못 이으면 남은 팔은 영영 짝을 잃는다.
 * 상호 최선(mutual best) 짝짓기는 X 교차에서 마주 보는 두 팔이 자동으로 짝이 된다.
 *
 * **이을 거리는 선 굵기에 비례한다.** 접합부의 틈은 선이 굵을수록 넓다 — 절대 픽셀
 * 문턱(3px)으로는 굵은 윤곽선의 끊김을 못 잡는다.
 *
 * 굵기가 크게 다른 체인은 잇지 않는다 — 굵은 윤곽과 가는 디테일이 한 패스가 되면
 * stroke-width 하나로 둘 다 틀린 값이 된다.
 */
import { parsePath, type Pt, type SubPath } from "../vector/pathdata.js";

export interface OpenStroke {
  d: string;
  width: number;
  /**
   * 어느 부품의 획인가. 병합 시 **긴 쪽이 대표**하고, 짧은 쪽 부품은 `shared` 로 남긴다 —
   * 파트 경계를 넘어 이은 획이 어느 레이어에 갈지는 긴 쪽이 정하되, 경계를 걸쳤다는
   * 사실은 지운다고 없어지지 않으므로 기록한다.
   */
  partId?: string;
  shared?: string[];
}

interface Chain {
  /** 큐빅 목록 [P0,c1,c2,P3][] — 항상 열린 경로 */
  segs: { p0: Pt; c1: Pt; c2: Pt; p3: Pt }[];
  width: number;
  len: number;
  partId?: string;
  shared?: string[];
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function toChain(sp: SubPath, width: number, partId?: string, shared?: string[]): Chain {
  const segs: Chain["segs"] = [];
  let cur = sp.start;
  let len = 0;
  for (const s of sp.segs) {
    const c1 = s.type === "L" ? [cur[0] + (s.end[0] - cur[0]) / 3, cur[1] + (s.end[1] - cur[1]) / 3] as Pt : s.c1!;
    const c2 = s.type === "L" ? [cur[0] + (s.end[0] - cur[0]) * 2 / 3, cur[1] + (s.end[1] - cur[1]) * 2 / 3] as Pt : s.c2!;
    segs.push({ p0: cur, c1, c2, p3: s.end });
    len += dist(cur, s.end);
    cur = s.end;
  }
  return { segs, width, len, partId, shared };
}

function reversed(c: Chain): Chain {
  return {
    ...c,
    segs: [...c.segs].reverse().map((s) => ({ p0: s.p3, c1: s.c2, c2: s.c1, p3: s.p0 })),
  };
}

const start = (c: Chain) => c.segs[0].p0;
const end = (c: Chain) => c.segs[c.segs.length - 1].p3;
/** 끝에서 나가는 방향 (단위벡터) */
function outDir(c: Chain, atEnd: boolean): Pt {
  const s = atEnd ? c.segs[c.segs.length - 1] : c.segs[0];
  const [a, b] = atEnd ? [s.c2, s.p3] : [s.c1, s.p0];
  let dx = b[0] - a[0], dy = b[1] - a[1];
  if (Math.hypot(dx, dy) < 1e-6) {
    const [a2, b2] = atEnd ? [s.p0, s.p3] : [s.p3, s.p0];
    dx = b2[0] - a2[0]; dy = b2[1] - a2[1];
  }
  const n = Math.hypot(dx, dy) || 1;
  return [dx / n, dy / n];
}

export function mergeOpenStrokes(
  strokes: OpenStroke[],
  opts: { joinDist?: number; maxTurnDeg?: number; maxWidthRatio?: number; widthFactor?: number } = {},
): OpenStroke[] {
  const joinBase = opts.joinDist ?? 3;
  const widthFactor = opts.widthFactor ?? 1.2;
  const cosMin = Math.cos(((opts.maxTurnDeg ?? 55) * Math.PI) / 180);
  const widthRatio = opts.maxWidthRatio ?? 2.2;

  const chains: (Chain | null)[] = [];
  const passthrough: OpenStroke[] = [];
  for (const s of strokes) {
    const subs = parsePath(s.d);
    // 닫힌 경로·다중 서브패스는 그대로 둔다 — 병합 대상은 열린 단일 체인뿐
    if (subs.length !== 1 || subs[0].closed || !subs[0].segs.length) {
      passthrough.push(s);
      continue;
    }
    chains.push(toChain(subs[0], s.width, s.partId, s.shared));
  }

  /** 끝점 하나 — (체인 번호, 끝인가 앞인가) */
  interface Node { ci: number; atEnd: boolean; p: Pt; d: Pt; w: number }

  const buildNodes = (): Node[] => {
    const out: Node[] = [];
    for (let ci = 0; ci < chains.length; ci++) {
      const c = chains[ci];
      if (!c) continue;
      out.push({ ci, atEnd: false, p: start(c), d: outDir(c, false), w: c.width });
      out.push({ ci, atEnd: true, p: end(c), d: outDir(c, true), w: c.width });
    }
    return out;
  };

  for (let round = 0; round < 12; round++) {
    const nodes = buildNodes();
    if (nodes.length < 2) break;

    // 공간 격자 — 전수 비교는 체인이 수백 개일 때 못 쓴다
    const reach = Math.max(joinBase, ...nodes.map((n) => joinBase + n.w * widthFactor));
    const cell = Math.max(2, reach);
    const grid = new Map<string, Node[]>();
    for (const n of nodes) {
      const k = `${Math.floor(n.p[0] / cell)},${Math.floor(n.p[1] / cell)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(n);
    }

    /** a 에서 b 로 이을 수 있으면 비용(작을수록 좋음), 못 이으면 null */
    const cost = (a: Node, b: Node): number | null => {
      if (a.ci === b.ci) return null;                       // 자기 자신과는 안 잇는다
      const gap = dist(a.p, b.p);
      const lim = joinBase + Math.min(a.w, b.w) * widthFactor;
      if (gap > lim) return null;
      const wr = Math.max(a.w, b.w) / Math.max(0.5, Math.min(a.w, b.w));
      if (wr > widthRatio) return null;
      // a 가 나가는 방향과 b 가 나가는 방향은 서로 반대여야 한 줄이 된다
      const dot = a.d[0] * -b.d[0] + a.d[1] * -b.d[1];
      if (dot < cosMin) return null;
      // 접선 정렬이 1차 목표, 틈이 2차
      return (1 - dot) * 100 + gap;
    };

    const best = new Map<Node, { to: Node; c: number }>();
    for (const a of nodes) {
      const gx = Math.floor(a.p[0] / cell), gy = Math.floor(a.p[1] / cell);
      let bt: { to: Node; c: number } | null = null;
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          for (const b of grid.get(`${gx + i},${gy + j}`) ?? []) {
            const c = cost(a, b);
            if (c === null) continue;
            if (!bt || c < bt.c) bt = { to: b, c };
          }
        }
      }
      if (bt) best.set(a, bt);
    }

    // **서로가 서로의 최선인 쌍만** 잇는다
    let joined = 0;
    const touched = new Set<number>();
    for (const [a, ba] of best) {
      const b = ba.to;
      if (best.get(b)?.to !== a) continue;
      if (touched.has(a.ci) || touched.has(b.ci)) continue;
      const ca = chains[a.ci], cb = chains[b.ci];
      if (!ca || !cb) continue;

      const left = a.atEnd ? ca : reversed(ca);
      const right = b.atEnd ? reversed(cb) : cb;
      const gap = dist(end(left), start(right));
      const segs = [...left.segs];
      if (gap > 0.01) {
        const p0 = end(left), p3 = start(right);
        segs.push({
          p0,
          c1: [p0[0] + (p3[0] - p0[0]) / 3, p0[1] + (p3[1] - p0[1]) / 3],
          c2: [p0[0] + (p3[0] - p0[0]) * 2 / 3, p0[1] + (p3[1] - p0[1]) * 2 / 3],
          p3,
        });
      }
      segs.push(...right.segs);
      const longer = ca.len >= cb.len ? ca : cb;
      const shorter = ca.len >= cb.len ? cb : ca;
      const sharedSet = new Set([...(ca.shared ?? []), ...(cb.shared ?? [])]);
      if (shorter.partId && shorter.partId !== longer.partId) sharedSet.add(shorter.partId);
      chains[a.ci] = {
        segs,
        width: (ca.width * ca.len + cb.width * cb.len) / Math.max(1, ca.len + cb.len),
        len: ca.len + cb.len + gap,
        partId: longer.partId,
        shared: sharedSet.size ? [...sharedSet] : undefined,
      };
      chains[b.ci] = null;
      touched.add(a.ci); touched.add(b.ci);
      joined++;
    }
    if (!joined) break;
  }

  const f = (v: number) => Math.round(v * 100) / 100;
  const out: OpenStroke[] = [...passthrough];
  for (const c of chains) {
    if (!c) continue;
    let d = `M${f(c.segs[0].p0[0])} ${f(c.segs[0].p0[1])}`;
    for (const s of c.segs) {
      d += `C${f(s.c1[0])} ${f(s.c1[1])} ${f(s.c2[0])} ${f(s.c2[1])} ${f(s.p3[0])} ${f(s.p3[1])}`;
    }
    out.push({
      d, width: Math.max(1, Math.round(c.width * 10) / 10),
      partId: c.partId, shared: c.shared,
    });
  }
  return out;
}
