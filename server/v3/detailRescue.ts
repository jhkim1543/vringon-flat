/**
 * 해프톤 삭제 직전의 마지막 심문 — 죽을 성분 중 의미 있는 디테일을 살린다.
 *
 * V4.1 검증에서 나온 사실: 해프톤 분류가 잉크의 44~62%를 삼키면서 **스트랩 스티치
 * 점선과 로고 문자까지 함께 지웠다** (bag_1 통째 누락 1,297곳·3,668px). 국소 점 밀도만
 * 보면 스티치와 해프톤은 통계가 비슷하다 — 갈라내려면 다른 신호가 필요하다.
 *
 * 세 가지 신호를 쓴다. 셋 다 해프톤 점(작고 둥글고 구멍 없고 2차원으로 퍼짐)에는 없다.
 *
 *   1. **사슬 방향성** — 스티치 대시는 길쭉하고(신장률 ≥ 2.2), 제 장축 방향으로
 *      이웃 대시가 늘어선다. 메시 격자의 점은 둥글고 이웃이 2축 이상으로 퍼진다.
 *   2. **크기** — 로고 문자·지퍼 이빨은 해프톤 점(중앙값)보다 수 배 크다.
 *   3. **구멍** — O·R·B 같은 문자는 구멍이 있다. 해프톤 점에는 구멍이 없다.
 */
import type { Component } from "./label.js";

export interface RescueResult {
  /** 살릴 성분의 인덱스 (doomed 배열 기준) */
  keep: Set<number>;
  stitchCount: number;
  stitchPx: number;
  detailCount: number;
  detailPx: number;
}

interface Shape {
  cx: number; cy: number;
  /** PCA 장축 방향 (라디안) */
  angle: number;
  /** 장축/단축 비 */
  elongation: number;
  /** 장축 길이 근사 */
  len: number;
  area: number;
}

function shapeOf(c: Component, W: number): Shape {
  let sx = 0, sy = 0;
  for (let k = 0; k < c.pixels.length; k++) {
    sx += c.pixels[k] % W;
    sy += (c.pixels[k] / W) | 0;
  }
  const n = c.pixels.length;
  const cx = sx / n, cy = sy / n;
  let xx = 0, yy = 0, xy = 0;
  for (let k = 0; k < c.pixels.length; k++) {
    const dx = (c.pixels[k] % W) - cx;
    const dy = ((c.pixels[k] / W) | 0) - cy;
    xx += dx * dx; yy += dy * dy; xy += dx * dy;
  }
  xx /= n; yy /= n; xy /= n;
  const tr = xx + yy, det = xx * yy - xy * xy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  const angle = Math.atan2(l1 - xx, xy || 1e-9);
  return {
    cx, cy, angle,
    elongation: Math.sqrt(l1 / l2),
    len: Math.sqrt(l1) * 4,
    area: c.area,
  };
}

/** 성분에 구멍이 있는가 — bbox 안에서 테두리로부터 배경을 채우고, 못 닿은 배경이 남으면 구멍 */
function hasHole(c: Component, W: number): boolean {
  const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
  if (w < 4 || h < 4 || w * h > 4096) return false;
  const grid = new Uint8Array(w * h); // 0 배경 · 1 잉크 · 2 도달한 배경
  for (let k = 0; k < c.pixels.length; k++) {
    const x = (c.pixels[k] % W) - c.x0, y = ((c.pixels[k] / W) | 0) - c.y0;
    grid[y * w + x] = 1;
  }
  const stack: number[] = [];
  for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x); }
  for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    if (grid[i] !== 0) continue;
    grid[i] = 2;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  for (let i = 0; i < w * h; i++) if (grid[i] === 0) return true;
  return false;
}

const angDiff = (a: number, b: number): number => {
  let d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
};

export function rescueDetails(doomed: Component[], W: number, _H: number): RescueResult {
  const keep = new Set<number>();
  let stitchCount = 0, stitchPx = 0, detailCount = 0, detailPx = 0;
  if (!doomed.length) return { keep, stitchCount, stitchPx, detailCount, detailPx };

  const shapes = doomed.map((c) => shapeOf(c, W));

  // ── 2·3) 크기·구멍 구제 ─────────────────────────────────────
  // 중앙값은 해프톤 점이 지배한다 — 그보다 수 배 크거나 구멍이 있으면 점이 아니다.
  const areas = shapes.map((s) => s.area).sort((a, b) => a - b);
  const medArea = areas[areas.length >> 1];
  for (let i = 0; i < doomed.length; i++) {
    if (keep.has(i)) continue;
    if (shapes[i].area >= medArea * 8 || hasHole(doomed[i], W)) {
      keep.add(i);
      detailCount++; detailPx += shapes[i].area;
    }
  }

  // ── 1) 스티치 사슬 구제 ─────────────────────────────────────
  // 길쭉한 대시만 후보다. 둥근 해프톤 점(신장률 ~1)은 여기 들어오지 못한다.
  // **2차원 조직 거부.** 니트 코·메시 격자도 길쭉하고 줄지어 있다 — 스티치와 다른 점은
  // 이웃의 분포다. 스티치 대시의 이웃은 사슬 방향으로 앞뒤 2개뿐이고, 직물 조직의 코는
  // 전방향으로 촘촘하다(실측: 이 검사 없이 shoe_3 니트에서 52사슬 9,667px 를 스티치로
  // 오인해 선 F@2 1.000 → 0.922 로 무너졌다).
  const dashIdx: number[] = [];
  for (let i = 0; i < doomed.length; i++) {
    if (keep.has(i) || shapes[i].elongation < 2.2) continue;
    const a2 = shapes[i];
    const r = Math.max(6, a2.len) * 3.5;
    // 이웃은 **길쭉한 것만** 센다. 니트 코는 길쭉해 서로를 거부하지만, 둥근 메시 점
    // (신장률 ~1)은 해프톤 클러스터가 이미 처리하므로 옆의 진짜 스티치를 죽이면 안 된다.
    let nb = 0;
    for (let j = 0; j < doomed.length && nb <= 4; j++) {
      if (j === i || shapes[j].elongation < 1.8) continue;
      const b2 = shapes[j];
      if (Math.hypot(b2.cx - a2.cx, b2.cy - a2.cy) <= r) nb++;
    }
    if (nb <= 4) dashIdx.push(i);
  }
  if (dashIdx.length >= 4) {
    const used = new Uint8Array(doomed.length);
    for (const s of dashIdx) {
      if (used[s] || keep.has(s)) continue;
      // 씨앗의 장축 방향으로 사슬을 양쪽으로 기른다.
      // 이웃 조건: 거리 ≤ 대시 길이의 4배 · 서로의 장축이 ±30° · 연결 방향도 장축과 ±35°
      const chain = [s];
      used[s] = 1;
      for (const dir of [1, -1]) {
        let cur = s;
        for (;;) {
          const a = shapes[cur];
          let best = -1, bestD = Infinity;
          for (const j of dashIdx) {
            if (used[j]) continue;
            const b = shapes[j];
            const d = Math.hypot(b.cx - a.cx, b.cy - a.cy);
            if (d < a.len * 0.5 || d > Math.max(6, a.len) * 4) continue;
            if (angDiff(a.angle, b.angle) > (30 * Math.PI) / 180) continue;
            const link = Math.atan2(b.cy - a.cy, b.cx - a.cx);
            if (angDiff(link, a.angle) > (35 * Math.PI) / 180) continue;
            // 방향 일관성: 사슬이 진행하던 쪽으로만
            const forward = Math.cos(link - a.angle) * dir;
            if (chain.length > 1 && forward < 0) continue;
            if (d < bestD) { bestD = d; best = j; }
          }
          if (best < 0) break;
          used[best] = 1;
          if (dir === 1) chain.push(best); else chain.unshift(best);
          cur = best;
        }
      }
      if (chain.length >= 4) {
        // 간격이 들쭉날쭉하면 우연히 이어진 질감이다
        const pts = chain.map((i) => shapes[i]);
        const gaps: number[] = [];
        for (let i = 1; i < pts.length; i++) gaps.push(Math.hypot(pts[i].cx - pts[i - 1].cx, pts[i].cy - pts[i - 1].cy));
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const cv = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length) / Math.max(1e-6, mean);
        if (cv <= 0.45) {
          for (const i of chain) { keep.add(i); stitchCount++; stitchPx += shapes[i].area; }
          continue;
        }
      }
      for (const i of chain) if (i !== s) used[i] = 0;
    }
  }

  return { keep, stitchCount, stitchPx, detailCount, detailPx };
}
