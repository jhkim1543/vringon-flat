/**
 * **겹선·티끌 정리** — 진짜 선 옆에 나란히 붙은 짧은 찌꺼기를 지운다.
 *
 * 실측(v7.4 9종): 앵커의 12.7% 가 길이 20px 미만 조각 1,065개에 있었다. 그려 보면 대부분
 * **이미 있는 선을 따라 나란히 놓인 짧은 대시**다 — 도면 선의 가장자리 halo 나 이중 추적이
 * 남긴 것으로, 사람 눈에는 "선이 지저분하다"로 보인다. 스티치 눈금·글자·아일렛 같은 진짜
 * 짧은 선은 **남의 선과 나란하지 않다**(직교하거나 혼자 닫혀 있다). 그래서 자는 하나다:
 *
 *   짧은 획의 표본 90% 이상이, 더 긴 다른 획의 표본과 **굵기 안 거리**에 있고 **접선이 나란**하면 겹선.
 *
 * 티끌은 따로: 12px 미만이고 어느 획에도 닿지 않은 조각. 점(아일렛 구멍)은 기하 프리미티브로
 * 이미 빠져 있어 여기 걸리지 않는다. DASH_OR_STITCH 는 손대지 않는다 — 점선은 원래 짧은 조각의 열이다.
 */
import { parsePath, type Pt } from "../vector/pathdata.js";
import type { ScenePrimitive, StrokePrimitive } from "./types.js";

/** 이 길이 미만인 획만 겹선 후보 (px) */
const SHORT_MAX = Number(process.env.V4_PRUNE_SHORT ?? 80);
/**
 * 티끌 — 이 길이 미만이고 고립. **기본 끔(0).** 실측 shoe_1: 고립 조각 9개 중 셋이 QA 의
 * "작은 디테일"(도면의 작은 잉크 덩어리)이라 회수율 0.94 → 0.81 로 게이트가 깨졌다.
 * 티끌과 작은 디테일은 기하로는 못 가른다 — 앵커 이득도 작아 끈다.
 */
const SPECK_MAX = Number(process.env.V4_PRUNE_SPECK ?? 0);
/**
 * 거리 허용 (px) — **주인 선의 반폭 + 이 값.** 주인 선이 실제로 덮는 띠 안에 있을 때만 겹선이다.
 * 굵기 합의 0.8배(≈3~5px)로 잡았더니 선 옆의 별개 잉크(스티치 점·작은 디테일)까지 삼켰다.
 */
const TOL_PAD = Number(process.env.V4_PRUNE_TOL ?? 1.0);
const TOL_MIN = 1.5;
/** 접선 나란함 |cos| 하한 */
const PARALLEL = Number(process.env.V4_PRUNE_COS ?? 0.85);
/** 표본 중 이 비율 이상이 겹쳐야 겹선 */
const COVER = Number(process.env.V4_PRUNE_COVER ?? 0.9);
const STEP = 2;
const NEAR = 6;

interface Sampled {
  prim: StrokePrimitive;
  pts: Pt[];
  tan: Pt[];
  length: number;
  width: number;
}

function sample(prim: StrokePrimitive): Sampled {
  const pts: Pt[] = [];
  let length = 0;
  for (const sub of parsePath(prim.d)) {
    let cur = sub.start;
    pts.push(cur);
    for (const s of sub.segs) {
      if (s.type === "L") {
        const L = Math.hypot(s.end[0] - cur[0], s.end[1] - cur[1]);
        length += L;
        const n = Math.max(1, Math.ceil(L / STEP));
        for (let i = 1; i <= n; i++) pts.push([cur[0] + (s.end[0] - cur[0]) * i / n, cur[1] + (s.end[1] - cur[1]) * i / n]);
      } else {
        const rough = Math.hypot(s.end[0] - cur[0], s.end[1] - cur[1]) + Math.hypot(s.c1![0] - cur[0], s.c1![1] - cur[1]);
        const n = Math.max(2, Math.min(96, Math.ceil(rough / STEP)));
        let prev = cur;
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          const p: Pt = [
            u * u * u * cur[0] + 3 * u * u * t * s.c1![0] + 3 * u * t * t * s.c2![0] + t * t * t * s.end[0],
            u * u * u * cur[1] + 3 * u * u * t * s.c1![1] + 3 * u * t * t * s.c2![1] + t * t * t * s.end[1],
          ];
          length += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
          pts.push(p); prev = p;
        }
      }
      cur = s.end;
    }
    if (sub.closed) { length += Math.hypot(sub.start[0] - cur[0], sub.start[1] - cur[1]); pts.push(sub.start); }
  }
  const tan: Pt[] = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy) || 1;
    return [dx / n, dy / n];
  });
  return { prim, pts, tan, length, width: prim.qaWidth ?? prim.width };
}

export interface PruneReport { duplicates: number; specks: number; anchorsRemoved: number }

const anchorCount = (d: string) => (d.match(/[MLC]/g) ?? []).length;

export function pruneDuplicateStrokes(primitives: ScenePrimitive[], say?: (m: string) => void): PruneReport {
  const strokes = primitives
    .filter((p): p is StrokePrimitive => p.cls === "STRUCTURAL_STROKE")
    .map(sample);
  const CELL = 4;
  const grid = new Map<string, [number, number][]>();
  strokes.forEach((s, si) => s.pts.forEach((p, pi) => {
    const k = `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push([si, pi]);
  }));
  const near = (p: Pt, r: number, skip: number, accept: (s: Sampled, pi: number, d: number) => boolean): boolean => {
    const gx = Math.floor(p[0] / CELL), gy = Math.floor(p[1] / CELL), reach = Math.ceil(r / CELL);
    for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++) {
      for (const [si, pi] of grid.get(`${gx + i},${gy + j}`) ?? []) {
        if (si === skip) continue;
        const q = strokes[si].pts[pi];
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d <= r && accept(strokes[si], pi, d)) return true;
      }
    }
    return false;
  };

  const drop = new Set<StrokePrimitive>();
  let duplicates = 0, specks = 0, anchorsRemoved = 0;
  strokes.forEach((s, si) => {
    if (s.length >= SHORT_MAX) return;
    // ── 겹선: 표본 대부분이 더 긴 획의 굵기 안에서 나란히 ──
    let hit = 0;
    for (let pi = 0; pi < s.pts.length; pi++) {
      const t = s.tan[pi];
      const ok = near(s.pts[pi], 8, si, (o, opi, d) => {
        if (o.length <= s.length) return false;                       // 더 긴 획만 주인이 된다
        if (d > Math.max(TOL_MIN, 0.5 * o.width + TOL_PAD)) return false; // 주인 선의 띠 안
        const u = o.tan[opi];
        return Math.abs(t[0] * u[0] + t[1] * u[1]) >= PARALLEL;
      });
      if (ok) hit++;
    }
    if (hit >= s.pts.length * COVER) { drop.add(s.prim); duplicates++; return; }
    // ── 티끌: 아주 짧고 어느 획에도 닿지 않는다 ──
    if (SPECK_MAX > 0 && s.length < SPECK_MAX) {
      const a = s.pts[0], b = s.pts[s.pts.length - 1];
      const touched = near(a, NEAR, si, () => true) || near(b, NEAR, si, () => true);
      if (!touched) { drop.add(s.prim); specks++; }
    }
  });
  if (drop.size) {
    for (const p of drop) anchorsRemoved += anchorCount(p.d);
    for (let i = primitives.length - 1; i >= 0; i--) if (drop.has(primitives[i] as StrokePrimitive)) primitives.splice(i, 1);
    say?.(`겹선·티끌 정리 — 나란한 겹선 ${duplicates}개 · 고립 티끌 ${specks}개 제거 (앵커 −${anchorsRemoved})`);
  }
  return { duplicates, specks, anchorsRemoved };
}
