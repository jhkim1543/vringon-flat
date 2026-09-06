/**
 * VTracer 출력 **재피팅** — 직선 한 줄에 앵커 서른 개가 붙는 것을 고친다.
 *
 * `optimizePathData` 의 병합은 **직선(L) 세그먼트끼리만** 합친다. 그런데 VTracer 는
 * `PathSimplifyMode.Spline` 이라 거의 전부 **곡선(C)** 을 내보낸다(실측: jewelry_2 의 한
 * 패스가 C 69개 · L 0개). 그래서 허용오차를 1.6 → 3.2 로 올려도 앵커가 **한 개도** 안 줄었다.
 *
 * 여기서는 각 서브패스를 폴리라인으로 편 뒤 **Schneider 최소자승 큐빅 피팅**으로 다시
 * 만든다(`fitAdaptive`). 곡률이 완만한 구간은 세그먼트 하나로 합쳐지고, 코너는 각도로
 * 잘라 보존한다. 스플라인 조각을 잇는 것이 아니라 **점들에 새 곡선을 맞추는 것**이라
 * 곡률이 달라도 합쳐진다.
 *
 * 닫힌 서브패스는 시작점이 곧 코너가 되지 않도록 앞뒤를 이어 붙여 다룬다.
 */
import { parsePath, type SubPath, type Pt } from "../vector/pathdata.js";
import { fitAdaptive, fitSingleCubic, segsToPathD } from "../vector/fitCurve.js";

export interface RefitStats {
  anchorsBefore: number;
  anchorsAfter: number;
  subpaths: number;
}

/** 서브패스를 폴리라인으로 편다 — 곡선은 균일 파라미터로 촘촘히 샘플 */
function flatten(sp: SubPath, step: number): Pt[] {
  const pts: Pt[] = [sp.start];
  let cur = sp.start;
  for (const seg of sp.segs) {
    if (seg.type === "L") {
      // **직선도 길이에 비례해 샘플한다.** 끝점만 넣으면 긴 직선의 중간이 비어,
      // 양방향 이탈 측정에서 곡선 쪽 중간점이 "가장 가까운 원본 점"으로 변 절반
      // 거리를 보고한다(실측: 129px 변에서 가짜 이탈 64.5px). 그 가짜 이탈이
      // 멀쩡한 재피팅·솎기를 대량 거부하게 만든다.
      const L = Math.hypot(seg.end[0] - cur[0], seg.end[1] - cur[1]);
      const n = Math.max(1, Math.min(24, Math.ceil(L / step)));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        pts.push([cur[0] + (seg.end[0] - cur[0]) * t, cur[1] + (seg.end[1] - cur[1]) * t]);
      }
      cur = seg.end;
      continue;
    }
    const [x0, y0] = cur, [x1, y1] = seg.c1!, [x2, y2] = seg.c2!, [x3, y3] = seg.end;
    const rough = Math.hypot(x3 - x0, y3 - y0) + Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x3 - x2, y3 - y2);
    const n = Math.max(2, Math.min(24, Math.ceil(rough / step)));
    for (let i = 1; i <= n; i++) {
      const t = i / n, m = 1 - t;
      pts.push([
        m * m * m * x0 + 3 * m * m * t * x1 + 3 * m * t * t * x2 + t * t * t * x3,
        m * m * m * y0 + 3 * m * m * t * y1 + 3 * m * t * t * y2 + t * t * t * y3,
      ]);
    }
    cur = seg.end;
  }
  // 닫힌 경로의 **암시적 닫힘 변**도 편다 — parsePath 는 closed 플래그만 세우고 변을
  // 세그로 넣지 않아서, 여기서 안 펴면 그 변이 모든 비교·피팅에서 투명인간이 된다.
  if (sp.closed) {
    const L = Math.hypot(sp.start[0] - cur[0], sp.start[1] - cur[1]);
    if (L > 0.05) {
      const n = Math.max(1, Math.min(24, Math.ceil(L / step)));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        pts.push([cur[0] + (sp.start[0] - cur[0]) * t, cur[1] + (sp.start[1] - cur[1]) * t]);
      }
    }
  }
  return pts;
}

/** 붙어 있는 중복점 제거 — 피팅기가 0 길이 구간에서 흔들리지 않게 */
function dedupe(pts: Pt[], minGap: number): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = out[out.length - 1];
    if (Math.hypot(pts[i][0] - p[0], pts[i][1] - p[1]) >= minGap) out.push(pts[i]);
  }
  return out;
}

const anchorsIn = (d: string) => (d.match(new RegExp("[MLCQSTA]", "g")) ?? []).length;

/**
 * 허용오차의 몇 배까지 봐줄지 — 이 위는 원본을 유지한다.
 *
 * 8 은 사실상 무제한에 가까웠다(외부 검토 지적). 다만 조이면 재피팅이 거부돼 앵커가
 * 오히려 늘어난다 — 실측으로 정한다. `V4_REFIT_DEV` 로 조절.
 */
const DEV_LIMIT = Number(process.env.V4_REFIT_DEV ?? 4);
/** 이보다 크게 꺾이면 코너로 잘라 보존한다(도) */
const CORNER_TURN = Number(process.env.V4_CORNER ?? 62);
/** 코너 컷 사이 최소 간격 — 허용오차의 배수 */
const CORNER_GAP = Number(process.env.V4_CORNER_GAP ?? 1.6);
/** 더 쪼개지 않는 최소 구간 길이 — 허용오차의 배수 */
const MIN_SPAN = Number(process.env.V4_MIN_SPAN ?? 2.5);

/**
 * 원본 점들과 피팅 곡선 사이의 **양방향** 최대 거리.
 *
 * 한 방향만 재면 곡선이 원본 밖으로 부풀어도 안 걸린다 — 원본 점마다 가까운 곡선점이
 * 있기만 하면 통과하기 때문이다. 실제로 긴 곡선에서 바깥으로 배가 나오는 일이 있었다.
 * 곡선 쪽에서 원본으로도 재야 그 부풂이 드러난다.
 *
 * 샘플 밀도도 올렸다. 조각당 9점으로는 조각이 길 때 점 사이에서 어긋난 것을 통째로
 * 놓친다 — 길이에 비례해 뜬다.
 */
function deviation(pts: Pt[], segs: { p0: Pt; c1: Pt; c2: Pt; p3: Pt }[]): number {
  const samples: Pt[] = [];
  for (const s of segs) {
    const rough = Math.hypot(s.p3[0] - s.p0[0], s.p3[1] - s.p0[1])
      + Math.hypot(s.c1[0] - s.p0[0], s.c1[1] - s.p0[1])
      + Math.hypot(s.p3[0] - s.c2[0], s.p3[1] - s.c2[1]);
    const n = Math.max(8, Math.min(64, Math.ceil(rough / 1.5)));
    for (let i = 0; i <= n; i++) {
      const t = i / n, m = 1 - t;
      samples.push([
        m * m * m * s.p0[0] + 3 * m * m * t * s.c1[0] + 3 * m * t * t * s.c2[0] + t * t * t * s.p3[0],
        m * m * m * s.p0[1] + 3 * m * m * t * s.c1[1] + 3 * m * t * t * s.c2[1] + t * t * t * s.p3[1],
      ]);
    }
  }
  if (!samples.length) return Infinity;

  const oneWay = (src: Pt[], dst: Pt[], stride: number): number => {
    let worst = 0;
    for (let i = 0; i < src.length; i += stride) {
      let best = Infinity;
      for (const q of dst) {
        const dd = (src[i][0] - q[0]) ** 2 + (src[i][1] - q[1]) ** 2;
        if (dd < best) best = dd;
      }
      if (best > worst) worst = best;
    }
    return Math.sqrt(worst);
  };
  const sp = Math.max(1, Math.floor(pts.length / 300));
  const ss = Math.max(1, Math.floor(samples.length / 300));
  // **양쪽 다 본다** — 곡선이 원본을 벗어난 것도, 원본을 못 따라간 것도 잡는다
  return Math.max(oneWay(pts, samples, sp), oneWay(samples, pts, ss));
}

/**
 * `d` 를 다시 피팅한다. 형상이 허용오차 밖으로 벗어나면 원본을 그대로 돌려준다 —
 * 줄이는 것보다 안 망가뜨리는 것이 먼저다.
 *
 * @param baseError 재구성 허용오차(작업 캔버스 px)
 */
export function refitPath(
  d: string,
  baseError: number,
  opts: { devLimit?: number } = {},
): { d: string; stats: RefitStats } {
  const devLimit = opts.devLimit ?? DEV_LIMIT;
  const subs = parsePath(d);
  const before = anchorsIn(d);
  if (!subs.length) return { d, stats: { anchorsBefore: before, anchorsAfter: before, subpaths: 0 } };

  const step = Math.max(0.6, baseError * 0.6);
  const parts: string[] = [];
  for (const sp of subs) {
    // 세그먼트가 몇 개 안 되면 이미 최소 표현이다 — 손대면 형상만 흔들린다
    if (sp.segs.length <= 3) {
      parts.push(segToD(sp));
      continue;
    }
    let pts = dedupe(flatten(sp, step), Math.max(0.35, step * 0.5));
    if (pts.length < 4) { parts.push(segToD(sp)); continue; }

    if (sp.closed) {
      // 닫힌 곡선은 시작점이 인위적 코너가 되지 않게 끝점을 다시 붙인다
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (Math.hypot(first[0] - last[0], first[1] - last[1]) > step) pts.push(first);
    }

    const { segs } = fitAdaptive(pts, {
      baseError,
      // **꺾인각** 기준이다. 예전에는 내각으로 42를 넘겨 138° 이상 되접히는 헤어핀만
      // 잘랐고(실측: 3개 샘플에서 컷 0개), 그래서 교차점 같은 진짜 코너를 매끄러운
      // 큐빅으로 맞추려다 재귀 분할이 폭주해 몇 px 안에 앵커가 뭉쳤다.
      cornerTurnDeg: CORNER_TURN,
      minCornerGapPx: Math.max(2.5, baseError * CORNER_GAP),
      minSpanPx: Math.max(4, baseError * MIN_SPAN),
      // 밀도 때문에 허용오차를 키우지 않는다 — 형상 이탈이 먼저다
      maxAnchorsPerPx: 1e9,
    });
    if (!segs.length) { parts.push(segToD(sp)); continue; }
    const nd = segsToPathD(segs, sp.closed);
    const orig = segToD(sp);

    // **서브패스마다 이탈을 잰다.** 전체 평균이 좋아도 한 조각이 크게 어긋나면 눈에 띈다
    // (실측: 허용오차를 0.6 까지 조여도 shoe_1 의 한 조각이 10px 벗어났다).
    // 넘으면 그 조각만 원본을 쓴다 — 줄이는 것보다 안 망가뜨리는 것이 먼저다.
    if (deviation(pts, segs) > baseError * devLimit) { parts.push(orig); continue; }
    parts.push(anchorsIn(nd) < anchorsIn(orig) ? nd : orig);
  }

  const out = parts.join("");
  const after = anchorsIn(out);
  return { d: out, stats: { anchorsBefore: before, anchorsAfter: after, subpaths: subs.length } };
}

/**
 * **앵커 솎기** — 이웃 두 조각을 하나로 합쳐도 형상이 안 무너지면 사이의 앵커를 뺀다.
 *
 * 재피팅을 마쳐도 직선 위에 앵커가 두셋씩 붙어 있는 자리가 남는다(실측: 5px 미만으로
 * 붙은 1,546곳 중 **516곳이 꺾임 20° 미만**, 즉 직선). 재피팅은 서브패스를 코너에서 자른
 * 뒤 구간마다 따로 맞추기 때문에, 구간 경계에 생긴 앵커는 그 뒤로 아무도 건드리지 않는다.
 *
 * 여기서는 완성된 경로를 다시 훑으며 **합쳐도 되는 곳만** 합친다. 판정은 오직 어긋남이다 —
 * 코너를 따로 지킬 필요가 없다. 진짜 코너를 합치면 어긋남이 커져서 저절로 거부된다.
 */
/**
 * 한 번에 몇 조각까지 묶어 볼지. Potrace 는 상한 없이 전부 보지만, 조각 수가 수천인
 * 패스에서 O(n²) 이 된다. 12 면 직선 구간이 한 조각으로 접히기에 충분하다.
 */
const MERGE_RUN = Number(process.env.V4_MERGE_RUN ?? 12);
/** 이보다 조각이 많은 서브패스는 DP 를 접고 탐욕으로 — 시간이 폭주한다 */
const DP_LIMIT = Number(process.env.V4_DP_LIMIT ?? 3000);

export function thinAnchors(d: string, tol: number): string {
  if (tol <= 0) return d;
  const parts: string[] = [];
  for (const sp of parsePath(d)) {
    let segs = toCubics(sp);
    if (segs.length < 2) { parts.push(segToD(sp)); continue; }
    // **닫힌 곡선의 이음매를 진짜 코너로 옮긴다.** 이음매는 어느 알고리즘도 넘어서
    // 병합하지 못하는 자리라, 매끄러운 곡선 한복판에 있으면 앵커 하나를 그냥 버린다.
    if (sp.closed && segs.length > 2) segs = rotateToSharpest(segs);
    segs = segs.length <= DP_LIMIT ? dpMerge(segs, tol) : greedyMerge(segs, tol);
    parts.push(cubicsToD(segs, sp.closed));
  }
  return parts.join("");
}

/**
 * **전역 최적 병합(Potrace 2.4 의 사상).**
 *
 * 탐욕 병합은 왼쪽부터 되는 대로 합치므로, 한 번 잘못 합치면 그 뒤로 합칠 기회를 잃는다.
 * 여기서는 "조각 i..j 를 큐빅 하나로 바꿀 수 있는가"를 모두 재 놓고, 0→n 최단경로를
 * **(조각 수, 오차 합) 사전식**으로 푼다 — 조각 수가 1차 목표, 오차가 2차 목표다.
 * 같은 허용오차에서 탐욕보다 앵커가 덜 남는다.
 */
function dpMerge(segs: Cub[], tol: number): Cub[] {
  const n = segs.length;
  // 미리 각 조각을 샘플해 둔다 — 구간마다 다시 뜨면 O(n·run²) 이 된다
  const smp: Pt[][] = segs.map((s) => sampleCubic(s, 12));

  const cost = new Float64Array(n + 1).fill(Infinity);
  const count = new Int32Array(n + 1).fill(0x3fffffff);
  const from = new Int32Array(n + 1).fill(-1);
  const fitAt = new Array<Cub | null>(n + 1).fill(null);
  cost[0] = 0; count[0] = 0;

  for (let i = 0; i < n; i++) {
    if (count[i] === 0x3fffffff) continue;
    let pts: Pt[] = [];
    for (let L = 1; L <= MERGE_RUN && i + L <= n; L++) {
      pts = L === 1 ? smp[i].slice() : pts.concat(smp[i + L - 1].slice(1));
      const j = i + L;
      let cand: Cub | null, err: number;
      if (L === 1) { cand = segs[i]; err = 0; }
      else {
        cand = fitSingleCubic(pts);
        if (!cand) break;              // 못 맞추면 더 길게도 못 맞춘다
        err = maxDistTo(pts, cand);
        // **오차가 단조 증가한다고 가정하지 않는다.** 구간을 늘리면 오차가 줄어드는
        // 경우가 실제로 있다 — S 자로 굽은 구간은 반만 덮으면 한쪽으로 치우친 큐빅이
        // 되지만, 굽이를 통째로 덮으면 대칭 큐빅 하나로 잘 맞는다. 여기서 끊으면
        // 그 더 나은 해를 영영 못 본다. 넘는 길이는 **건너뛰고 계속 본다.**
        if (err > tol) continue;
      }
      const c = count[i] + 1, e = cost[i] + err;
      if (c < count[j] || (c === count[j] && e < cost[j])) {
        count[j] = c; cost[j] = e; from[j] = i; fitAt[j] = cand;
      }
    }
  }
  if (from[n] < 0) return greedyMerge(segs, tol);

  const out: Cub[] = [];
  for (let j = n; j > 0; j = from[j]) out.push(fitAt[j]!);
  return out.reverse();
}

/** 예전 방식 — 조각이 너무 많아 DP 를 못 돌릴 때의 대비책 */
function greedyMerge(segs: Cub[], tol: number): Cub[] {
  let cur = segs;
  let pass = true;
  while (pass) {
    pass = false;
    for (let i = 0; i + 1 < cur.length; i++) {
      const pts = [...sampleCubic(cur[i], 12), ...sampleCubic(cur[i + 1], 12).slice(1)];
      const merged = fitSingleCubic(pts);
      if (!merged || maxDistTo(pts, merged) > tol) continue;
      cur.splice(i, 2, merged);
      pass = true;
    }
  }
  return cur;
}

/** 조각 경계마다 접선이 얼마나 꺾이는지 재서, 가장 많이 꺾인 자리를 시작점으로 돌린다 */
function rotateToSharpest(segs: Cub[]): Cub[] {
  const dirIn = (s: Cub): Pt => {
    const dx = s.p3[0] - s.c2[0], dy = s.p3[1] - s.c2[1];
    if (Math.hypot(dx, dy) > 1e-9) return [dx, dy];
    return [s.p3[0] - s.p0[0], s.p3[1] - s.p0[1]];
  };
  const dirOut = (s: Cub): Pt => {
    const dx = s.c1[0] - s.p0[0], dy = s.c1[1] - s.p0[1];
    if (Math.hypot(dx, dy) > 1e-9) return [dx, dy];
    return [s.p3[0] - s.p0[0], s.p3[1] - s.p0[1]];
  };
  let bestK = 0, bestTurn = -1;
  for (let k = 0; k < segs.length; k++) {
    const a = dirIn(segs[(k - 1 + segs.length) % segs.length]), b = dirOut(segs[k]);
    const na = Math.hypot(a[0], a[1]), nb = Math.hypot(b[0], b[1]);
    if (na < 1e-9 || nb < 1e-9) continue;
    const turn = 1 - (a[0] * b[0] + a[1] * b[1]) / (na * nb);   // 0 = 곧음 · 2 = 되접힘
    if (turn > bestTurn) { bestTurn = turn; bestK = k; }
  }
  return bestK ? [...segs.slice(bestK), ...segs.slice(0, bestK)] : segs;
}

interface Cub { p0: Pt; c1: Pt; c2: Pt; p3: Pt }

function toCubics(sp: SubPath): Cub[] {
  const out: Cub[] = [];
  let cur = sp.start;
  for (const seg of sp.segs) {
    if (seg.type === "L") {
      const d: Pt = [seg.end[0] - cur[0], seg.end[1] - cur[1]];
      out.push({
        p0: cur,
        c1: [cur[0] + d[0] / 3, cur[1] + d[1] / 3],
        c2: [cur[0] + (d[0] * 2) / 3, cur[1] + (d[1] * 2) / 3],
        p3: seg.end,
      });
    } else {
      out.push({ p0: cur, c1: seg.c1!, c2: seg.c2!, p3: seg.end });
    }
    cur = seg.end;
  }
  // **Z 의 암시적 닫힘 변을 명시한다.** parsePath 는 closed 플래그만 세우고 변을
  // 세그로 넣지 않는다 — 그대로 회전(rotateToSharpest)하면 그 변이 사라져 경로가
  // 찢어진다(실측: L 사각형에서 재현). 길이가 있으면 직선 큐빅으로 채운다.
  if (sp.closed && out.length) {
    const last = out[out.length - 1].p3;
    const gap = Math.hypot(sp.start[0] - last[0], sp.start[1] - last[1]);
    if (gap > 0.05) {
      const d: Pt = [sp.start[0] - last[0], sp.start[1] - last[1]];
      out.push({
        p0: last,
        c1: [last[0] + d[0] / 3, last[1] + d[1] / 3],
        c2: [last[0] + (d[0] * 2) / 3, last[1] + (d[1] * 2) / 3],
        p3: sp.start,
      });
    }
  }
  return out;
}

function sampleCubic(s: Cub, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, m = 1 - t;
    out.push([
      m * m * m * s.p0[0] + 3 * m * m * t * s.c1[0] + 3 * m * t * t * s.c2[0] + t * t * t * s.p3[0],
      m * m * m * s.p0[1] + 3 * m * m * t * s.c1[1] + 3 * m * t * t * s.c2[1] + t * t * t * s.p3[1],
    ]);
  }
  return out;
}

function maxDistTo(pts: Pt[], s: Cub): number {
  const smp = sampleCubic(s, 40);
  let worst = 0;
  for (const p of pts) {
    let best = Infinity;
    for (const q of smp) {
      const dd = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      if (dd < best) best = dd;
    }
    if (best > worst) worst = best;
  }
  return Math.sqrt(worst);
}

function cubicsToD(segs: Cub[], closed: boolean): string {
  const f = (v: number) => {
    const r = Math.round(v * 100) / 100;
    return Object.is(r, -0) ? "0" : String(r);
  };
  let s = `M${f(segs[0].p0[0])} ${f(segs[0].p0[1])}`;
  for (const c of segs) s += `C${f(c.c1[0])} ${f(c.c1[1])} ${f(c.c2[0])} ${f(c.c2[1])} ${f(c.p3[0])} ${f(c.p3[1])}`;
  return closed ? s + "Z" : s;
}

/** `d` 를 폴리라인으로 편다 — 두 경로를 비교하기 위한 공통 표현 */
function toPolyline(d: string, step: number): Pt[] {
  const out: Pt[] = [];
  for (const sp of parsePath(d)) out.push(...flatten(sp, step));
  return out;
}

/**
 * 두 경로 사이의 최대 어긋남(px). 한쪽 점들이 다른 쪽 폴리라인에서 얼마나 멀어지는지를
 * 양방향으로 본다 — 한 방향만 보면 한쪽이 다른 쪽을 완전히 덮을 때 0 이 나온다.
 */
export function pathDeviation(a: string, b: string, step = 0.4): number {
  const pa = toPolyline(a, step), pb = toPolyline(b, step);
  if (!pa.length || !pb.length) return Infinity;
  const oneWay = (src: Pt[], dst: Pt[]) => {
    let worst = 0;
    const stride = Math.max(1, Math.floor(src.length / 300));
    for (let i = 0; i < src.length; i += stride) {
      let best = Infinity;
      for (const q of dst) {
        const dd = (src[i][0] - q[0]) ** 2 + (src[i][1] - q[1]) ** 2;
        if (dd < best) best = dd;
      }
      if (best > worst) worst = best;
    }
    return Math.sqrt(worst);
  };
  return Math.max(oneWay(pa, pb), oneWay(pb, pa));
}

/** SubPath 하나를 d 문자열로 (원본 보존용) */
function segToD(sp: SubPath): string {
  const f = (v: number) => Math.round(v * 100) / 100;
  let s = `M${f(sp.start[0])} ${f(sp.start[1])}`;
  for (const seg of sp.segs) {
    if (seg.type === "L") s += `L${f(seg.end[0])} ${f(seg.end[1])}`;
    else s += `C${f(seg.c1![0])} ${f(seg.c1![1])} ${f(seg.c2![0])} ${f(seg.c2![1])} ${f(seg.end[0])} ${f(seg.end[1])}`;
  }
  return sp.closed ? s + "Z" : s;
}

/**
 * **길이 0 에 가까운 조각을 뺀다.**
 *
 * 제자리로 돌아오는 큐빅은 그림에 아무것도 더하지 않으면서 앵커만 하나 늘린다.
 * Illustrator 에서는 겹친 점으로 보여, 디자이너가 손으로 골라 지워야 한다.
 *
 * 끝점이 시작점과 같아도 **제어점이 멀리 나가 있으면 진짜 고리**다(잎사귀 모양 등).
 * 그건 남긴다 — 판정은 조각 전체가 한 점 안에 들어오느냐로 한다.
 */
export function dropDegenerate(d: string, eps = 0.05): { d: string; removed: number } {
  let removed = 0;
  const parts: string[] = [];
  for (const sp of parsePath(d)) {
    const segs = toCubics(sp);
    const kept = segs.filter((s) => {
      const xs = [s.p0[0], s.c1[0], s.c2[0], s.p3[0]];
      const ys = [s.p0[1], s.c1[1], s.c2[1], s.p3[1]];
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      if (span > eps) return true;
      removed++;
      return false;
    });
    if (!kept.length) { parts.push(segToD(sp)); continue; }
    // 조각을 빼면 이음매가 벌어진다 — 앞 조각의 끝을 다음 조각의 시작에 맞춘다
    for (let i = 1; i < kept.length; i++) kept[i].p0 = kept[i - 1].p3;
    parts.push(cubicsToD(kept, sp.closed));
  }
  return { d: parts.join(""), removed };
}

/**
 * **선 굵기를 등급으로 양자화한다.**
 *
 * 도식화의 선 굵기는 재현이 아니라 재할당이다. 외곽 > 구조 > 스티치의 **위계**가 있어야
 * 하고, 같은 뜻의 선은 같은 값이어야 한다. 사진에서 잰 굵기는 조명·초점을 반영해 값이
 * 수십 개로 흩어지고, 그러면 디자이너가 "선 굵기를 일괄로 바꾼다"를 못 한다.
 *
 * 1차원 k-means 로 등급 중심을 찾는다. **길이로 가중한다** — 짧은 토막 수백 개가 긴
 * 외곽선 하나를 밀어내면 안 되기 때문이다. 등급 수는 서로 다른 값의 개수를 넘지 않는다.
 *
 * @param items 굵기와 길이(가중치)
 * @param k     원하는 등급 수
 * @returns 등급 중심값들 (오름차순)
 */
export function widthGrades(items: { width: number; weight: number }[], k: number): number[] {
  const vals = items.filter((x) => x.width > 0 && x.weight > 0);
  if (!vals.length || k < 1) return [];
  const uniq = [...new Set(vals.map((v) => +v.width.toFixed(2)))].sort((a, b) => a - b);
  if (uniq.length <= k) return uniq;

  // 초기 중심 — 가중 분위수. 무작위 초기화는 실행마다 결과가 달라져 쓸 수 없다
  // (실무자는 같은 입력에 같은 출력이 아니면 워크플로에 안 넣는다).
  const sorted = [...vals].sort((a, b) => a.width - b.width);
  const total = sorted.reduce((a, c) => a + c.weight, 0);
  let centers: number[] = [];
  {
    let acc = 0, next = 1;
    for (const v of sorted) {
      acc += v.weight;
      while (next <= k && acc >= (total * (2 * next - 1)) / (2 * k)) { centers.push(v.width); next++; }
    }
    while (centers.length < k) centers.push(sorted[sorted.length - 1].width);
    centers = [...new Set(centers)];
  }

  for (let iter = 0; iter < 30; iter++) {
    const sum = new Float64Array(centers.length);
    const wsum = new Float64Array(centers.length);
    for (const v of sorted) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = Math.abs(v.width - centers[c]);
        if (d < bd) { bd = d; best = c; }
      }
      sum[best] += v.width * v.weight;
      wsum[best] += v.weight;
    }
    let moved = 0;
    for (let c = 0; c < centers.length; c++) {
      if (!wsum[c]) continue;
      const nv = sum[c] / wsum[c];
      moved = Math.max(moved, Math.abs(nv - centers[c]));
      centers[c] = nv;
    }
    if (moved < 0.01) break;
  }
  return [...new Set(centers.map((c) => Math.max(0.1, +c.toFixed(2))))].sort((a, b) => a - b);
}

/** 값에 가장 가까운 등급 */
export function snapGrade(w: number, grades: number[]): number {
  if (!grades.length) return w;
  let best = grades[0], bd = Infinity;
  for (const g of grades) {
    const d = Math.abs(w - g);
    if (d < bd) { bd = d; best = g; }
  }
  return best;
}

/**
 * **앵커 간격 하한** — 한 선 위에서 이보다 가까운 앵커 쌍은 병합을 시도한다.
 *
 * 오차 기준 솎기만으로는 "선 굵기보다 가까운 앵커"가 남는다(실측 s_jewelry_1: 26%).
 * 굵은 선 위에서 그런 앵커는 점끼리 겹쳐 보여서 하나를 집기 어렵다. 여기서는 간격이
 * 하한 미만인 세그먼트를 이웃과 강제로 합쳐 보되, **이탈 검증은 그대로 둔다** —
 * 진짜 코너는 합치면 이탈이 커져 저절로 살아남는다. 없애는 것은 겹침이지 코너가 아니다.
 */
export function enforceAnchorSpacing(d: string, minGap: number, tol: number): string {
  if (minGap <= 0 || tol <= 0) return d;
  const parts: string[] = [];
  for (const sp of parsePath(d)) {
    const segs = toCubics(sp);
    if (segs.length < 2) { parts.push(segToD(sp)); continue; }
    // 못 합친 세그를 표시해 두고 넘어간다 — 하나가 막혔다고 나머지를 포기하면 안 된다
    const blocked = new Set<Cub>();
    let guard = segs.length * 3;
    while (guard-- > 0) {
      let si = -1, sl = Infinity;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (blocked.has(s)) continue;
        const L = Math.hypot(s.p3[0] - s.p0[0], s.p3[1] - s.p0[1]);
        if (L < minGap && L < sl) { sl = L; si = i; }
      }
      if (si < 0) break;
      const tryMerge = (i: number): { seg: Cub; dev: number } | null => {
        if (i < 0 || i + 1 >= segs.length) return null;
        const pts = [...sampleCubic(segs[i], 12), ...sampleCubic(segs[i + 1], 12).slice(1)];
        const m = fitSingleCubic(pts);
        if (!m) return null;
        const dev = maxDistTo(pts, m);
        return dev <= tol ? { seg: m, dev } : null;
      };
      const left = tryMerge(si - 1);
      const right = tryMerge(si);
      const pick = left && right ? (left.dev <= right.dev ? "L" : "R") : left ? "L" : right ? "R" : null;
      if (!pick) { blocked.add(segs[si]); continue; }   // 코너 사이 — 필요한 앵커다
      if (pick === "L") segs.splice(si - 1, 2, left!.seg);
      else segs.splice(si, 2, right!.seg);
    }
    parts.push(cubicsToD(segs, sp.closed));
  }
  return parts.join("");
}

/**
 * **직선 구간 앵커 병합.** 사실상 곧게 뻗은 구간은 앵커가 양끝 둘이면 충분한데,
 * 추적된 중심선의 미세한 흔들림이 DP 허용오차를 넘겨 중간 앵커를 줄줄이 남긴다.
 * 여기서는 질문을 바꾼다 — "곡선을 얼마나 잘 근사하나"가 아니라 "이 구간이
 * 직선인가". 연속 세그들의 표본점 전부가 구간 현(chord)에서 straightTol 안이면
 * 그 흔들림은 노이즈로 보고 현 하나로 편다. 코너·실곡선은 현에서 벗어나므로 남는다.
 */
export function mergeStraightRuns(d: string, straightTol: number): string {
  if (straightTol <= 0) return d;
  const distToChord = (p: Pt, a: Pt, b: Pt): number => {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const L2 = vx * vx + vy * vy;
    if (L2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2));
    return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
  };
  const lineCubic = (a: Pt, b: Pt): Cub => ({
    p0: a,
    c1: [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3],
    c2: [a[0] + (2 * (b[0] - a[0])) / 3, a[1] + (2 * (b[1] - a[1])) / 3],
    p3: b,
  });
  const parts: string[] = [];
  for (const sp of parsePath(d)) {
    const segs = toCubics(sp);
    if (segs.length < 2) { parts.push(segToD(sp)); continue; }
    const out: Cub[] = [];
    let i = 0;
    while (i < segs.length) {
      // i 에서 시작하는 최장 직선 run 을 찾는다
      let j = i;
      let pts: Pt[] = sampleCubic(segs[i], 10);
      while (j + 1 < segs.length) {
        const cand = [...pts, ...sampleCubic(segs[j + 1], 10).slice(1)];
        const a = cand[0], b = cand[cand.length - 1];
        let ok = true;
        for (const p of cand) if (distToChord(p, a, b) > straightTol) { ok = false; break; }
        if (!ok) break;
        pts = cand;
        j++;
      }
      if (j > i) {
        // run 자체도 직선이어야 한다 (첫 세그만으로 시작한 run 은 위에서 이미 검사됨
        // — 단 run 이 안 자란 경우 첫 세그는 검사 없이 통과하므로 여기서 가른다)
        out.push(lineCubic(segs[i].p0, segs[j].p3));
        i = j + 1;
      } else {
        // 세그 하나짜리도 직선이면 컨트롤 포인트를 현 위로 정돈한다 (앵커 수는 그대로,
        // 파일 크기·핸들 정리 효과) — 아니면 원본 유지
        const one = sampleCubic(segs[i], 10);
        const straight = one.every((p) => distToChord(p, one[0], one[one.length - 1]) <= straightTol);
        out.push(straight ? lineCubic(segs[i].p0, segs[i].p3) : segs[i]);
        i++;
      }
    }
    parts.push(cubicsToD(out, sp.closed));
  }
  return parts.join("");
}
