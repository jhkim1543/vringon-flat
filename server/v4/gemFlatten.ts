/**
 * 보석 안쪽의 **빛 반사·그림자를 지운다.**
 *
 * VRINGON 도면은 주얼리를 그릴 때 스톤 안쪽에 사진의 하늘 반사를 그대로 남긴다
 * (실측: jewelry_3 세 스톤 전부 파란 대리석 무늬). 그것을 벡터화하면 검은 파편 수백 개가
 * 되고, 테크팩에서는 아무 의미가 없다 — 반사는 조명의 산물이지 제품의 형상이 아니다.
 *
 * **마스크가 아니라 도면의 면으로 잡는다.** 처음엔 파트 마스크를 침식해 그 안쪽 잉크를
 * 지웠는데, 마스크가 실제 스톤과 어긋난 곳에서는 얼룩이 그대로 남았다(실측: jewelry_3
 * 중앙·후면 스톤). 스톤 안쪽은 도면에서 **선이 감싼 닫힌 면**이고, 반사 얼룩은 그 면에
 * 뚫린 **구멍**이다. 구멍을 메우면 마스크 정합과 무관하게 깨끗해진다.
 *
 * **무엇을 지우고 무엇을 남기나.**
 *   지운다  반사·그림자 — 면에 뚫린 구멍
 *   남긴다  패싯 능선 — 면을 가로질러 반대편까지 닿는 곧고 가는 선.
 *           컷 스톤의 능선은 제품의 형상이므로 구멍이 아니라 면을 **가른다**.
 */
import type { Component } from "../v3/label.js";
import { labelComponents } from "../v3/label.js";

/** 라벨·설명이 스톤을 가리키는가 */
const GEM_WORDS = [
  "gem", "stone", "crystal", "pearl", "diamond", "sapphire", "ruby", "emerald",
  "opal", "turquoise", "cabochon", "jewel", "bead",
];

/**
 * 베젤·세팅은 금속이지만 **스톤을 감싼다** — 그 안쪽은 곧 스톤이다. 스톤 자체의 마스크가
 * 쪼그라든 경우에도 베젤을 통해 안쪽을 잡을 수 있다(실측: jewelry_3 rear_gemstone
 * 마스크가 캔버스의 0.05% 였다).
 */
const SURROUND_WORDS = ["bezel", "setting", "prong", "claw", "mount", "collet", "halo"];

export function isGemPart(label: string, id: string): boolean {
  const s = `${id} ${label}`.toLowerCase();
  // 밴드·샹크는 스톤을 감싸지 않는다 — 그 안쪽은 손가락이 들어갈 구멍이다
  if (/\bband\b|shank|chain|strap/.test(s)) return false;
  return GEM_WORDS.some((w) => s.includes(w)) || SURROUND_WORDS.some((w) => s.includes(w));
}

/** 성분이 얼마나 곧은가 — 주축에서 벗어난 최대 거리 / 주축 길이 */
function shapeStats(c: Component, W: number): { straight: number; span: number; elong: number } {
  let sx = 0, sy = 0;
  for (let k = 0; k < c.pixels.length; k++) { sx += c.pixels[k] % W; sy += (c.pixels[k] / W) | 0; }
  const n = c.pixels.length;
  const cx = sx / n, cy = sy / n;
  let xx = 0, yy = 0, xy = 0;
  for (let k = 0; k < c.pixels.length; k++) {
    const dx = (c.pixels[k] % W) - cx, dy = ((c.pixels[k] / W) | 0) - cy;
    xx += dx * dx; yy += dy * dy; xy += dx * dy;
  }
  xx /= n; yy /= n; xy /= n;
  const tr = xx + yy, det = xx * yy - xy * xy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  const ax = xy, ay = l1 - xx;
  const an = Math.hypot(ax, ay) || 1;
  const ux = ax / an, uy = ay / an;
  let along = 0, across = 0;
  for (let k = 0; k < c.pixels.length; k++) {
    const dx = (c.pixels[k] % W) - cx, dy = ((c.pixels[k] / W) | 0) - cy;
    along = Math.max(along, Math.abs(dx * ux + dy * uy));
    across = Math.max(across, Math.abs(-dx * uy + dy * ux));
  }
  return {
    straight: across / Math.max(1, along),
    span: along * 2,
    elong: Math.sqrt(l1 / l2),
  };
}

/** bbox 안에서만 도는 침식 — 면마다 전체 캔버스를 훑지 않는다 */
function erodeLocal(
  m: Uint8Array, W: number, H: number, r: number,
  x0: number, y0: number, w: number, h: number,
): Uint8Array {
  let cur = m;
  const x1 = Math.min(W - 1, x0 + w), y1 = Math.min(H - 1, y0 + h);
  for (let it = 0; it < r; it++) {
    const nx = new Uint8Array(W * H);
    for (let y = Math.max(1, y0 - 1); y <= y1; y++) {
      for (let x = Math.max(1, x0 - 1); x <= x1; x++) {
        const i = y * W + x;
        if (cur[i] && cur[i - 1] && cur[i + 1] && cur[i - W] && cur[i + W]) nx[i] = 1;
      }
    }
    cur = nx;
  }
  return cur;
}

function dilate(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
  let cur = m;
  for (let it = 0; it < r; it++) {
    const nx = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (cur[i] || (x > 0 && cur[i - 1]) || (x < W - 1 && cur[i + 1]) ||
          (y > 0 && cur[i - W]) || (y < H - 1 && cur[i + W])) nx[i] = 1;
      }
    }
    cur = nx;
  }
  return cur;
}

export interface GemFlattenResult {
  /** 지운 성분 수 · 픽셀 수 */
  removed: [number, number];
  /** 패싯 능선으로 판단해 남긴 성분 수 */
  keptFacets: number;
  /** 처리한 스톤 면의 개수 */
  faces: number;
  parts: string[];
  /**
   * 지운 픽셀. QA 는 이 영역의 "손실"을 손실로 세면 안 된다 — 해프톤 톤 치환과 같다.
   * 의도한 제거를 실패로 세면 지표가 옳은 동작을 벌한다.
   */
  removedMask: Uint8Array;
}

/**
 * 스톤 면 안쪽의 반사를 `ink` 에서 지운다(제자리 수정).
 *
 * @param minFaceRatio 스톤 면으로 인정할 최소 면적 (캔버스 대비)
 */
export function flattenGemInteriors(
  ink: Uint8Array,
  gemParts: { id: string; mask: Uint8Array }[],
  W: number,
  H: number,
  minFaceRatio = 0.0008,
): GemFlattenResult {
  const N = W * H;
  const removedMask = new Uint8Array(N);
  let removedN = 0, removedPx = 0, keptFacets = 0, faceCount = 0;
  const touched = new Set<string>();
  if (!gemParts.length) {
    return { removed: [0, 0], keptFacets: 0, faces: 0, parts: [], removedMask };
  }

  // 스톤이 있을 만한 자리 — 마스크가 조금 어긋나도 잡히도록 넉넉히 넓힌다
  const near = dilate(
    (() => { const u = new Uint8Array(N); for (const g of gemParts) for (let i = 0; i < N; i++) if (g.mask[i]) u[i] = 1; return u; })(),
    W, H, Math.max(4, Math.round(Math.min(W, H) * 0.01)),
  );

  // 잉크를 살짝 닫아 실선을 막고, 캔버스 밖에서 배경을 채운다 → 남은 것이 닫힌 면
  const closed = dilate(ink, W, H, 1);
  const outside = new Uint8Array(N);
  {
    const stack: number[] = [];
    for (let x = 0; x < W; x++) { stack.push(x, (H - 1) * W + x); }
    for (let y = 0; y < H; y++) { stack.push(y * W, y * W + W - 1); }
    while (stack.length) {
      const i = stack.pop()!;
      if (outside[i] || closed[i]) continue;
      outside[i] = 1;
      const x = i % W, y = (i / W) | 0;
      if (x > 0) stack.push(i - 1);
      if (x < W - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - W);
      if (y < H - 1) stack.push(i + W);
    }
  }
  const enclosed = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (!closed[i] && !outside[i]) enclosed[i] = 1;

  const minFace = N * minFaceRatio;
  for (const face of labelComponents(enclosed, W, H, 4, Math.max(16, Math.round(minFace))).components) {
    // 이 면이 스톤 자리인가 — 절반 이상이 스톤 근방에 있어야 한다
    let inNear = 0;
    for (let k = 0; k < face.pixels.length; k++) if (near[face.pixels[k]]) inNear++;
    if (inNear < face.pixels.length * 0.5) continue;

    // 어느 파트의 자리인지 기록 (보고용)
    for (const g of gemParts) {
      let hit = 0;
      for (let k = 0; k < face.pixels.length; k += 7) if (g.mask[face.pixels[k]]) hit++;
      if (hit > face.pixels.length / 7 * 0.3) touched.add(g.id);
    }
    faceCount++;

    // ── 이 면의 구멍을 찾는다 ────────────────────────────────
    // 면의 bbox 안에서 "면이 아닌 곳"을 테두리부터 채운다. 못 닿은 곳이 구멍이다.
    const fx0 = face.x0, fy0 = face.y0;
    const fw = face.x1 - face.x0 + 1, fh = face.y1 - face.y0 + 1;
    const grid = new Uint8Array(fw * fh); // 0 = 면 아님 · 1 = 면 · 2 = 바깥에서 닿음
    for (let k = 0; k < face.pixels.length; k++) {
      const x = (face.pixels[k] % W) - fx0, y = ((face.pixels[k] / W) | 0) - fy0;
      grid[y * fw + x] = 1;
    }
    const st: number[] = [];
    for (let x = 0; x < fw; x++) { st.push(x, (fh - 1) * fw + x); }
    for (let y = 0; y < fh; y++) { st.push(y * fw, y * fw + fw - 1); }
    while (st.length) {
      const i = st.pop()!;
      if (grid[i] !== 0) continue;
      grid[i] = 2;
      const x = i % fw, y = (i / fw) | 0;
      if (x > 0) st.push(i - 1);
      if (x < fw - 1) st.push(i + 1);
      if (y > 0) st.push(i - fw);
      if (y < fh - 1) st.push(i + fw);
    }
    // 구멍 픽셀 = grid 0 (면도 아니고 바깥에서 닿지도 않은 곳)
    const holes = new Uint8Array(N);
    let holeN = 0;
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        if (grid[y * fw + x] !== 0) continue;
        holes[(fy0 + y) * W + (fx0 + x)] = 1;
        holeN++;
      }
    }
    if (!holeN) continue;

    // **가장자리에 붙은 구멍은 구조다.** 베젤 안쪽 링은 면의 테두리를 따라 돌고,
    // 반사 얼룩은 면 한가운데 떠 있다. 면+구멍을 합쳐 침식한 안쪽에 온전히 들어가는
    // 구멍만 얼룩으로 본다 — 이 검사 없이는 스톤의 금속 테가 통째로 사라진다.
    const filled = new Uint8Array(N);
    for (let k2 = 0; k2 < face.pixels.length; k2++) filled[face.pixels[k2]] = 1;
    for (let i = 0; i < N; i++) if (holes[i]) filled[i] = 1;
    const rim = Math.max(3, Math.round(Math.min(fw, fh) * 0.08));
    const inner = erodeLocal(filled, W, H, rim, fx0, fy0, fw, fh);

    const faceSpan = Math.max(fw, fh);
    for (const h of labelComponents(holes, W, H, 8, 1).components) {
      // **큰 구멍은 얼룩이 아니라 구조다.** 베젤 안쪽 링처럼 면을 다시 가르는 선은
      // 이 방식에서 "구멍"으로 잡히는데, 지우면 스톤의 테가 통째로 사라진다
      // (실측: 상한 없이 돌리자 중앙 스톤의 금색 베젤이 없어졌다 — 47,546px 삭제).
      // 반사 얼룩은 면에 비해 작다(실측 평균 134px).
      // 두르는 테는 아래에서 따로 걸러지므로, 여기 상한은 넉넉해도 된다.
      // 하이라이트 초승달은 면의 20% 를 넘기도 한다.
      //
      // 분모는 **스톤 내부 전체(면+구멍)**다. 흰 면적(face.area)만 쓰면 반사가 스톤을
      // 많이 덮을수록 상한이 같이 쪼그라들어, 정작 큰 반사 덩어리가 "구조"로 오인돼
      // 살아남는다(실측 jewelry_3: 지우다 만 조각 2,043px 등이 남아 선 F@2 0.83).
      if (h.area > (face.area + holeN) * 0.3) continue;
      // 가장자리에 닿는 구멍은 둘 중 하나다 — 면을 **두르는 금속 테**(베젤)이거나,
      // 테 근처에 앉은 반사 조각이다. 테는 면을 거의 다 감싸므로 bbox 가 면만 하다.
      // 반사 조각은 짧은 호라 bbox 가 작다. 그것으로 가른다.
      let allInside = true;
      for (let k2 = 0; k2 < h.pixels.length; k2++) if (!inner[h.pixels[k2]]) { allInside = false; break; }
      if (!allInside) {
        const hw = h.x1 - h.x0 + 1, hh = h.y1 - h.y0 + 1;
        const wraps = hw >= fw * 0.7 && hh >= fh * 0.7;
        if (wraps) continue; // 두르는 테 — 구조다
      }
      const st2 = shapeStats(h, W);
      // 패싯 능선: 면을 가로지를 만큼 길고(지름의 45% 이상) 곧고 가늘다.
      // 반사 얼룩은 짧고 굽이친다. 넷을 다 요구해야 갈린다.
      if (st2.elong >= 5 && st2.straight <= 0.05 && st2.span >= faceSpan * 0.45) {
        keptFacets++;
        continue;
      }
      for (let k = 0; k < h.pixels.length; k++) {
        const i = h.pixels[k];
        if (ink[i]) { ink[i] = 0; removedMask[i] = 1; removedPx++; }
      }
      removedN++;
    }

    // ── 2차: 테두리에 붙은 반사 ────────────────────────────
    // 구멍 방식은 **경계와 연결된 잉크를 못 본다** — 반사 줄기가 스톤 윤곽선에 닿아
    // 있으면 윤곽과 한 성분이라 구멍이 아니다(실측 jewelry_3: 2,043px 등 5덩이 잔존).
    // 면에서 잉크를 타고 자란 영역을 스톤 내부로 보고, 테두리에서 침식한 안쪽의
    // 잉크만 지운다 — 윤곽선·베젤은 테두리 곁이라 침식에 보호된다.
    {
      // 면은 `dilate(ink,1)` 로 닫은 영역이라 실제 잉크와 1px 떨어져 있다 — 그 완충을
      // 건너려면 성장 통로도 1px 팽창한 잉크로 잡아야 한다(안 그러면 한 픽셀도 못 자란다).
      const grow = dilate(ink, W, H, 1);
      const interior = new Uint8Array(N);
      const q: number[] = [];
      for (let k = 0; k < face.pixels.length; k++) { interior[face.pixels[k]] = 1; q.push(face.pixels[k]); }
      while (q.length) {
        const i = q.pop()!;
        const x = i % W, y = (i / W) | 0;
        for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
          if (j < 0 || interior[j]) continue;
          const jx = j % W, jy = (j / W) | 0;
          if (jx < fx0 || jx > face.x1 || jy < fy0 || jy > face.y1) continue;
          if (!grow[j] && !removedMask[j]) continue; // 흰 바깥으로는 안 자란다
          interior[j] = 1;
          q.push(j);
        }
      }
      // 보호 폭 1.5×rim 은 실측으로 정했다 — 0.75×rim 으로 좁히면 스톤이 더 깨끗해
      // 보이지만 middle_bezel 의 안쪽 명암(도면 내용)까지 지워져 recall 0.37 로
      // 떨어지고 F@0 도 0.855 → 0.802 로 밀린다. 남는 부스러기는 베젤 명암이다.
      const inner2 = erodeLocal(interior, W, H, Math.round(rim * 1.5), fx0, fy0, fw, fh);
      const deep = new Uint8Array(N);
      let deepN = 0;
      for (let i = 0; i < N; i++) if (ink[i] && inner2[i]) { deep[i] = 1; deepN++; }
      if (deepN) {
        for (const h of labelComponents(deep, W, H, 8, 1).components) {
          const hw = h.x1 - h.x0 + 1, hh = h.y1 - h.y0 + 1;
          if (hw >= fw * 0.7 && hh >= fh * 0.7) continue; // 두르는 테
          const st2 = shapeStats(h, W);
          if (st2.elong >= 5 && st2.straight <= 0.05 && st2.span >= faceSpan * 0.45) { keptFacets++; continue; }
          for (let k = 0; k < h.pixels.length; k++) {
            const i = h.pixels[k];
            if (ink[i]) { ink[i] = 0; removedMask[i] = 1; removedPx++; }
          }
          removedN++;
        }
      }
    }
  }

  // ── 3차: 스톤 파트 마스크 안쪽 청소 ─────────────────────
  // 면 검출은 흰 영역에서 출발하므로, 반사가 짙어 흰 면이 조각나면 그 사이 덩어리를
  // 놓친다(실측 jewelry_3: 2,043px 덩어리가 1·2차를 다 빠져나갔다). 스톤 파트 마스크가
  // 있으면 그 침식 안쪽은 **비어 있어야 하는 영역**이다 — 남은 잉크를 같은 가드
  // (두르는 테·패싯 능선)로 거른 뒤 지운다. 베젤·밴드 마스크에는 적용하지 않는다.
  for (const g of gemParts) {
    // **판정 사전은 하나여야 한다.** 여기에만 짧은 정규식을 두었더니 GEM_WORDS 에는
    // 있는 opal·turquoise·sapphire 등이 3차 패스를 건너뛰었다(실측 t_jewelry_03:
    // "Opal inlay" 의 얼룩 78,627px 이 통째로 남아 F@0 0.673). 베젤·세팅(SURROUND)은
    // 스톤을 감싸는 금속이라 여기서는 제외한다 — 그 안쪽만 스톤이다.
    if (!GEM_WORDS.some((w) => g.id.toLowerCase().includes(w))) continue;
    let x0 = W, y0 = H, x1 = -1, y1 = -1, area = 0;
    for (let i = 0; i < N; i++) {
      if (!g.mask[i]) continue;
      area++;
      const x = i % W, y = (i / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (area < N * minFaceRatio) continue;
    const gw = x1 - x0 + 1, gh = y1 - y0 + 1;
    const rim3 = Math.max(4, Math.round(Math.min(gw, gh) * 0.14));
    const inner3 = erodeLocal(g.mask, W, H, rim3, x0, y0, gw, gh);
    const deep = new Uint8Array(N);
    let deepN = 0;
    for (let i = 0; i < N; i++) if (ink[i] && inner3[i]) { deep[i] = 1; deepN++; }
    if (!deepN) continue;
    for (const h of labelComponents(deep, W, H, 8, 1).components) {
      const hw = h.x1 - h.x0 + 1, hh = h.y1 - h.y0 + 1;
      if (hw >= gw * 0.6 && hh >= gh * 0.6) continue; // 두르는 테(안쪽 베젤 링)
      const st2 = shapeStats(h, W);
      if (st2.elong >= 5 && st2.straight <= 0.05 && st2.span >= Math.max(gw, gh) * 0.45) { keptFacets++; continue; }
      for (let k = 0; k < h.pixels.length; k++) {
        const i = h.pixels[k];
        if (ink[i]) { ink[i] = 0; removedMask[i] = 1; removedPx++; }
      }
      removedN++;
    }
    touched.add(g.id);
  }

  // ── 4차: 지운 반사의 가장자리 부스러기 ──────────────────
  // 반사를 지우면 그 경계선(어두운 픽셀의 바깥 띠)이 조각조각 남는다 — 침식 보호 안에
  // 있어서 2·3차가 못 건드린 것들이다. 이 부스러기는 "지운 영역에 붙어 있다"는 성질로
  // 가른다: 성분의 6할 이상이 지운 픽셀의 2px 이웃이면 반사의 잔해다. 베젤 명암 같은
  // 도면 내용은 지운 영역과 무관한 자리에 있어 안 걸린다.
  if (removedPx) {
    const nearRemoved = dilate(removedMask, W, H, 2);
    const nearGem = near; // 스톤 근방으로 한정
    const cand = new Uint8Array(N);
    let candN = 0;
    for (let i = 0; i < N; i++) if (ink[i] && nearGem[i]) { cand[i] = 1; candN++; }
    if (candN) {
      for (const h of labelComponents(cand, W, H, 8, 1).components) {
        let adj = 0;
        for (let k = 0; k < h.pixels.length; k++) if (nearRemoved[h.pixels[k]]) adj++;
        if (adj < h.pixels.length * 0.6) continue;
        const st2 = shapeStats(h, W);
        // 곧고 긴 것은 도면의 선일 수 있다 — 남긴다
        if (st2.elong >= 5 && st2.straight <= 0.05) { keptFacets++; continue; }
        for (let k = 0; k < h.pixels.length; k++) {
          const i = h.pixels[k];
          if (ink[i]) { ink[i] = 0; removedMask[i] = 1; removedPx++; }
        }
        removedN++;
      }
    }
  }

  return {
    removed: [removedN, removedPx], keptFacets, faces: faceCount,
    parts: [...touched], removedMask,
  };
}
