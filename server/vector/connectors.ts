/**
 * **다단 연결선 보호** — 구조선 사이를 여러 조각이 이어 달릴 때 중간 조각까지 지킨다.
 *
 * 지금까지 짧은 체인은 "긴 체인의 끝점에 직접 닿는가"로만 지켰다. 긴 선 A와 B 사이를
 * 짧은 조각 셋(s1·s2·s3)이 이어 달리면 A에 닿는 s1과 B에 닿는 s3만 지켜지고 **중간 s2 가
 * 질감으로 지워진다** — 그러면 A와 B는 결국 끊긴 채 남는다(외부 리뷰 v0.6 의 지적).
 *
 * 자는 하나다: 짧은 체인들을 그래프로 보고(정점 = 골격 노드 픽셀, 간선 = 짧은 체인),
 * **구조선 접점 사이의 경로에 놓인 간선을 전부 지킨다.**
 *
 * 구현은 block-cut tree 다. 이단연결 성분(블록)마다 트리 노드를 만들고, 구조선 접점이
 * 있는 정점을 단말로 두고, 단말이 아닌 잎을 반복해서 쳐낸다. 남은 블록의 간선이 답이다.
 * 트리에서 단말들을 잇는 최소 부분트리가 곧 "단말 사이 경로의 합집합"이라 이 방식이 정확하다.
 *
 * **대체 경로가 있는 블록은 통째로 남긴다** — 고리처럼 두 갈래로 갈 수 있는 자리에서
 * 한쪽을 임의로 고르면 도면에 없는 선택을 우리가 하는 것이 된다.
 *
 * 좌표가 가깝다는 이유로 잇지 않는다. 끝점은 `traceChains` 가 쓰는 골격 노드 픽셀 번호
 * 그대로이고, 두 체인이 한 접합부에서 만나면 그 픽셀 번호가 같다.
 */

export interface ConnectorEdge {
  /** 호출자가 준 식별자 — 보통 chains 배열의 인덱스 */
  id: number;
  /** 양 끝 정점 (골격 노드 픽셀 번호). u === v 이면 자기고리 */
  u: number;
  v: number;
}

export interface ConnectorResult {
  /** 구조선 접점 사이 경로에 놓여 반드시 지켜야 하는 간선 id */
  required: Set<number>;
  /** 지킬 이유를 못 찾은 간선 수 — 지운다는 뜻이 아니라 판단하지 않았다는 뜻 */
  unclassified: number;
  /** 자기고리 (양 끝이 같은 정점) */
  selfLoops: number;
}

/**
 * 짧은 체인 중 구조선 접점 사이의 경로에 놓인 것을 고른다.
 * 판정만 한다 — 여기서 아무것도 지우지 않는다.
 */
export function requiredConnectors(edges: ConnectorEdge[], anchors: Set<number>): ConnectorResult {
  // ── 인접 리스트 (자기고리 제외) ────────────────────────────
  const adj = new Map<number, { to: number; id: number }[]>();
  let selfLoops = 0;
  const push = (a: number, b: number, id: number) => {
    const l = adj.get(a);
    if (l) l.push({ to: b, id });
    else adj.set(a, [{ to: b, id }]);
  };
  for (const e of edges) {
    if (e.u === e.v) { selfLoops++; continue; }
    push(e.u, e.v, e.id);
    push(e.v, e.u, e.id);
  }
  if (!adj.size) return { required: new Set(), unclassified: edges.length - selfLoops, selfLoops };

  // ── 이단연결 성분 (Hopcroft–Tarjan, 반복판) ────────────────
  // 재귀는 쓰지 않는다 — 메시 가방의 짧은 체인은 수천 개라 스택이 넘친다.
  const disc = new Map<number, number>();
  const low = new Map<number, number>();
  const parentEdge = new Map<number, number>();
  const edgeStack: number[] = [];
  /** 블록마다 그 안의 간선 id */
  const blockEdges: number[][] = [];
  /** 블록마다 그 안의 정점 */
  const blockVerts: Set<number>[] = [];
  const edgeById = new Map<number, ConnectorEdge>();
  for (const e of edges) edgeById.set(e.id, e);
  let timer = 0;

  const closeBlock = (until: number): void => {
    const ids: number[] = [];
    const verts = new Set<number>();
    for (;;) {
      const id = edgeStack.pop();
      if (id === undefined) break;
      ids.push(id);
      const e = edgeById.get(id)!;
      verts.add(e.u); verts.add(e.v);
      if (id === until) break;
    }
    if (ids.length) { blockEdges.push(ids); blockVerts.push(verts); }
  };

  for (const root of adj.keys()) {
    if (disc.has(root)) continue;
    // 반복 DFS — 정점마다 "다음에 볼 이웃 위치"를 들고 다닌다
    const stack: { v: number; i: number }[] = [{ v: root, i: 0 }];
    disc.set(root, timer); low.set(root, timer); timer++;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const nbrs = adj.get(top.v)!;
      if (top.i < nbrs.length) {
        const { to, id } = nbrs[top.i++];
        if (id === parentEdge.get(top.v)) continue;          // 부모 간선으로 되돌아가지 않는다
        const dTo = disc.get(to);
        if (dTo === undefined) {
          edgeStack.push(id);
          parentEdge.set(to, id);
          disc.set(to, timer); low.set(to, timer); timer++;
          stack.push({ v: to, i: 0 });
        } else if (dTo < disc.get(top.v)!) {
          edgeStack.push(id);                                 // 역방향 간선
          if (dTo < low.get(top.v)!) low.set(top.v, dTo);
        }
      } else {
        stack.pop();
        const parent = stack.length ? stack[stack.length - 1].v : -1;
        if (parent >= 0) {
          const lv = low.get(top.v)!;
          if (lv < low.get(parent)!) low.set(parent, lv);
          // parent 가 절단점이면 여기까지가 한 블록
          if (lv >= disc.get(parent)!) closeBlock(parentEdge.get(top.v)!);
        }
      }
    }
    closeBlock(-1);                                           // 뿌리에 남은 것
  }

  // ── block-cut tree ────────────────────────────────────────
  // 노드: 블록 b_i, 정점 v. 블록과 그 안의 정점을 잇는다. 이 그래프는 숲이다.
  const B = blockEdges.length;
  const nodeOfVert = new Map<number, number>();                // 정점 → 트리 노드 번호(B 이상)
  let nextNode = B;
  const treeAdj = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    (treeAdj.get(a) ?? treeAdj.set(a, []).get(a)!).push(b);
    (treeAdj.get(b) ?? treeAdj.set(b, []).get(b)!).push(a);
  };
  for (let i = 0; i < B; i++) {
    for (const v of blockVerts[i]) {
      let n = nodeOfVert.get(v);
      if (n === undefined) { n = nextNode++; nodeOfVert.set(v, n); }
      link(i, n);
    }
  }

  // 단말: 구조선 접점을 가진 정점 노드
  const terminals = new Set<number>();
  for (const a of anchors) {
    const n = nodeOfVert.get(a);
    if (n !== undefined) terminals.add(n);
  }
  // 단말이 둘 미만이면 "사이 경로"가 성립하지 않는다 — 아무것도 요구하지 않는다
  if (terminals.size < 2) {
    return { required: new Set(), unclassified: edges.length - selfLoops, selfLoops };
  }

  // 단말이 아닌 잎을 반복해서 쳐낸다 → 남는 것이 단말들을 잇는 최소 부분트리
  const deg = new Map<number, number>();
  for (const [n, l] of treeAdj) deg.set(n, l.length);
  const alive = new Set<number>(treeAdj.keys());
  const queue: number[] = [];
  for (const [n, d] of deg) if (d <= 1 && !terminals.has(n)) queue.push(n);
  while (queue.length) {
    const n = queue.pop()!;
    if (!alive.has(n) || terminals.has(n) || (deg.get(n) ?? 0) > 1) continue;
    alive.delete(n);
    for (const m of treeAdj.get(n) ?? []) {
      if (!alive.has(m)) continue;
      const d = (deg.get(m) ?? 1) - 1;
      deg.set(m, d);
      if (d <= 1 && !terminals.has(m)) queue.push(m);
    }
  }

  const required = new Set<number>();
  for (let i = 0; i < B; i++) if (alive.has(i)) for (const id of blockEdges[i]) required.add(id);
  return { required, unclassified: edges.length - selfLoops - required.size, selfLoops };
}
