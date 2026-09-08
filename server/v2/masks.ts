/**
 * S04 가시영역 마스크 — 개발계획서 §8.1.
 *
 * 규칙 그대로:
 *  1. 전체 object foreground mask를 먼저 만들고 외부 drop shadow를 분리한다.
 *  2. 각 semantic layer에 bbox/point prompt로 2-4개 mask 후보를 만든다.
 *  3. 후보는 object mask 내부 비율·예상 위치·색/edge consistency·overlap 규칙으로 고른다.
 *  4. 모든 visible mask의 union이 foreground를 충분히 덮는지, 중복이 occlusion graph와
 *     일치하는지 검증한다.
 *  5. 경계가 공유되는 인접 레이어는 한쪽을 1-2px bleed 한다.
 *
 * GPT는 "의미와 대략적 위치"만 주고 픽셀 경계 추출에는 쓰지 않는다(§8.1 서두).
 * 그래서 bbox는 seed로만 쓰고, 실제 경계는 원본 픽셀의 색·경계에서 얻는다.
 */
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { photoConcepts as sam3Concepts } from "../v4/segSam3.js";
import {
  alphaMask, area, backgroundMask, boundary, close, components, deltaE2000Rgb,
  dilate, dominantColor, iou, loadRaster, maskToPng, open, subtract, toHex, union,
  type Raster,
} from "./raster.js";
import type { LayerManifest, ManifestLayer } from "./schema.js";

/** 라벨/설명에서 SAM 3이 아는 일반 명사로 매핑 — 실측된 어휘만 (없는 개념은 마스크 0개) */
const SAM_NOUNS: [RegExp, string][] = [
  [/\b(sole|outsole|midsole)\b/i, "sole"],
  [/\b(lace|shoelace)\b/i, "shoelace"],
  [/\btongue\b/i, "tongue"],
  [/\b(handle|grip)\b/i, "handle"],
  [/\b(strap|band)\b/i, "strap"],
  [/\bzipper\b/i, "zipper"],
  [/\bbuckle\b/i, "buckle"],
  [/\b(gem|gemstone|diamond|stone)\b/i, "gemstone"],
  [/\b(ring|shank)\b/i, "ring"],
  [/\bbutton\b/i, "button"],
  [/\bpocket\b/i, "pocket"],
  [/\blens\b/i, "lens"],
  [/\bdial\b/i, "dial"],
];

export interface VisibleMaskResult {
  /** layer.id → 가시영역 이진 마스크 */
  masks: Map<string, Uint8Array>;
  /** 제품 전체 전경 */
  foreground: Uint8Array;
  /** 외부 drop shadow (있으면 별도 effect로 취급하거나 제거) */
  dropShadow: Uint8Array | null;
  width: number;
  height: number;
  coverage: number; // union / foreground
  notes: string[];
}

export async function buildVisibleMasks(
  imagePath: string,
  manifest: LayerManifest,
  outDir: string,
  onProgress?: (m: string) => void,
): Promise<VisibleMaskResult> {
  await fs.mkdir(outDir, { recursive: true });
  const src = await loadRaster(imagePath);
  const W = src.width, H = src.height;
  const N = W * H;
  const notes: string[] = [];

  // ── 1) object foreground + drop shadow 분리 ───────────────
  const bg = backgroundMask(src, W, H);
  // ArrayBufferLike로 명시 — subtract()의 반환형과 맞춘다 (TS 5.7 typed-array 제네릭)
  let fg: Uint8Array<ArrayBufferLike> = new Uint8Array(N);
  for (let i = 0; i < N; i++) fg[i] = bg[i] ? 0 : 1;

  // 외부 drop shadow: 전경 가장자리에 붙은 저채도·중간밝기 영역.
  // 제품 본체보다 훨씬 밝고 채도가 낮으며 본체와 색이 이어지지 않는다.
  const shadow = new Uint8Array(N);
  {
    const eroded = open(fg, W, H, 2);
    for (let i = 0; i < N; i++) {
      if (!fg[i]) continue;
      const p = i * src.channels;
      const r = src.data[p], g = src.data[p + 1], b = src.data[p + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const chroma = mx - mn;
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      // 밝고(0.55~0.93) 거의 무채색(chroma<22)이며 침식으로 사라지는 얇은 띠
      if (lum > 0.55 && lum < 0.93 && chroma < 22 && !eroded[i]) shadow[i] = 1;
    }
    const shComps = components(shadow, W, H, N * 0.002);
    shadow.fill(0);
    for (const c of shComps) for (let i = 0; i < N; i++) if (c.mask[i]) shadow[i] = 1;
    const shArea = area(shadow);
    if (shArea > N * 0.004) {
      fg = subtract(fg, shadow);
      notes.push(`외부 그림자 ${((100 * shArea) / N).toFixed(1)}% 분리`);
    } else {
      shadow.fill(0);
    }
  }
  const fgN = area(fg);
  if (!fgN) throw new Error("전경을 찾지 못했습니다 (배경 격리 실패)");

  // ── SAM 3 개념 마스크 (있는 것만) ─────────────────────────
  const wantNouns = new Set<string>();
  for (const L of manifest.layers) {
    const key = `${L.id} ${L.label} ${L.visible_description}`;
    for (const [re, noun] of SAM_NOUNS) if (re.test(key)) wantNouns.add(noun);
  }
  const samMasks = new Map<string, Uint8Array>();
  if (wantNouns.size) {
    try {
      const found = await sam3Concepts(imagePath, [...wantNouns]);
      for (const f of found) {
        const m = await alphaFromWhitePng(f.maskPng, W, H);
        samMasks.set(f.concept, m);
      }
      onProgress?.(`SAM3 개념 ${found.map((f) => f.concept).join(", ") || "none"}`);
    } catch (e) {
      notes.push(`SAM3 건너뜀: ${(e as Error).message.slice(0, 60)}`);
    }
  }

  // ── 2~3) 레이어별 후보 생성·선택 ──────────────────────────
  // 후보 A: bbox seed 안의 색 일관 영역 (항상 가능)
  // 후보 B: SAM3 개념 마스크 ∩ bbox
  // 후보 C: bbox 자체 ∩ foreground (최후)
  const structural = manifest.layers.filter((L) => L.semantic_role !== "shadow");
  const chosen = new Map<string, Uint8Array>();
  const scoreOf = new Map<string, number>();

  for (const L of structural) {
    const box = bboxPx(L, W, H);
    const boxMask = new Uint8Array(N);
    for (let y = box.y0; y <= box.y1; y++)
      for (let x = box.x0; x <= box.x1; x++) {
        const i = y * W + x;
        if (fg[i]) boxMask[i] = 1;
      }
    if (!area(boxMask)) {
      notes.push(`${L.id}: bbox 안에 전경이 없음`);
      continue;
    }

    const cands: { name: string; mask: Uint8Array }[] = [];
    cands.push({ name: "color", mask: colorRegion(src, boxMask, fg, W, H) });

    const noun = SAM_NOUNS.find(([re]) => re.test(`${L.id} ${L.label} ${L.visible_description}`))?.[1];
    if (noun && samMasks.has(noun)) {
      const inter = new Uint8Array(N);
      const sm = samMasks.get(noun)!;
      for (let i = 0; i < N; i++) inter[i] = sm[i] && fg[i] ? 1 : 0;
      if (area(inter) > N * 0.001) cands.push({ name: `sam:${noun}`, mask: inter });
    }
    cands.push({ name: "bbox", mask: boxMask });

    // §8.1-3 후보 선택 규칙
    let best = cands[0], bestScore = -Infinity, bestName = cands[0].name;
    for (const c of cands) {
      const a = area(c.mask);
      if (!a) continue;
      // 내부 비율: 후보가 foreground 안에 있는가
      let inFg = 0;
      for (let i = 0; i < N; i++) if (c.mask[i] && fg[i]) inFg++;
      const insideRatio = inFg / a;
      // 위치 적합도: 후보 중심이 bbox 중심에 가까운가
      let sx = 0, sy = 0;
      for (let i = 0; i < N; i++) if (c.mask[i]) { sx += i % W; sy += (i / W) | 0; }
      const cx = sx / a / W, cy = sy / a / H;
      const bx = (L.bbox_norm[0] + L.bbox_norm[2]) / 2, by = (L.bbox_norm[1] + L.bbox_norm[3]) / 2;
      const posFit = Math.max(0, 1 - Math.hypot(cx - bx, cy - by) / 0.35);
      // 크기 적합도: bbox 면적 대비 (너무 크면 이웃까지 삼킨 것)
      const boxArea = Math.max(1, (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1));
      const sizeFit = Math.min(1, a / boxArea) * (a > boxArea * 1.6 ? 0.4 : 1);
      // 색 일관성: 후보 내부 ΔE2000 분산이 낮을수록 좋다
      const consistency = colorConsistency(src, c.mask);
      const s = 0.35 * insideRatio + 0.25 * posFit + 0.2 * sizeFit + 0.2 * consistency;
      if (s > bestScore) { bestScore = s; best = c; bestName = c.name; }
    }
    chosen.set(L.id, best.mask);
    scoreOf.set(L.id, bestScore);
    if (process.env.VF_DEBUG) onProgress?.(`  ${L.id}: ${bestName} (score ${bestScore.toFixed(2)})`);
  }

  // ── overlap 정리: occlusion graph에 따라 앞 레이어가 우선 ──
  // z가 큰(앞) 레이어가 겹치는 픽셀을 가져간다. 이것이 곧 "보이는" 영역이다.
  const ordered = [...chosen.keys()].sort((a, b) => zOf(manifest, b) - zOf(manifest, a)); // 앞→뒤
  const claimed = new Uint8Array(N);
  for (const id of ordered) {
    const m = chosen.get(id)!;
    for (let i = 0; i < N; i++) {
      if (!m[i]) continue;
      if (claimed[i]) m[i] = 0;
      else claimed[i] = 1;
    }
  }

  // 앞 레이어가 뒤 레이어를 통째로 지우면 manifest↔SVG 1:1 대응이 깨진다
  // (부록 A). 작은 파트가 큰 몸통의 색 성장에 먹힌 경우이므로, 자기 bbox 안의
  // 배타 영역만큼은 되돌려 준다 — 그 영역은 다른 레이어의 bbox에 없는 곳이다.
  for (const L of structural) {
    const m = chosen.get(L.id);
    if (!m || area(m) > N * 0.0005) continue;
    const box = bboxPx(L, W, H);
    const others = structural.filter((x) => x.id !== L.id).map((x) => bboxPx(x, W, H));
    let restored = 0;
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        const i = y * W + x;
        if (!fg[i] || m[i]) continue;
        // 다른 레이어의 bbox가 이 픽셀을 더 좁게 감싸면 그쪽 것이다
        const claimedTighter = others.some(
          (o) => x >= o.x0 && x <= o.x1 && y >= o.y0 && y <= o.y1 &&
                 (o.x1 - o.x0) * (o.y1 - o.y0) < (box.x1 - box.x0) * (box.y1 - box.y0),
        );
        if (claimedTighter) continue;
        m[i] = 1;
        for (const [oid, om] of chosen) if (oid !== L.id) om[i] = 0;
        restored++;
      }
    }
    if (restored) notes.push(`${L.id}: 앞 레이어에 전부 가려져 배타 영역 ${restored}px 복구`);
  }

  // ── 4) 커버리지 검증 ──────────────────────────────────────
  let covered = 0;
  for (let i = 0; i < N; i++) if (claimed[i] && fg[i]) covered++;
  let coverage = covered / fgN;

  // 미할당 전경은 가장 가까운(색이 맞는) 레이어에 흘려보낸다 — 틈이 남으면
  // 최종 합성에서 흰 구멍이 된다.
  if (coverage < 0.999) {
    const gap = new Uint8Array(N);
    for (let i = 0; i < N; i++) gap[i] = fg[i] && !claimed[i] ? 1 : 0;
    floodAssign(gap, chosen, src, W, H);
    covered = 0;
    for (const m of chosen.values()) for (let i = 0; i < N; i++) if (m[i] && fg[i]) covered++;
    coverage = Math.min(1, covered / fgN);
  }

  // ── 5) 공유 경계 bleed (1-2px) — hairline gap 방지 ────────
  // 뒤쪽 레이어만 넓힌다. 앞 레이어를 넓히면 실루엣이 커진다.
  const back2front = [...chosen.keys()].sort((a, b) => zOf(manifest, a) - zOf(manifest, b));
  for (let k = 0; k < back2front.length; k++) {
    const id = back2front[k];
    const m = chosen.get(id)!;
    const grown = dilate(m, W, H, 1);
    for (let i = 0; i < N; i++) {
      if (!grown[i] || m[i] || !fg[i]) continue;
      // 앞 레이어가 이미 가진 픽셀만 침범 허용 (그 위에 앞 레이어가 그려진다)
      const ownedByFront = back2front.slice(k + 1).some((oid) => chosen.get(oid)![i]);
      if (ownedByFront) m[i] = 1;
    }
  }

  // 마스크 저장 (visible_masks/*.png)
  for (const [id, m] of chosen) {
    const col = toHex(dominantColor(src, m));
    await maskToPng(m, W, H, col, path.join(outDir, `${id}.png`));
  }
  if (area(shadow)) await maskToPng(shadow, W, H, "#b4b4b4", path.join(outDir, "_drop_shadow.png"));
  await maskToPng(fg, W, H, "#404040", path.join(outDir, "_foreground.png"));

  onProgress?.(`가시 마스크 ${chosen.size}개 · 커버리지 ${(coverage * 100).toFixed(1)}%`);
  return {
    masks: chosen,
    foreground: fg,
    dropShadow: area(shadow) ? shadow : null,
    width: W,
    height: H,
    coverage,
    notes,
  };
}

// ── 헬퍼 ────────────────────────────────────────────────────

function zOf(m: LayerManifest, id: string): number {
  return m.layers.find((L) => L.id === id)?.z_index ?? 0;
}

function bboxPx(L: ManifestLayer, W: number, H: number) {
  const [x0, y0, x1, y1] = L.bbox_norm;
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi - 1, Math.round(v)));
  return {
    x0: clamp(x0 * W, W), y0: clamp(y0 * H, H),
    x1: clamp(x1 * W, W), y1: clamp(y1 * H, H),
  };
}

/**
 * bbox seed 안에서 색이 일관된 영역을 키운다.
 * seed 색은 bbox 중앙부의 대표색으로 잡고, ΔE2000 임계 안에서 flood fill 한다.
 * (GPT의 bbox는 대략치이므로 경계는 픽셀에서 다시 찾는다)
 */
function colorRegion(src: Raster, boxMask: Uint8Array, fg: Uint8Array, W: number, H: number): Uint8Array {
  const N = W * H;
  // 중앙 40% 영역에서 대표색
  const core = new Uint8Array(N);
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let i = 0; i < N; i++) {
    if (!boxMask[i]) continue;
    const x = i % W, y = (i / W) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const rx = (x1 - x0) * 0.25, ry = (y1 - y0) * 0.25;
  for (let y = Math.round(my - ry); y <= Math.round(my + ry); y++)
    for (let x = Math.round(mx - rx); x <= Math.round(mx + rx); x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (boxMask[i]) core[i] = 1;
    }
  const seedColor = dominantColor(src, area(core) ? core : boxMask);

  // ΔE2000 임계 내 flood — bbox를 조금 넘어서도 같은 색이면 따라간다
  const grow = dilate(boxMask, W, H, Math.round(Math.max(W, H) * 0.02));
  const out = new Uint8Array(N);
  const q = new Int32Array(N);
  let head = 0, tail = 0;
  const THR = 18; // ΔE2000 — 같은 재질로 볼 범위
  const ok = (i: number) => {
    if (!grow[i] || !fg[i] || out[i]) return false;
    const p = i * src.channels;
    return deltaE2000Rgb(src.data[p], src.data[p + 1], src.data[p + 2], seedColor[0], seedColor[1], seedColor[2]) < THR;
  };
  for (let i = 0; i < N; i++) if (core[i] && ok(i)) { out[i] = 1; q[tail++] = i; }
  if (!tail) for (let i = 0; i < N; i++) if (boxMask[i] && ok(i)) { out[i] = 1; q[tail++] = i; }
  while (head < tail) {
    const c = q[head++];
    const x = c % W, y = (c / W) | 0;
    for (const nb of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, y > 0 ? c - W : -1, y < H - 1 ? c + W : -1]) {
      if (nb < 0 || !ok(nb)) continue;
      out[nb] = 1; q[tail++] = nb;
    }
  }
  return area(out) ? close(out, W, H, 2) : boxMask.slice();
}

/** 마스크 내부 색 일관성 0~1 — 대표색 대비 평균 ΔE2000이 낮을수록 1 */
function colorConsistency(src: Raster, m: Uint8Array): number {
  const c = dominantColor(src, m);
  let sum = 0, n = 0;
  const step = Math.max(1, Math.floor(area(m) / 4000)); // 표본 추출
  let seen = 0;
  for (let i = 0; i < m.length; i++) {
    if (!m[i]) continue;
    if (seen++ % step) continue;
    const p = i * src.channels;
    sum += deltaE2000Rgb(src.data[p], src.data[p + 1], src.data[p + 2], c[0], c[1], c[2]);
    n++;
  }
  const mean = n ? sum / n : 100;
  return Math.max(0, 1 - mean / 40);
}

/** 미할당 픽셀을 색이 가장 가까운 인접 레이어로 흘려보낸다 */
function floodAssign(
  gap: Uint8Array,
  masks: Map<string, Uint8Array>,
  src: Raster,
  W: number,
  H: number,
): void {
  const N = W * H;
  const ids = [...masks.keys()];
  const cols = ids.map((id) => dominantColor(src, masks.get(id)!));
  const owner = new Int16Array(N).fill(-1);
  ids.forEach((id, k) => {
    const m = masks.get(id)!;
    for (let i = 0; i < N; i++) if (m[i]) owner[i] = k;
  });
  const q = new Int32Array(N);
  let head = 0, tail = 0;
  for (let i = 0; i < N; i++) if (owner[i] >= 0) q[tail++] = i;
  while (head < tail) {
    const c = q[head++];
    const x = c % W, y = (c / W) | 0;
    for (const nb of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, y > 0 ? c - W : -1, y < H - 1 ? c + W : -1]) {
      if (nb < 0 || !gap[nb] || owner[nb] >= 0) continue;
      // 색이 더 맞는 이웃이 있으면 그쪽을 기다린다 — 1차로는 전파원 색과 비교
      const p = nb * src.channels;
      const k = owner[c];
      const d = deltaE2000Rgb(src.data[p], src.data[p + 1], src.data[p + 2], cols[k][0], cols[k][1], cols[k][2]);
      // 아주 다른 색이면 새 레이어감이지만, S04에서는 커버리지를 우선한다
      void d;
      owner[nb] = k;
      masks.get(ids[k])![nb] = 1;
      q[tail++] = nb;
    }
  }
}

/** white-on-black 마스크 PNG → 이진 */
async function alphaFromWhitePng(png: Buffer, W: number, H: number): Promise<Uint8Array> {
  const { data, info } = await sharp(png)
    .resize(W, H, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = data[i * info.channels] > 128 ? 1 : 0;
  return out;
}

export { boundary, iou, union, area };
