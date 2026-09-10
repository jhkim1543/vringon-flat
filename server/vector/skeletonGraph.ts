import type { Pt } from "./pathdata.js";

/** One adjacency rule for degree, traversal and pruning. A diagonal is redundant
 * when the two pixels already meet through an occupied cardinal neighbour.
 * Counting crossings but walking raw eight-neighbours creates false junctions. */
export function skeletonNeighbors(mask: Uint8Array, W: number, H: number, i: number): number[] {
  const x = i % W, y = Math.floor(i / W), out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= H || !mask[yy * W + xx]) continue;
    if (dx && dy && (mask[y * W + xx] || mask[yy * W + x])) continue;
    out.push(yy * W + xx);
  }
  return out;
}

/** Every graph edge is consumed exactly once; junction pixels belong to all
 * incident paths. Closed rings include their start as their final point. */
export function traceSkeletonChains(mask: Uint8Array, W: number, H: number): Pt[][] {
  const N = W * H, graph = new Map<number, number[]>();
  for (let i = 0; i < N; i++) if (mask[i]) graph.set(i, skeletonNeighbors(mask, W, H, i));
  const used = new Set<number>(), out: Pt[][] = [];
  const key = (a: number, b: number) => Math.min(a, b) * N + Math.max(a, b);
  const point = (i: number): Pt => [i % W, Math.floor(i / W)];
  const walk = (start: number, next: number) => {
    const pts = [point(start)];
    let prev = start, cur = next;
    used.add(key(prev, cur));
    while (true) {
      pts.push(point(cur));
      const nb = graph.get(cur)!;
      if (cur === start || nb.length !== 2) break;
      const n = nb[0] === prev ? nb[1] : nb[0];
      if (used.has(key(cur, n))) break;
      used.add(key(cur, n)); prev = cur; cur = n;
    }
    out.push(pts);
  };
  for (const [i, nb] of graph) if (nb.length !== 2) {
    for (const n of nb) if (!used.has(key(i, n))) walk(i, n);
  }
  for (const [i, nb] of graph) for (const n of nb) if (!used.has(key(i, n))) walk(i, n);
  return out;
}

/** Prune only true leaf-to-junction chains, and never delete the junction. */
export function pruneSkeletonSpurs(mask: Uint8Array, W: number, H: number, dist: Float32Array, factor: number) {
  const skel = Uint8Array.from(mask); let pruned = 0;
  if (!(factor > 0)) return { skel, pruned };
  for (let pass = 0; pass < 3; pass++) {
    const remove = new Set<number>();
    for (let pts of traceSkeletonChains(skel, W, H)) {
      const id = (p: Pt) => p[1] * W + p[0];
      const da = skeletonNeighbors(skel, W, H, id(pts[0])).length;
      const db = skeletonNeighbors(skel, W, H, id(pts.at(-1)!)).length;
      if (da >= 3 && db === 1) pts = [...pts].reverse();
      else if (!(da === 1 && db >= 3)) continue;
      let length = 0;
      for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i-1][0], pts[i][1] - pts[i-1][1]);
      const body = pts.slice(0, -1);
      const widths = body.map(p => dist[id(p)] * 2).filter(x => x > 0 && Number.isFinite(x)).sort((a,b) => a-b);
      const width = widths.length ? widths[widths.length >> 1] : 1;
      if (length > Math.max(3, factor * width)) continue;
      for (const p of body) remove.add(id(p));
      pruned++;
    }
    if (!remove.size) break;
    for (const i of remove) skel[i] = 0;
  }
  return { skel, pruned };
}
