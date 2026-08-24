/**
 * 반복 패턴 압축 — 비즈·메시·체인·천공을 모티프 하나 + 배치 목록으로.
 *
 * 도면에서 패스가 폭증하는 자리는 대부분 **같은 모양이 수백 번 반복되는 곳**이다.
 * 실측: 비즈 메시 가방(bag_2)은 3,537패스 중 대부분이 비즈 하나하나였고, 파일이 1.6MB였다.
 * 그것을 개별 패스로 저장하면 편집이 불가능하다 — 비즈 크기를 바꾸려면 2,500개를 손대야 한다.
 *
 * 모티프 하나를 `<symbol>` 로 정의하고 `<use>` 로 배치하면 하나만 고치면 된다.
 *
 * **압축률만 보고하면 안 된다.** 인스턴스는 원본 각각의 근사이므로 충실도가 떨어진다.
 * 이 모듈은 압축 결과와 함께 대체된 성분들의 **형상 편차**를 돌려주고, 호출부가
 * 충실도를 실측해 채택 여부를 정한다.
 */
import type { Pt } from "./types.js";
import type { ComponentEvidence } from "./evidence.js";

export interface MotifCluster {
  /** 대표 모티프 (모티프 로컬 좌표, 좌상단 0,0) */
  motif: string;
  motifSize: [number, number];
  /** 이 군집에 속한 성분들 */
  members: ComponentEvidence[];
  instances: { x: number; y: number; scale: number; rotate: number }[];
  /** 대표와 각 구성원의 형상 거리 (0=동일) */
  shapeDeviation: { mean: number; max: number };
  /** 개별 패스 대비 절감 */
  pathsSaved: number;
}

export interface PatternOptions {
  /** 군집 최소 구성원 수 — 이보다 적으면 압축 이득이 없다 */
  minMembers: number;
  /** 형상 서술자 거리 임계 (0~1) */
  shapeTolerance: number;
  /** 크기 비율 허용 (1.25 = ±25%) */
  sizeTolerance: number;
  /** 이 면적을 넘는 성분은 모티프 후보가 아니다 (작업 캔버스 대비 비율) */
  maxAreaShare: number;
  /** 군집의 평균 형상 편차가 이보다 크면 압축하지 않는다 — 닮은 것과 같은 것은 다르다 */
  maxMeanDeviation: number;
}

/**
 * 임계는 **충실도 손실을 실측하고** 정했다. 헐거우면 닮았을 뿐 같지 않은 것까지 묶여
 * 디테일이 사라진다 — 0.18/1.35/12 로 뒀을 때 신발 도면의 작은 성분 보존율이 1.00 → 0.75,
 * 구멍이 317 → 271 로 떨어졌다. 압축은 **정말 같은 것**에만 건다.
 */
export const DEFAULT_PATTERN_OPTIONS: PatternOptions = {
  minMembers: 20,
  shapeTolerance: 0.07,
  sizeTolerance: 1.18,
  maxAreaShare: 0.004,
  maxMeanDeviation: 0.05,
};

const PROFILE_BINS = 24;

/**
 * 회전 불변 형상 서술자.
 * 중심에서 윤곽까지의 거리를 각도별로 재고 최대값으로 정규화한 뒤 **정렬**한다.
 * 정렬하면 회전에 불변이 되고, 비즈처럼 방향이 제각각인 모티프도 같은 군집으로 묶인다.
 */
function descriptor(c: ComponentEvidence): number[] {
  const pts = c.contour;
  if (pts.length < 4) return new Array(PROFILE_BINS).fill(0);
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;

  const bins = new Array(PROFILE_BINS).fill(0);
  const counts = new Array(PROFILE_BINS).fill(0);
  for (const p of pts) {
    const a = Math.atan2(p.y - cy, p.x - cx);
    const b = Math.min(PROFILE_BINS - 1, Math.floor(((a + Math.PI) / (2 * Math.PI)) * PROFILE_BINS));
    bins[b] += Math.hypot(p.x - cx, p.y - cy);
    counts[b]++;
  }
  for (let i = 0; i < PROFILE_BINS; i++) bins[i] = counts[i] ? bins[i] / counts[i] : 0;
  const mx = Math.max(...bins) || 1;
  return bins.map((v) => v / mx).sort((a, b) => a - b);
}

function descDistance(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** 성분의 마스크를 모티프 로컬 좌표의 폴리곤 패스로 (윤곽 그대로) */
function motifPath(c: ComponentEvidence): string {
  const [x0, y0] = c.bbox;
  const pts = c.contour;
  if (pts.length < 3) return "";
  const f = (v: number) => Math.round(v * 10) / 10;
  let d = `M ${f(pts[0].x - x0)} ${f(pts[0].y - y0)}`;
  for (let i = 1; i < pts.length; i++) d += ` L ${f(pts[i].x - x0)} ${f(pts[i].y - y0)}`;
  return d + " Z";
}

/**
 * 반복 모티프를 찾는다.
 *
 * 후보는 **작은 성분**뿐이다. 큰 구조선은 아무리 닮아도 모티프로 묶으면 안 된다 —
 * 도면의 정체성이 사라진다.
 */
export function findPatterns(
  comps: ComponentEvidence[],
  canvasArea: number,
  opts: Partial<PatternOptions> = {},
): MotifCluster[] {
  const o = { ...DEFAULT_PATTERN_OPTIONS, ...opts };
  const cand = comps.filter((c) => c.area <= canvasArea * o.maxAreaShare && c.contour.length >= 6);
  if (cand.length < o.minMembers) return [];

  const descs = cand.map(descriptor);
  const sizes = cand.map((c) => Math.sqrt(c.area));
  const used = new Uint8Array(cand.length);
  const clusters: MotifCluster[] = [];

  // 큰 것부터 씨앗으로 삼는다 — 대표가 작으면 디테일이 뭉개진다
  const order = cand.map((_, i) => i).sort((a, b) => cand[b].area - cand[a].area);

  for (const seed of order) {
    if (used[seed]) continue;
    const members: number[] = [];
    for (let i = 0; i < cand.length; i++) {
      if (used[i]) continue;
      const ratio = Math.max(sizes[i], sizes[seed]) / Math.max(1e-6, Math.min(sizes[i], sizes[seed]));
      if (ratio > o.sizeTolerance) continue;
      if (descDistance(descs[seed], descs[i]) > o.shapeTolerance) continue;
      members.push(i);
    }
    if (members.length < o.minMembers) continue;
    for (const i of members) used[i] = 1;

    // 대표 = 군집 중앙 크기에 가장 가까운 것
    const ms = members.map((i) => sizes[i]).sort((a, b) => a - b);
    const med = ms[ms.length >> 1];
    let rep = members[0];
    for (const i of members) if (Math.abs(sizes[i] - med) < Math.abs(sizes[rep] - med)) rep = i;

    const repC = cand[rep];
    const rw = repC.bbox[2] - repC.bbox[0] + 1;
    const rh = repC.bbox[3] - repC.bbox[1] + 1;

    let devSum = 0, devMax = 0;
    const instances = members.map((i) => {
      const c = cand[i];
      const w = c.bbox[2] - c.bbox[0] + 1;
      const h = c.bbox[3] - c.bbox[1] + 1;
      const scale = (w / rw + h / rh) / 2;
      const dev = descDistance(descs[rep], descs[i]);
      devSum += dev;
      if (dev > devMax) devMax = dev;
      return {
        x: +(c.bbox[0] - (rw * scale - w) / 2).toFixed(1),
        y: +(c.bbox[1] - (rh * scale - h) / 2).toFixed(1),
        scale: +scale.toFixed(3),
        rotate: 0,
      };
    });

    clusters.push({
      motif: motifPath(repC),
      motifSize: [rw, rh],
      members: members.map((i) => cand[i]),
      instances,
      shapeDeviation: { mean: +(devSum / members.length).toFixed(4), max: +devMax.toFixed(4) },
      pathsSaved: members.length - 1,
    });
  }

  // 형상 편차가 큰 군집은 버린다. 압축률보다 "같은 것만 묶는다"가 먼저다.
  return clusters
    .filter((c) => c.shapeDeviation.mean <= o.maxMeanDeviation)
    .sort((a, b) => b.members.length - a.members.length);
}

/**
 * 점선(스티치) 검출 — 한 줄로 늘어선 작은 성분들.
 *
 * 비즈 메시와 다르다: 스티치는 **한 방향으로 일정 간격**을 이룬다. 그때는 모티프 반복보다
 * carrier 곡선 + `stroke-dasharray` 가 훨씬 낫다 — 패스 하나가 되고, 간격도 값 하나다.
 */
export interface DashRun {
  members: ComponentEvidence[];
  /** carrier 폴리라인 */
  path: Pt[];
  dash: number;
  gap: number;
  width: number;
  /** 직선성 (0=완벽한 직선) */
  straightness: number;
}

export function findDashRuns(
  comps: ComponentEvidence[],
  canvasArea: number,
  minRun = 8,
): DashRun[] {
  const cand = comps
    .filter((c) => c.area <= canvasArea * 0.0008 && c.elongation < 6)
    .map((c) => ({
      c,
      cx: (c.bbox[0] + c.bbox[2]) / 2,
      cy: (c.bbox[1] + c.bbox[3]) / 2,
      len: Math.max(c.bbox[2] - c.bbox[0], c.bbox[3] - c.bbox[1]) + 1,
    }));
  if (cand.length < minRun) return [];

  const used = new Uint8Array(cand.length);
  const runs: DashRun[] = [];

  for (let s = 0; s < cand.length; s++) {
    if (used[s]) continue;
    // 가장 가까운 이웃을 이어붙여 사슬을 만든다
    const chain = [s];
    used[s] = 1;
    for (let grow = 0; grow < 2; grow++) {
      let cur = grow === 0 ? s : chain[0];
      for (;;) {
        const a = cand[cur];
        let best = -1, bestD = Infinity;
        for (let i = 0; i < cand.length; i++) {
          if (used[i]) continue;
          const d = Math.hypot(cand[i].cx - a.cx, cand[i].cy - a.cy);
          // 이웃 간격은 모티프 크기의 1~6배 안이어야 한다
          if (d > a.len * 6 || d < a.len * 0.6) continue;
          if (d < bestD) { bestD = d; best = i; }
        }
        if (best < 0) break;
        used[best] = 1;
        if (grow === 0) chain.push(best); else chain.unshift(best);
        cur = best;
      }
    }
    if (chain.length < minRun) { for (const i of chain) used[i] = 0; used[s] = 1; continue; }

    const pts = chain.map((i) => ({ x: cand[i].cx, y: cand[i].cy }));
    // 직선성 — 시작·끝 직선에서 벗어난 최대 거리 / 전체 길이
    const A = pts[0], B = pts[pts.length - 1];
    const L = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    let dev = 0;
    for (const p of pts) {
      dev = Math.max(dev, Math.abs((B.y - A.y) * p.x - (B.x - A.x) * p.y + B.x * A.y - B.y * A.x) / L);
    }
    let gapSum = 0;
    for (let i = 1; i < pts.length; i++) gapSum += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const spacing = gapSum / (pts.length - 1);
    const dash = chain.reduce((a, i) => a + cand[i].len, 0) / chain.length;

    runs.push({
      members: chain.map((i) => cand[i].c),
      path: pts,
      dash: +dash.toFixed(2),
      gap: +Math.max(0.5, spacing - dash).toFixed(2),
      width: +(chain.reduce((a, i) => a + cand[i].c.widthMedian, 0) / chain.length).toFixed(2),
      straightness: +(dev / L).toFixed(4),
    });
  }
  // 곧지 않은 사슬은 carrier + dasharray 로 바꿀 수 없다. 억지로 바꾸면 점이 원래
  // 자리에서 벗어난다(실측: 주얼리 도면 구멍 38 → 24).
  return runs.filter((r) => r.members.length >= minRun && r.straightness <= 0.02);
}
