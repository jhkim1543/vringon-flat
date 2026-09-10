/**
 * 같은 골격에 **예전 추적기(v7.7)** 와 **새 추적기(v7.9)** 를 붙여 체인 수를 비교한다.
 * `npx tsx server/v4/tools/tracerreal.ts <골격.png>`
 *
 * 예전 함수들은 v7.7 커밋에서 그대로 떠 왔다 — 다시 구현하면 비교가 성립하지 않는다.
 */
import sharp from "sharp";
import { traceSkeletonChains } from "../../vector/skeletonGraph.js";
type Pt = [number, number];

const N8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

function neighbors(skel: Uint8Array, W: number, H: number, x: number, y: number): number[] {
  const out: number[] = [];
  for (const [dx, dy] of N8) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    if (skel[ny * W + nx]) out.push(ny * W + nx);
  }
  return out;
}

function crossingNumber(skel: Uint8Array, W: number, H: number, x: number, y: number): number {
  const at = (dx: number, dy: number) => {
    const nx = x + dx, ny = y + dy;
    return nx < 0 || ny < 0 || nx >= W || ny >= H ? 0 : skel[ny * W + nx];
  };
  // 시계방향 8-이웃 순환
  const ring = [
    at(0, -1), at(1, -1), at(1, 0), at(1, 1),
    at(0, 1), at(-1, 1), at(-1, 0), at(-1, -1),
  ];
  let t = 0;
  for (let i = 0; i < 8; i++) if (ring[i] === 0 && ring[(i + 1) % 8] === 1) t++;
  return t;
}

function pickNext(skel: Uint8Array, W: number, H: number, cur: number, prev: number): number {
  const cx = cur % W, cy = (cur / W) | 0;
  const px = prev % W, py = (prev / W) | 0;
  const cand = neighbors(skel, W, H, cx, cy).filter((n) => n !== prev);
  if (!cand.length) return -1;
  const notAdjToPrev = cand.filter((n) => {
    const nx = n % W, ny = (n / W) | 0;
    return Math.abs(nx - px) > 1 || Math.abs(ny - py) > 1;
  });
  const pool = notAdjToPrev.length ? notAdjToPrev : cand;
  // 직진에 가까운 이웃 우선
  const dx = cx - px, dy = cy - py;
  let best = pool[0], bestScore = -Infinity;
  for (const n of pool) {
    const nx = n % W - cx, ny = ((n / W) | 0) - cy;
    const score = nx * dx + ny * dy;
    if (score > bestScore) { bestScore = score; best = n; }
  }
  return best;
}

function traceChains(skel: Uint8Array, W: number, H: number): Pt[][] {
  const degree = new Uint8Array(W * H);
  const nodes: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!skel[i]) continue;
      const nb = neighbors(skel, W, H, x, y).length;
      // 고립점은 버리고, 나머지는 교차수로 분기 판정
      const d = nb === 0 ? 0 : nb === 1 ? 1 : crossingNumber(skel, W, H, x, y);
      degree[i] = d;
      if (d !== 2) nodes.push(i);
    }
  }

  const usedEdge = new Set<string>();
  const chains: Pt[][] = [];
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);

  // 1) 끝점/분기점에서 출발하는 체인
  for (const start of nodes) {
    const sx = start % W, sy = (start / W) | 0;
    for (const next of neighbors(skel, W, H, sx, sy)) {
      if (usedEdge.has(key(start, next))) continue;
      const chain: Pt[] = [[sx, sy]];
      let prev = start, cur = next;
      usedEdge.add(key(prev, cur));
      for (;;) {
        chain.push([cur % W, (cur / W) | 0]);
        if (degree[cur] !== 2) break;
        const nxt = pickNext(skel, W, H, cur, prev);
        if (nxt < 0) break;
        if (usedEdge.has(key(cur, nxt))) break;
        usedEdge.add(key(cur, nxt));
        prev = cur;
        cur = nxt;
      }
      chains.push(chain);
    }
  }

  // 2) 남은 닫힌 고리 (분기점이 없는 순환)
  const visited = new Uint8Array(W * H);
  for (const c of chains) for (const [x, y] of c) visited[y * W + x] = 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!skel[i] || visited[i]) continue;
      const chain: Pt[] = [];
      let cur = i, prev = -1;
      for (;;) {
        visited[cur] = 1;
        chain.push([cur % W, (cur / W) | 0]);
        const nb = neighbors(skel, W, H, cur % W, (cur / W) | 0).filter(
          (n) => n !== prev && (!visited[n] || n === i),
        );
        if (!nb.length) break;
        if (nb[0] === i) { chain.push([i % W, (i / W) | 0]); break; }
        prev = cur;
        cur = nb[0];
      }
      if (chain.length > 3) chains.push(chain);
    }
  }
  return chains;
}

const file = process.argv[2];
if (!file) { console.error("사용: tracerreal <골격.png>"); process.exit(2); }
const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;
const skel = new Uint8Array(W * H);
let px = 0;
for (let i = 0; i < W * H; i++) if (data[i] > 127) { skel[i] = 1; px++; }

const oldChains = traceChains(skel, W, H);
const newChains = traceSkeletonChains(skel, W, H);
const len = (c: Pt[]) => { let n = 0; for (let i = 1; i < c.length; i++) n += Math.hypot(c[i][0]-c[i-1][0], c[i][1]-c[i-1][1]); return n; };
const stat = (cs: Pt[][]) => {
  const ls = cs.map(len).sort((a, b) => a - b);
  const tot = ls.reduce((a, b) => a + b, 0);
  return { n: cs.length, med: ls[ls.length >> 1] ?? 0, tot, tiny: ls.filter((x) => x < 3).length };
};
const o = stat(oldChains), n2 = stat(newChains);
console.log(`골격 픽셀 ${px}`);
console.log(`  v7.7 예전 추적기: 체인 ${o.n} · 길이중앙 ${o.med.toFixed(1)}px · 총길이 ${o.tot.toFixed(0)} · 3px미만 ${o.tiny}`);
console.log(`  v7.9 새  추적기: 체인 ${n2.n} · 길이중앙 ${n2.med.toFixed(1)}px · 총길이 ${n2.tot.toFixed(0)} · 3px미만 ${n2.tiny}`);
console.log(`  → 체인 수 ${(n2.n / Math.max(1, o.n)).toFixed(2)}배 · 총길이 비 ${(n2.tot / Math.max(1, o.tot)).toFixed(3)}`);
