import { parsePath, serializePath, subPathArea, type SubPath, type Pt } from "./pathdata.js";

export interface OptimizeStats {
  subPathsBefore: number;
  subPathsAfter: number;
  segsBefore: number;
  segsAfter: number;
}

/**
 * 자체 Vector Optimizer.
 * - tiny subpath 제거 (면적 기준)
 * - 공선(collinear) L 세그먼트 병합
 * - 미세 세그먼트(<epsilon) 제거
 * - 좌표 라운딩 (serialize 시 0.01)
 */
export function optimizePathData(
  d: string,
  opts: { minArea?: number; epsilon?: number } = {},
): { d: string; stats: OptimizeStats } {
  const minArea = opts.minArea ?? 4; // px^2
  const eps = opts.epsilon ?? 0.35;

  let subs = parsePath(d);
  const stats: OptimizeStats = {
    subPathsBefore: subs.length,
    subPathsAfter: 0,
    segsBefore: subs.reduce((n, s) => n + s.segs.length, 0),
    segsAfter: 0,
  };

  // 1) tiny subpath 제거
  subs = subs.filter((sp) => Math.abs(subPathArea(sp)) >= minArea || sp.segs.length > 12);

  // 2) 세그먼트 정리
  for (const sp of subs) {
    sp.segs = mergeSegments(sp, eps);
  }
  // 정리 후 빈 서브패스 제거
  subs = subs.filter((sp) => sp.segs.length > 0);

  stats.subPathsAfter = subs.length;
  stats.segsAfter = subs.reduce((n, s) => n + s.segs.length, 0);
  return { d: serializePath(subs), stats };
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function mergeSegments(sp: SubPath, eps: number) {
  const out: typeof sp.segs = [];
  let prev: Pt = sp.start;
  for (const seg of sp.segs) {
    // 미세 세그먼트 스킵 (곡선인데 제어점이 크게 벗어나는 경우는 유지)
    if (dist(prev, seg.end) < eps) {
      if (seg.type === "L") continue;
      const bulge = Math.max(dist(prev, seg.c1!), dist(seg.end, seg.c2!));
      if (bulge < eps) continue;
    }
    // 공선 L 병합
    const last = out[out.length - 1];
    if (seg.type === "L" && last?.type === "L") {
      const p0 = out.length >= 2 ? out[out.length - 2].end : sp.start;
      if (collinear(p0, last.end, seg.end, eps)) {
        last.end = seg.end;
        prev = seg.end;
        continue;
      }
    }
    out.push(seg);
    prev = seg.end;
  }
  return out;
}

function collinear(a: Pt, b: Pt, c: Pt, eps: number): boolean {
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const len = dist(a, c) || 1;
  return Math.abs(cross) / len < eps;
}

/**
 * Thin-fill → stroke 감지: 면적 대비 둘레가 큰 닫힌 도형(스티치 등)은
 * stroke로 다루는 게 Illustrator 편집성이 좋다.
 * 반환: 추정 stroke 폭(px), thin이 아니면 null.
 */
export function detectThinFill(d: string): number | null {
  const subs = parsePath(d);
  if (!subs.length) return null;
  let area = 0;
  let perim = 0;
  for (const sp of subs) {
    area += Math.abs(subPathArea(sp));
    let prev = sp.start;
    for (const s of sp.segs) {
      perim += dist(prev, s.end);
      prev = s.end;
    }
  }
  if (perim < 40) return null;
  const width = (2 * area) / perim; // 리본 근사: area ≈ perim/2 * width
  return width > 0.2 && width < 4 ? Math.round(width * 4) / 4 : null;
}
