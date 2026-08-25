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
import { fitAdaptive, segsToPathD } from "../vector/fitCurve.js";

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
      pts.push(seg.end);
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

/** 허용오차의 몇 배까지 봐줄지 — 이 위는 원본을 유지한다 */
const DEV_LIMIT = Number(process.env.V4_REFIT_DEV ?? 8);

/** 원본 점들이 피팅 곡선에서 벗어난 최대 거리 */
function deviation(pts: Pt[], segs: { p0: Pt; c1: Pt; c2: Pt; p3: Pt }[]): number {
  const samples: Pt[] = [];
  for (const s of segs) {
    for (let i = 0; i <= 8; i++) {
      const t = i / 8, m = 1 - t;
      samples.push([
        m * m * m * s.p0[0] + 3 * m * m * t * s.c1[0] + 3 * m * t * t * s.c2[0] + t * t * t * s.p3[0],
        m * m * m * s.p0[1] + 3 * m * m * t * s.c1[1] + 3 * m * t * t * s.c2[1] + t * t * t * s.p3[1],
      ]);
    }
  }
  if (!samples.length) return Infinity;
  let worst = 0;
  const stride = Math.max(1, Math.floor(pts.length / 200));
  for (let i = 0; i < pts.length; i += stride) {
    let best = Infinity;
    for (const q of samples) {
      const dd = (pts[i][0] - q[0]) ** 2 + (pts[i][1] - q[1]) ** 2;
      if (dd < best) best = dd;
    }
    if (best > worst) worst = best;
  }
  return Math.sqrt(worst);
}

/**
 * `d` 를 다시 피팅한다. 형상이 허용오차 밖으로 벗어나면 원본을 그대로 돌려준다 —
 * 줄이는 것보다 안 망가뜨리는 것이 먼저다.
 *
 * @param baseError 재구성 허용오차(작업 캔버스 px)
 */
export function refitPath(d: string, baseError: number): { d: string; stats: RefitStats } {
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
      cornerAngleDeg: 42,
      // 밀도 때문에 허용오차를 키우지 않는다 — 형상 이탈이 먼저다
      maxAnchorsPerPx: 1e9,
    });
    if (!segs.length) { parts.push(segToD(sp)); continue; }
    const nd = segsToPathD(segs, sp.closed);
    const orig = segToD(sp);

    // **서브패스마다 이탈을 잰다.** 전체 평균이 좋아도 한 조각이 크게 어긋나면 눈에 띈다
    // (실측: 허용오차를 0.6 까지 조여도 shoe_1 의 한 조각이 10px 벗어났다).
    // 넘으면 그 조각만 원본을 쓴다 — 줄이는 것보다 안 망가뜨리는 것이 먼저다.
    if (deviation(pts, segs) > baseError * DEV_LIMIT) { parts.push(orig); continue; }
    parts.push(anchorsIn(nd) < anchorsIn(orig) ? nd : orig);
  }

  const out = parts.join("");
  const after = anchorsIn(out);
  return { d: out, stats: { anchorsBefore: before, anchorsAfter: after, subpaths: subs.length } };
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
