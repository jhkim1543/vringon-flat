import sharp from "sharp";
import { config } from "../config.js";
import { fitAdaptive, segsToPathD } from "./fitCurve.js";
import type { IRPath } from "../types.js";
import type { Pt } from "./pathdata.js";

/**
 * 선 레이어 중심선 추출 (Centerline tracing).
 *
 * 일반 벡터라이저는 검은 선을 "닫힌 리본 외곽선"으로 추적한다. 그 결과를
 * 그대로 stroke로 그리면 선이 속 빈 이중선이 되고(실측: 12배 확대에서 확인),
 * fill로 두면 Illustrator에서 선 굵기를 못 바꾼다.
 *
 * 여기서는 래스터를 골격화(Zhang-Suen)해 1픽셀 중심선을 얻고, 분기점 사이를
 * 체인으로 추출한 뒤 베지어로 적합해 **열린 stroke 패스**로 만든다.
 * 디자이너가 선 굵기를 그대로 조절할 수 있는 형태다.
 */

export interface CenterlineOptions {
  color: string;
  /** 이 길이(px) 미만 체인은 노이즈로 버린다 */
  minLength?: number;
  /**
   * 면 레이어의 경계 마스크(전체 해상도). 여기에 대부분 겹치는 선은
   * 면 경계와 중복이므로 버린다 — 넣지 않으면 파트 경계마다 선이 이중으로
   * 그려져 도면이 지저분해진다(라인아트와 컬러플랫이 서로 다른 후보 이미지라
   * 경계가 몇 px 어긋나기 때문).
   */
  fillEdges?: { mask: Uint8Array; width: number; height: number };
  /**
   * 제품 영역 마스크(면 레이어 합집합을 약간 넓힌 것).
   * 이 밖에 놓인 선은 그림자·반사 잔상 같은 배경 아티팩트이므로 버린다
   * (실측: 거울 반사 위에 빗금이 그려짐).
   */
  fillArea?: { mask: Uint8Array; width: number; height: number };
  /** 선 패스 상한 — Illustrator 편집성을 위한 예산 (기본 600) */
  maxPaths?: number;
  /**
   * 선 굵기 상한(px, **입력 이미지 좌표계**). 기본 6.
   *
   * 이 값은 centerlineTrace 가 원본 해상도에서 돌던 시절에 정해졌다. V3 는 도면을 2~4배로
   * 키운 작업 캔버스에서 추적하므로 그대로 두면 실효 상한이 원본 기준 1.5~3px 이 된다.
   * 실측: 9종 centerline 1,854개 중 1,745개(94.1%)가 정확히 6 에 붙어 있었다 —
   * 사실상 **모든 구조선이 같은 굵기로, 그것도 실제보다 얇게** 출고되고 있었다.
   * 그 결과 stroke 가 잉크를 덜 덮어 residual 이 부풀고 outline 패스가 폭증했다.
   * 호출부가 자기 좌표계에 맞는 값을 넘겨야 한다.
   */
  maxWidth?: number;
  /**
   * 잉크 판정 임계 (기본 170 = 어두운 선 전용).
   * 컬러 파트(금색 프레임 등)를 스트로크로 추출할 때는 250을 줘서
   * "흰 배경이 아닌 모든 픽셀"을 잉크로 본다.
   */
  inkThreshold?: number;
  onNote?: (msg: string) => void;
}

export async function centerlineTrace(
  pngPath: string,
  opts: CenterlineOptions,
): Promise<IRPath[]> {
  const { data, info } = await sharp(pngPath)
    .flatten({ background: "#ffffff" })
    .greyscale()
    .threshold(opts.inkThreshold ?? 170)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width, H = info.height, ch = info.channels;
  const ink = new Uint8Array(W * H);
  let inkCount = 0;
  for (let i = 0; i < W * H; i++) {
    // threshold 후 어두운 픽셀이 선
    if (data[i * ch] < 128) { ink[i] = 1; inkCount++; }
  }
  if (!inkCount) return [];

  const skel = skeletonize(ink, W, H);
  let skelCount = 0;
  for (let i = 0; i < skel.length; i++) skelCount += skel[i];
  if (!skelCount) return [];

  // 거리변환 — 각 잉크 픽셀에서 배경까지의 거리.
  // 굵기는 이 값 × 2 이고, **체인마다 따로** 잰다. 레이어 전체에 굵기 하나를
  // 쓰면 굵은 윤곽선과 가는 스티치가 같은 값으로 뭉개져 충실도가 떨어진다
  // (실측: 메시 가방에서 전역 굵기로는 IoU 83%가 한계였다).
  const dist = distanceTransform(ink, W, H);

  // 질감 억제 — 길이 + **연결성**으로 판단한다.
  //
  // 처음엔 길이만 봤는데("짧으면 질감"), 접합부 사이의 짧은 연결 구간까지
  // 잘려 나가 구조선이 중간중간 끊겼다(사용자 지적: 라인 끊김).
  // 짧은 체인을 세 부류로 나눈다:
  //   1) 긴 구조선과 접합부를 공유 → **연결선**. 무조건 보존 (끊김 방지)
  //   2) 짧은 것끼리만 뭉쳐 있고 수가 많음 → 그물·비즈 질감. 제거
  //   3) 고립돼 있고 수가 적음 → 스티치 대시 등 의미 있는 디테일. 보존
  const minLen =
    opts.minLength ?? Math.max(3, Math.round(Math.min(W, H) * config.textureMinLen));
  const allChains = traceChains(skel, W, H).filter((c) => chainLength(c) >= 3);
  const longs: Pt[][] = [];
  const shorts: Pt[][] = [];
  for (const c of allChains) (chainLength(c) >= minLen ? longs : shorts).push(c);

  // 긴 체인의 끝점(접합부) 집합
  const longEnds = new Set<number>();
  for (const c of longs) {
    longEnds.add(c[0][1] * W + c[0][0]);
    longEnds.add(c[c.length - 1][1] * W + c[c.length - 1][0]);
  }
  const connectors: Pt[][] = [];
  const textureCands: Pt[][] = [];
  for (const c of shorts) {
    const e0 = c[0][1] * W + c[0][0];
    const e1 = c[c.length - 1][1] * W + c[c.length - 1][0];
    if (longEnds.has(e0) || longEnds.has(e1)) connectors.push(c);
    else textureCands.push(c);
  }
  // 짧은 고립 체인이 대량이면 질감, 소량이면 스티치류 디테일
  const TEXTURE_CLUSTER = 60;
  let chains: Pt[][];
  if (textureCands.length > TEXTURE_CLUSTER) {
    opts.onNote?.(`질감 체인 ${textureCands.length}개 제거 (연결선 ${connectors.length}개는 보존)`);
    chains = [...longs, ...connectors];
  } else {
    chains = [...longs, ...connectors, ...textureCands];
  }

  // 선 예산 — 폭주 방지용 안전장치이지 품질 목표가 아니다.
  //
  // 처음엔 600으로 잡았는데, 실측해 보니 편집성을 얻는 대신 충실도를 크게
  // 내주는 거래였다: 메시 가방에서 3386개를 버려 선 충실도가 IoU 44.7%까지
  // 떨어졌다(상용 트레이서는 89.3%). 파일이 무거워지는 것보다 도면이
  // 부실해지는 쪽이 훨씬 손해이므로 기본값을 크게 올렸다.
  // LINE_BUDGET 환경변수로 조절한다.
  const budget = opts.maxPaths ?? config.lineBudget;
  if (chains.length > budget) {
    const sorted = [...chains].sort((a, b) => chainLength(b) - chainLength(a));
    const droppedNoise = chains.length - budget;
    chains = sorted.slice(0, budget);
    opts.onNote?.(
      `질감 노이즈 ${droppedNoise}개 제외 (선 예산 ${budget}개 · 길이 상위만 유지)`,
    );
  }

  // 제품 영역 클리핑을 쓸지 판단한다.
  //
  // 면 레이어가 제품을 잘 덮은 경우에만 신뢰할 수 있는 기준이 된다. 면
  // 커버리지가 부실한 제품에 그대로 적용했더니 정상 구조선이 대량으로
  // 잘려 나갔다(실측: jewelry_3 IoU 82.5% → 65.6%).
  // 그래서 "버려질 선이 전체의 25%를 넘으면 기준 자체가 못 믿을 것"으로 보고
  // 클리핑을 통째로 건너뛴다.
  let clip = opts.fillArea;
  if (clip) {
    let would = 0;
    for (const c of chains) if (onFillEdge(c, clip, W, H) < 0.15) would++;
    if (would > chains.length * 0.25) {
      opts.onNote?.(
        `면 커버리지가 부실해 제품영역 클리핑 생략 (대상 ${would}/${chains.length})`,
      );
      clip = undefined;
    }
  }

  const paths: IRPath[] = [];
  let dropped = 0;
  let outside = 0;
  for (const chain of chains) {
    // 제품 영역 밖의 선 = 그림자·반사 잔상 (거의 전부 바깥인 것만)
    if (clip && onFillEdge(chain, clip, W, H) < 0.15) {
      outside++;
      continue;
    }
    // 면 경계와 대부분 겹치는 선은 버린다 (이중선 방지)
    if (opts.fillEdges && onFillEdge(chain, opts.fillEdges, W, H) > 0.85) {
      dropped++;
      continue;
    }
    // 골격의 계단 진동을 가볍게 눌러준 뒤 **최소자승 베지어 피팅**.
    // (기존 RDP+Catmull-Rom 보간은 남은 점만 통과시켜 곡선이 뻣뻣하거나
    // 물결쳤다 — 피팅은 원본 점 전체와의 오차를 최소화한다.)
    // 평활·허용오차는 실측으로 고른 값이다.
    // 고배율의 미세 일렁임을 없애려고 평활 2패스 + 오차 2.0px로 올려 봤더니
    // 선 충실도가 평균 93.3% → 88.1%로 떨어졌다(jewelry_2 99.7→85.3,
    // jewelry_3 87.7→62.4, 앵커도 절반으로 줄어 과단순화).
    // 미세 일렁임보다 형상 손실이 훨씬 큰 손해라 아래 값을 유지한다.
    const smoothed = smoothChain(chain, 1);
    if (smoothed.length < 2) continue;
    // 오차 예산 적응 피팅 (AmodalSVG ALV) — 긴 구조선은 형상 우선, 짧은 디테일은 앵커 예산 우선
    const { segs } = fitAdaptive(smoothed, { baseError: 1.2, cornerAngleDeg: 55 });
    if (!segs.length) continue;
    paths.push({
      d: segsToPathD(segs, isClosed(chain)),
      fill: null,
      stroke: opts.color,
      strokeWidth: chainWidth(chain, dist, W, opts.maxWidth ?? 6),
      vectorizer: "vtracer",
    });
  }
  if (outside) opts.onNote?.(`제품 영역 밖 선 ${outside}개 제거 (그림자·반사 잔상)`);
  if (dropped) opts.onNote?.(`면 경계 중복선 ${dropped}개 제거`);
  return paths;
}

/** 체인 점들이 면 경계 마스크 위에 있는 비율 */
function onFillEdge(
  chain: Pt[],
  edges: { mask: Uint8Array; width: number; height: number },
  W: number,
  H: number,
): number {
  const sx = edges.width / W, sy = edges.height / H;
  let on = 0;
  for (const [x, y] of chain) {
    const ex = Math.min(edges.width - 1, Math.max(0, Math.round(x * sx)));
    const ey = Math.min(edges.height - 1, Math.max(0, Math.round(y * sy)));
    if (edges.mask[ey * edges.width + ex]) on++;
  }
  return chain.length ? on / chain.length : 0;
}

/** 체인 위 거리변환 값의 중앙값 × 2 = 그 선의 굵기 */
function chainWidth(chain: Pt[], dist: Float32Array, W: number, maxWidth: number): number {
  const vals: number[] = [];
  for (const [x, y] of chain) {
    const v = dist[y * W + x];
    if (v > 0 && v < 1e5) vals.push(v);
  }
  if (!vals.length) return 1;
  vals.sort((a, b) => a - b);
  const med = vals[vals.length >> 1];
  // 중앙값을 쓴다. p90 을 쓰면 교차부의 굵은 지점이 체인 전체를 부풀린다
  // (실측: F@2px 0.9396 → 0.9090, precision@2 0.9115).
  return Math.max(0.5, Math.min(maxWidth, Math.round(med * 2 * 4) / 4));
}

/** 2-pass 체임퍼 거리변환 — 각 잉크 픽셀에서 배경까지의 거리 */
function distanceTransform(ink: Uint8Array, W: number, H: number): Float32Array {
  const INF = 1e6;
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = ink[i] ? INF : 0;
  const D1 = 1, D2 = 1.41421356;
  // forward
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + D1);
      if (y > 0) v = Math.min(v, d[i - W] + D1);
      if (x > 0 && y > 0) v = Math.min(v, d[i - W - 1] + D2);
      if (x < W - 1 && y > 0) v = Math.min(v, d[i - W + 1] + D2);
      d[i] = v;
    }
  }
  // backward
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < W - 1) v = Math.min(v, d[i + 1] + D1);
      if (y < H - 1) v = Math.min(v, d[i + W] + D1);
      if (x < W - 1 && y < H - 1) v = Math.min(v, d[i + W + 1] + D2);
      if (x > 0 && y < H - 1) v = Math.min(v, d[i + W - 1] + D2);
      d[i] = v;
    }
  }
  return d;
}

// ── Zhang-Suen 세선화 ────────────────────────────────────────
function skeletonize(src: Uint8Array, W: number, H: number): Uint8Array {
  const img = Uint8Array.from(src);
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= W || y >= H ? 0 : img[y * W + x];

  let changed = true;
  const toRemove: number[] = [];
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      toRemove.length = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          if (!img[y * W + x]) continue;
          // P2..P9 시계방향 (북에서 시작)
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y);
          const p5 = at(x + 1, y + 1), p6 = at(x, y + 1), p7 = at(x - 1, y + 1);
          const p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let a = 0;
          for (let i = 0; i < 8; i++) if (seq[i] === 0 && seq[i + 1] === 1) a++;
          if (a !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }
          toRemove.push(y * W + x);
        }
      }
      if (toRemove.length) {
        for (const i of toRemove) img[i] = 0;
        changed = true;
      }
    }
  }
  return img;
}

// ── 골격 → 체인 추출 ─────────────────────────────────────────
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

/**
 * 골격 픽셀의 분기 수 = 교차수(crossing number).
 *
 * 8-이웃 개수를 그대로 세면 안 된다: 대각선 위의 정상 픽셀도 서로 인접한
 * 이웃을 3개 이상 갖기 때문에 가짜 분기점이 대량으로 생기고, 체인이 2점씩
 * 잘게 끊긴다(실측: 323패스/629앵커). 이웃 시퀀스의 0→1 전이 수를 세면
 * 끝점=1, 정상=2, 분기=3+ 로 올바르게 나온다.
 */
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

/** 끝점·분기점 사이의 픽셀 체인들을 뽑는다 (닫힌 고리 포함) */
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

/**
 * 다음 골격 픽셀 선택.
 * 8-이웃에서는 이전 픽셀에 붙어 있는 이웃이 "옆걸음"으로 잡힐 수 있으므로,
 * 이전 픽셀과 인접하지 않은 이웃을 우선한다 (진짜 진행 방향).
 */
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

function chainLength(c: Pt[]): number {
  let n = 0;
  for (let i = 1; i < c.length; i++) n += Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]);
  return n;
}

function isClosed(c: Pt[]): boolean {
  if (c.length < 4) return false;
  return Math.hypot(c[0][0] - c[c.length - 1][0], c[0][1] - c[c.length - 1][1]) < 1.5;
}

/** 이동평균 평활화 (양 끝점은 고정) */
function smoothChain(pts: Pt[], passes: number): Pt[] {
  if (pts.length < 5) return pts;
  let cur = pts;
  for (let p = 0; p < passes; p++) {
    const out: Pt[] = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      const a = cur[i - 1], b = cur[i], c = cur[i + 1];
      out.push([(a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4]);
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

