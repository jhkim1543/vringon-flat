/**
 * **실루엣 전용 산출물** — 제품의 바깥 윤곽 하나만, 닫힌 패스로.
 *
 * 세 직군이 같은 것을 요구했다.
 *   모델리스타   "패턴 제작용으로 순수한 외곽선만 단일 패스로"
 *   핸드백 디자이너 "내부 크로셰는 빼고 외곽 실루엣만"
 *   레이저 오퍼레이터 "커팅용 가장 바깥 폐곡선 하나"
 *
 * 촘촘한 질감 제품의 앵커 2만 개는 **줄일 수 없다** — 그물의 구멍이 실제로 수천 개이기
 * 때문이다. 그래서 줄이는 대신 **쓸 수 있는 최소 산출물을 따로 낸다.** 내부를 버리는
 * 것은 손실이 아니라 그 용도에서는 목적이다.
 *
 * 만드는 법: 파트 마스크의 합집합을 닫고(구멍 메우기) 바깥 윤곽만 추적한다.
 * 잉크가 아니라 **마스크**에서 뽑는 것이 중요하다 — 잉크는 선이라 안쪽 윤곽도 딸려온다.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { vectorize, ColorMode, Hierarchical, PathSimplifyMode } from "@neplex/vectorizer";
import sharp from "sharp";
import { refitPath, thinAnchors } from "./refit.js";
import { splitCompound } from "./compound.js";

export interface SilhouetteOpts {
  /** 작업 캔버스 크기 */
  width: number;
  height: number;
  /** 임시 파일을 쓸 곳 */
  workDir: string;
  /** 단순화 허용오차(px) */
  simplifyPx?: number;
  /** 이 면적 미만 조각은 버린다 (캔버스 대비 비율) */
  minAreaRatio?: number;
}

/** 구멍을 메운다 — 바깥 윤곽만 남기기 위해 */
function fillHoles(m: Uint8Array, W: number, H: number): Uint8Array {
  const out = new Uint8Array(W * H).fill(1);
  const stack: number[] = [];
  const seen = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) { stack.push(x, (H - 1) * W + x); }
  for (let y = 0; y < H; y++) { stack.push(y * W, y * W + W - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    if (seen[i] || m[i]) continue;
    seen[i] = 1; out[i] = 0;
    const x = i % W, y = (i / W) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < W - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - W);
    if (y < H - 1) stack.push(i + W);
  }
  return out;
}

function dilate(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
  let cur = m;
  for (let it = 0; it < r; it++) {
    const nx = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (cur[i] || (x > 0 && cur[i - 1]) || (x < W - 1 && cur[i + 1])
          || (y > 0 && cur[i - W]) || (y < H - 1 && cur[i + W])) nx[i] = 1;
      }
    }
    cur = nx;
  }
  return cur;
}

function erode(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
  let cur = m;
  for (let it = 0; it < r; it++) {
    const nx = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (cur[i] && cur[i - 1] && cur[i + 1] && cur[i - W] && cur[i + W]) nx[i] = 1;
      }
    }
    cur = nx;
  }
  return cur;
}

/**
 * 파트 마스크들에서 바깥 실루엣 패스를 뽑는다.
 *
 * @returns 닫힌 패스의 `d` 목록 (보통 1개, 제품이 갈라져 있으면 여러 개)
 */
export async function buildSilhouette(
  masks: Uint8Array[],
  o: SilhouetteOpts,
): Promise<{ paths: string[]; anchors: number }> {
  const { width: W, height: H } = o;
  const N = W * H;
  if (!masks.length) return { paths: [], anchors: 0 };

  const uni = new Uint8Array(N);
  for (const m of masks) for (let i = 0; i < N; i++) if (m[i]) uni[i] = 1;

  // 닫고(작은 틈 메우기) → 구멍 메우기 → 다시 원래 크기로
  const r = Math.max(2, Math.round(Math.min(W, H) * 0.004));
  const closed = erode(dilate(uni, W, H, r), W, H, r);
  const solid = fillHoles(closed, W, H);

  let n = 0;
  for (let i = 0; i < N; i++) n += solid[i];
  if (!n) return { paths: [], anchors: 0 };

  const tmp = path.join(o.workDir, "silhouette.png");
  const buf = Buffer.alloc(N);
  for (let i = 0; i < N; i++) buf[i] = solid[i] ? 0 : 255;
  await sharp(buf, { raw: { width: W, height: H, channels: 1 } }).png().toFile(tmp);

  const eps = o.simplifyPx ?? 2;
  const svg = await vectorize(await fsp.readFile(tmp), {
    colorMode: ColorMode.Binary,
    hierarchical: Hierarchical.Cutout,
    mode: PathSimplifyMode.Spline,
    filterSpeckle: Math.max(4, Math.round(eps * 4)),
    colorPrecision: 6, layerDifference: 16, cornerThreshold: 60,
    lengthThreshold: 4, maxIterations: 10, spliceThreshold: 45,
    pathPrecision: 2,
  });

  const minArea = N * (o.minAreaRatio ?? 0.005);
  const out: string[] = [];
  let anchors = 0;
  for (const m of svg.matchAll(/<path([^>]*)\sd="([^"]+)"([^>]*)>/g)) {
    const attrs = m[1] + m[3];
    const f = (/fill="([^"]*)"/.exec(attrs)?.[1] ?? "").trim().toLowerCase();
    if (f === "#fff" || f === "#ffffff" || f === "white") continue;
    // **vtracer 는 패스에 translate 를 붙인다.** 그걸 안 풀면 좌표가 음수로 나가고
    // 실루엣이 캔버스 밖으로 밀린다(실측 bag_05: bbox 가 x=-755 에서 시작했다).
    let dd = m[2];
    const tr = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(attrs);
    if (tr) {
      const tx = parseFloat(tr[1]), ty = parseFloat(tr[2]);
      let k = 0;
      dd = dd.replace(/-?\d*\.?\d+/g, (num) =>
        String(Math.round((parseFloat(num) + (k++ % 2 === 0 ? tx : ty)) * 100) / 100));
    }
    for (const d of splitCompound(dd)) {
      // 넓이가 작은 조각은 실루엣이 아니다 — 그림자 잔해·잡티
      const nums = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i + 1 < nums.length; i += 2) {
        if (nums[i] < x0) x0 = nums[i]; if (nums[i] > x1) x1 = nums[i];
        if (nums[i + 1] < y0) y0 = nums[i + 1]; if (nums[i + 1] > y1) y1 = nums[i + 1];
      }
      if ((x1 - x0) * (y1 - y0) < minArea) continue;
      const clean = thinAnchors(refitPath(d, eps).d, eps * 0.5);
      out.push(clean);
      anchors += (clean.match(/[MLC]/g) ?? []).length;
    }
  }
  return { paths: out, anchors };
}

/** 실루엣만 담은 최소 SVG — 커팅·패턴용 */
export function silhouetteSvg(paths: string[], W: number, H: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n` +
    `  <g id="SILHOUETTE" fill="none" stroke="#000000" stroke-width="1">\n` +
    paths.map((d) => `    <path d="${d}"/>`).join("\n") +
    `\n  </g>\n</svg>`;
}
