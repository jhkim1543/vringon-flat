/**
 * **대시 캐리어 변환** — 일렬로 늘어선 짧은 획(스티치 점선)을
 * "캐리어 패스 1개 + stroke-dasharray" 로 접는다.
 *
 * 실측(s_bag_10): 획 912개 중 719개가 대시꼴이고 그 앵커가 1,453개 — 전체의 48%다.
 * 실무 규범도 이쪽이다: 스티치는 낱개 선분 무더기가 아니라 **단일 패스 + 점선 속성**
 * (심사에서 테크니컬 디자이너·풋웨어 디자이너가 같은 요구를 했다). 즉 이 변환은
 * 앵커 절감이면서 동시에 표현 교정이다.
 *
 * 구슬 군집이 실패한 이유(형상 대체 — 하나하나 다른 모양을 대표로 덮어씀)와 다르다:
 * 여기서 대시의 **위치는 캐리어가 그대로 지나가고**, 바뀌는 것은 잘림(위상)뿐이다.
 * 그래도 위상이 밀리면 그림이 달라지므로, 간격이 고르지 않은 줄은 접지 않는다.
 *
 * `V4_DASH_CARRIER=0` 으로 끈다.
 */
import { parsePath, type Pt } from "../vector/pathdata.js";
import { fitAdaptive, segsToPathD } from "../vector/fitCurve.js";
import { thinAnchors } from "./refit.js";

export interface DashItem {
  d: string;
  width: number;
  partId?: string;
  shared?: string[];
}

export interface DashChain {
  /** 캐리어 패스 */
  d: string;
  width: number;
  /** SVG stroke-dasharray ("대시 간격") */
  dashArray: string;
  partId?: string;
  shared?: string[];
  members: number[];
  anchorsBefore: number;
  carrierAnchors: number;
}

interface Dash {
  idx: number;
  a: Pt;              // 시작
  b: Pt;              // 끝
  mid: Pt;
  dir: Pt;            // 단위 방향 (a→b)
  len: number;
  width: number;
  anchors: number;
}

const dist = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);

function toDash(d: string, idx: number, width: number): Dash | null {
  const subs = parsePath(d);
  if (subs.length !== 1 || subs[0].closed || !subs[0].segs.length) return null;
  const sp = subs[0];
  const a = sp.start;
  const b = sp.segs[sp.segs.length - 1].end;
  let len = 0;
  let cur = a;
  for (const s of sp.segs) { len += dist(cur, s.end); cur = s.end; }
  const chord = dist(a, b);
  if (len > 45 || sp.segs.length > 3) return null;
  if (chord < 3) return null;
  if (chord / Math.max(1e-6, len) < 0.88) return null;   // 굽은 조각은 대시가 아니다
  const dir: Pt = [(b[0] - a[0]) / chord, (b[1] - a[1]) / chord];
  return {
    idx, a, b, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
    dir, len, width, anchors: sp.segs.length + 1,
  };
}

/**
 * 대시들을 줄로 엮는다.
 *
 * 판정 셋 — 전부 통과해야 이웃이다:
 *   틈    끝→다음 시작 거리 ≤ 대시 길이 × 2.5 (스티치 간격은 대시보다 크게 벌지 않는다)
 *   방향  두 대시 방향 정렬 cos ≥ 0.86 (곡선 스티치는 조금씩 돈다)
 *   옆줄  다음 대시 시작이 이 대시의 연장선에서 max(2.5, 굵기) 이상 벗어나면 다른 줄
 */
export function buildDashChains(items: DashItem[]): DashChain[] {
  if (process.env.V4_DASH_CARRIER === "0") return [];
  // 문턱 노브 — 실측 스윕용. 기본값이 정본이다.
  const GAPF = Number(process.env.DC_GAPF ?? 2.5);
  const COS = Number(process.env.DC_COS ?? 0.86);
  const LATF = Number(process.env.DC_LATF ?? 1.0);
  const UNI = Number(process.env.DC_UNI ?? 1.0);   // 균일성 완화 배수 (1=현행)
  const dashes: Dash[] = [];
  for (let i = 0; i < items.length; i++) {
    const dd = toDash(items[i].d, i, items[i].width);
    if (dd) dashes.push(dd);
  }
  if (dashes.length < 4) return [];

  // 공간 격자 — 끝점 근방의 후보만 본다
  const CELL = 64;
  const grid = new Map<string, Dash[]>();
  for (const d of dashes) {
    const k = `${Math.floor(d.mid[0] / CELL)},${Math.floor(d.mid[1] / CELL)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(d);
  }
  const near = (p: Pt): Dash[] => {
    const gx = Math.floor(p[0] / CELL), gy = Math.floor(p[1] / CELL);
    const out: Dash[] = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      out.push(...(grid.get(`${gx + i},${gy + j}`) ?? []));
    }
    return out;
  };

  /** d 의 progressing 끝(b)에서 다음 대시를 찾는다 — 못 찾으면 null */
  const nextOf = (d: Dash, used: Set<number>): { n: Dash; flip: boolean } | null => {
    let best: { n: Dash; flip: boolean; gap: number } | null = null;
    for (const c of near(d.b)) {
      if (c.idx === d.idx || used.has(c.idx)) continue;
      const wr = Math.max(d.width, c.width) / Math.max(0.5, Math.min(d.width, c.width));
      if (wr > 1.6) continue;
      for (const flip of [false, true]) {
        const start = flip ? c.b : c.a;
        const dir = flip ? ([-c.dir[0], -c.dir[1]] as Pt) : c.dir;
        const gap = dist(d.b, start);
        if (gap > Math.max(6, d.len * GAPF)) continue;
        const cos = d.dir[0] * dir[0] + d.dir[1] * dir[1];
        if (cos < COS) continue;
        // 옆줄 검사: start 가 d 의 연장선에서 얼마나 벗어나나
        const vx = start[0] - d.b[0], vy = start[1] - d.b[1];
        const lateral = Math.abs(vx * -d.dir[1] + vy * d.dir[0]);
        if (lateral > Math.max(2.5, d.width) * LATF) continue;
        const forward = vx * d.dir[0] + vy * d.dir[1];
        if (forward < -1) continue;                    // 뒤로 가는 건 이웃이 아니다
        if (!best || gap < best.gap) best = { n: c, flip, gap };
      }
    }
    return best ? { n: best.n, flip: best.flip } : null;
  };

  const used = new Set<number>();
  const out: DashChain[] = [];

  for (const seed of dashes) {
    if (used.has(seed.idx)) continue;
    // 양쪽으로 자란다 — seed 에서 앞으로, 그리고 seed 를 뒤집어 뒤로
    const grow = (start: Dash): Dash[] => {
      const chain: Dash[] = [start];
      const local = new Set<number>([...used, start.idx]);
      let cur = start;
      for (;;) {
        const nx = nextOf(cur, local);
        if (!nx) break;
        const d = nx.flip
          ? { ...nx.n, a: nx.n.b, b: nx.n.a, dir: [-nx.n.dir[0], -nx.n.dir[1]] as Pt }
          : nx.n;
        chain.push(d);
        local.add(d.idx);
        cur = d;
      }
      return chain;
    };
    const fwd = grow(seed);
    const back = grow({ ...seed, a: seed.b, b: seed.a, dir: [-seed.dir[0], -seed.dir[1]] });
    // back 은 seed 포함이므로 뒤집어 붙이되 seed 중복 제거
    const revBack = back.slice(1).reverse().map((d) => ({ ...d, a: d.b, b: d.a, dir: [-d.dir[0], -d.dir[1]] as Pt }));
    const chain = [...revBack, ...fwd];
    if (chain.length < 4) continue;

    // **간격 균일성** — dasharray 는 균일 반복이다. 고르지 않으면 위상이 밀려 그림이
    // 달라진다. 대시 길이와 틈의 산포(사분위)로 판정한다.
    const lens = chain.map((d) => d.len).sort((x, y) => x - y);
    const gaps: number[] = [];
    for (let i = 1; i < chain.length; i++) gaps.push(dist(chain[i - 1].b, chain[i].a));
    const sg = [...gaps].sort((x, y) => x - y);
    const q = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
    const lenMed = q(lens, 0.5), gapMed = q(sg, 0.5);
    if (gapMed < 1) continue;
    if (q(lens, 0.9) > lenMed * 1.7 * UNI || q(lens, 0.1) < lenMed * 0.5 / UNI) continue;
    if (q(sg, 0.9) > gapMed * 1.8 * UNI || q(sg, 0.1) < gapMed * 0.45 / UNI) continue;

    // 캐리어: 대시 끝점들을 이어 피팅
    const pts: Pt[] = [];
    for (const d of chain) { pts.push(d.a, d.b); }
    const { segs } = fitAdaptive(pts, { baseError: 1.2, cornerTurnDeg: 62 });
    if (!segs.length) continue;
    const carrier = thinAnchors(segsToPathD(segs, false), 0.8);
    const carrierAnchors = (carrier.match(/[MLC]/g) ?? []).length;
    const anchorsBefore = chain.reduce((a, d) => a + d.anchors, 0);
    if (carrierAnchors + 2 >= anchorsBefore) continue;   // 이득이 없으면 그대로 둔다

    const width = chain.reduce((a, d) => a + d.width, 0) / chain.length;
    for (const d of chain) used.add(d.idx);
    const r1 = (v: number) => Math.round(v * 10) / 10;
    out.push({
      d: carrier,
      width,
      dashArray: `${r1(lenMed)} ${r1(gapMed)}`,
      partId: items[chain[0].idx].partId,
      shared: undefined,
      members: chain.map((d) => d.idx),
      anchorsBefore,
      carrierAnchors,
    });
  }
  return out;
}
