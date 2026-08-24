/**
 * Phase B 1단계 — **도면 자체를 직접 segment 한다.**
 *
 * 지금까지 파트 마스크는 사진에서 만들어 전역 similarity 로 도면에 warp 했다. 도면은
 * 모델이 다시 그린 그림이라 비율이 다르다(실측: bag_1 종횡비 19.8% 불일치) — warp 로는
 * 원리적으로 안 맞고, 그것이 의미 gate 0/9 의 천장이었다.
 *
 * Gemini 2.5 Flash 에게 도면에서 파트 외곽 **폴리곤**을 받는다. 시도 순서에 근거가 있다:
 *   · native segmentation(mask 키)은 REST 로는 `<seg_N>` 특수 토큰이 그대로 내려와
 *     쓸 수 없었다(실측 — 서버측 후처리가 안 붙는다).
 *   · `thinkingBudget: 0` 은 좌표 나열에서 무한 반복을 일으켰다(MAX_TOKENS 실측).
 *     thinking 기본값 + temperature 0.6 이 안정적이다. 그래도 가끔 루프가 남아
 *     MAX_TOKENS·파싱 실패 시 재시도한다.
 *   · 설명만 주면 엉뚱한 영역을 잡는다(front_flap 실측). **warp 된 사진 마스크의 bbox 를
 *     힌트**로 주면 정확해진다 — warp 가 부정확해도 대략의 위치는 맞기 때문에, 정밀
 *     경계는 Gemini 가, 대략 위치는 warp 가 맡는 역할 분담이 된다.
 *
 * 경계 정밀도는 여기서 끝나지 않는다 — scene.ts 의 면 배정이 닫힌 면(도면 선이 감싼
 * 영역) 단위로 이뤄지므로, 폴리곤이 선을 몇 px 넘어도 면 전체 겹침으로 흡수된다.
 * SAM 3 정교화는 FAL 키가 들어오면 이 사이에 끼운다.
 */
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { config } from "../config.js";
import { withRetry } from "../clients/retry.js";
import type { PartPlan } from "../v3/partPlan.js";

export interface SegHint {
  id: string;
  /** 도면 좌표 0~1000 정규화 [y0, x0, y1, x1] */
  box: [number, number, number, number];
}

export interface SegPart {
  id: string;
  /** 도면 좌표(원본 해상도) 마스크 */
  mask: Uint8Array;
  areaShare: number;
  regions: number;
}

export interface SegResult {
  parts: SegPart[];
  width: number;
  height: number;
  notes: string[];
}

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

type Poly = { polygon: [number, number][] };

async function askPolygons(png: Buffer, ask: string, hint?: string): Promise<Poly[]> {
  const prompt =
    "This is a technical line drawing of a product. " +
    `Trace the exact visible outline of this part: ${ask}. ` +
    "Follow the drawn lines of the schematic closely. " +
    (hint ? hint + " " : "") +
    'Output JSON: a list with one entry per connected region, each entry an object with key "polygon" — ' +
    "a closed polygon as a list of [y, x] points normalized to 0-1000 (between 16 and 40 points, follow the shape, " +
    'not just a box) — and key "label".';

  // 루프(MAX_TOKENS)·파싱 실패가 확률적으로 난다 — 온도를 올려가며 최대 3회
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = {
      contents: [{ parts: [
        { inlineData: { mimeType: "image/png", data: png.toString("base64") } },
        { text: prompt },
      ] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.6 + attempt * 0.2,
        maxOutputTokens: 16384,
      },
    };
    try {
      const json = await withRetry(
        async () => {
          const res = await fetch(`${BASE}/${config.geminiVisionModel}:generateContent?key=${config.geminiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new Error(`Gemini seg ${res.status}: ${(await res.text()).slice(0, 200)}`);
          return res.json() as Promise<{
            candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
          }>;
        },
        { label: "Gemini seg" },
      );
      const cand = json.candidates?.[0];
      const text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (cand?.finishReason === "MAX_TOKENS") throw new Error("좌표 나열 루프 (MAX_TOKENS)");
      const arr = JSON.parse(text);
      const list = (Array.isArray(arr) ? arr : [arr]) as Poly[];
      return list.filter((e) => Array.isArray(e?.polygon) && e.polygon.length >= 3);
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error("Gemini seg 실패");
}

/** 폴리곤 → 마스크 (짝수-홀수 채움) */
function rasterizePolygon(out: Uint8Array, W: number, H: number, poly: [number, number][]): void {
  const pts = poly.map(([y, x]) => [(x / 1000) * W, (y / 1000) * H] as [number, number]);
  let y0 = H, y1 = 0;
  for (const [, y] of pts) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(H - 1, Math.ceil(y1)); y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= y && by > y) || (by <= y && ay > y)) {
        xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.round(xs[k])), xb = Math.min(W - 1, Math.round(xs[k + 1]));
      for (let x = xa; x <= xb; x++) out[y * W + x] = 1;
    }
  }
}

/**
 * 도면에서 파트 마스크를 직접 받는다. 응답은 (도면 sha × 파트 목록) 으로 캐시한다 —
 * 같은 도면을 다시 돌릴 때 재과금하지 않는다.
 */
export async function segmentSchematic(
  schematicPath: string,
  plan: PartPlan,
  hints: SegHint[],
  cacheDir: string,
  onProgress?: (m: string) => void,
): Promise<SegResult> {
  const meta = await sharp(schematicPath).metadata();
  const W = meta.width!, H = meta.height!;
  const notes: string[] = [];
  const hintById = new Map(hints.map((h) => [h.id, h.box]));

  const labels = plan.parts.map((p) => ({
    id: p.id,
    ask: `${p.label} — ${p.description}`.slice(0, 160),
  }));

  const sha = crypto.createHash("sha256")
    .update(await fs.readFile(schematicPath))
    .update(JSON.stringify(labels))
    .update("poly-v1")
    .digest("hex").slice(0, 16);
  const cachePath = path.join(cacheDir, `gemini_seg_${sha}.json`);

  type Tagged = { _part: string; polys: Poly[] };
  let raw: Tagged[];
  try {
    raw = JSON.parse(await fs.readFile(cachePath, "utf8"));
    onProgress?.(`Gemini seg 캐시 재사용 (${raw.length}파트)`);
  } catch {
    const png = await sharp(schematicPath).flatten({ background: "#ffffff" }).png().toBuffer();
    raw = [];
    for (const l of labels) {
      const box = hintById.get(l.id);
      const hint = box
        ? `Hint: in a photo of the same product this part occupied roughly the box ` +
          `[y ${box[0]}..${box[2]}, x ${box[1]}..${box[3]}] in 0-1000 coordinates; ` +
          `in this drawing it should be in a similar region.`
        : undefined;
      try {
        const polys = await askPolygons(png, l.ask, hint);
        raw.push({ _part: l.id, polys });
        onProgress?.(`  ${l.id}: 영역 ${polys.length}개`);
      } catch (e) {
        notes.push(`${l.id} 호출 실패: ${(e as Error).message.slice(0, 80)}`);
      }
    }
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(raw), "utf8");
  }

  const parts: SegPart[] = [];
  for (const t of raw) {
    const mask = new Uint8Array(W * H);
    for (const p of t.polys) rasterizePolygon(mask, W, H, p.polygon);
    let n = 0;
    for (let i = 0; i < mask.length; i++) n += mask[i];
    if (n < W * H * 0.0005) { notes.push(`${t._part}: 폴리곤이 사실상 빔`); continue; }
    parts.push({ id: t._part, mask, areaShare: n / (W * H), regions: t.polys.length });
  }
  const missing = plan.parts.filter((p) => !parts.some((s) => s.id === p.id)).map((p) => p.id);
  if (missing.length) notes.push(`도면에서 못 받은 파트: ${missing.join(", ")}`);

  return { parts, width: W, height: H, notes };
}

/**
 * 마스크를 도면의 **닫힌 면 단위로 스냅**한다.
 *
 * Gemini 폴리곤은 16~40점 근사라 경계가 도면 선과 정확히 일치하지 않는다 — 실측으로
 * precision 은 오르지만(경계를 넘는 일이 적다) recall 이 떨어졌다(영역을 덜 덮는다).
 * 도면에서 파트 경계는 반드시 그려진 선이므로, 선이 감싼 면(face)을 원자 단위로 삼아
 * "폴리곤이 면의 25% 이상을 덮으면 면 전체를 귀속"으로 바꾸면 둘 다 잡힌다.
 *
 * 선 픽셀 자체는 인접한 귀속 면이 있는 파트들 모두에 남긴다(공유 경계).
 */
export function snapMasksToFaces(
  masks: { id: string; mask: Uint8Array }[],
  ink: Uint8Array,
  W: number,
  H: number,
): { id: string; mask: Uint8Array }[] {
  const N = W * H;
  // 잉크를 살짝 닫아 face 를 만든다 (scene.ts 와 같은 방식의 축소판)
  const inkFill = closeMask(ink, W, H, 1);

  // 캔버스 밖(테두리에서 닿는 배경)을 뺀 나머지 비잉크 = 닫힌 면
  const outside = new Uint8Array(N);
  {
    const stack: number[] = [];
    for (let x = 0; x < W; x++) { stack.push(x, (H - 1) * W + x); }
    for (let y = 0; y < H; y++) { stack.push(y * W, y * W + W - 1); }
    while (stack.length) {
      const i = stack.pop()!;
      if (outside[i] || inkFill[i]) continue;
      outside[i] = 1;
      const x = i % W, y = (i / W) | 0;
      if (x > 0) stack.push(i - 1);
      if (x < W - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - W);
      if (y < H - 1) stack.push(i + W);
    }
  }
  const enclosed = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (!inkFill[i] && !outside[i]) enclosed[i] = 1;

  const { labels, components } = labelComponents2(enclosed, W, H);

  const out = masks.map((m) => ({ id: m.id, mask: new Uint8Array(N) }));
  // 면마다 각 파트 마스크의 커버율을 잰다. 귀속 규칙에 순서가 있다:
  //   1) 커버율 40% 이상인 파트가 여럿이면 **가장 뒤(배열 끝 = z 최상위) 파트**.
  //      보이는 면은 그 자리의 최전면 파트 것이다 — 트림 밴드가 플랩 위에 있으면
  //      밴드 면은 밴드 소유다. argmax 로 하면 큰 폴리곤(플랩)이 좁은 파트의 면을
  //      전부 빼앗는다(실측: red_trim_bands recall 0.187 → 0.005 로 소멸).
  //   2) 아니면 커버율 argmax (25% 이상일 때만).
  // masks 배열은 호출부가 z 오름차순으로 준다.
  for (const c of components) {
    let best = -1, bestCov = 0, front = -1;
    for (let mi = 0; mi < masks.length; mi++) {
      let cov = 0;
      const mm = masks[mi].mask;
      for (let k = 0; k < c.pixels.length; k++) if (mm[c.pixels[k]]) cov++;
      if (cov > bestCov) { bestCov = cov; best = mi; }
      if (cov >= c.pixels.length * 0.4) front = mi;
    }
    const pick = front >= 0 ? front : (bestCov >= c.pixels.length * 0.25 ? best : -1);
    if (pick >= 0) {
      const om = out[pick].mask;
      for (let k = 0; k < c.pixels.length; k++) om[c.pixels[k]] = 1;
    }
  }
  // 선 픽셀: 원래 마스크가 덮던 잉크는 그대로 유지 (경계선·얇은 파트)
  for (let mi = 0; mi < masks.length; mi++) {
    const src = masks[mi].mask, dst = out[mi].mask;
    for (let i = 0; i < N; i++) if (src[i] && ink[i]) dst[i] = 1;
  }
  void labels;
  return out.filter((m) => {
    let n = 0;
    for (let i = 0; i < m.mask.length; i++) n += m.mask[i];
    return n > 0;
  });
}

function closeMask(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
  // dilate r → erode r (사각 구조요소)
  let cur = m;
  for (let pass = 0; pass < 2; pass++) {
    for (let it = 0; it < r; it++) {
      const nx = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const a = cur[i], l = x > 0 ? cur[i - 1] : a, rr = x < W - 1 ? cur[i + 1] : a;
          const u = y > 0 ? cur[i - W] : a, d = y < H - 1 ? cur[i + W] : a;
          nx[i] = pass === 0 ? (a || l || rr || u || d ? 1 : 0) : (a && l && rr && u && d ? 1 : 0);
        }
      }
      cur = nx;
    }
  }
  return cur;
}

function labelComponents2(mask: Uint8Array, W: number, H: number): {
  labels: Int32Array;
  components: { pixels: Int32Array }[];
} {
  const N = W * H;
  const labels = new Int32Array(N).fill(-1);
  const components: { pixels: Int32Array }[] = [];
  const stack: number[] = [];
  const buf: number[] = [];
  for (let i = 0; i < N; i++) {
    if (!mask[i] || labels[i] >= 0) continue;
    const id = components.length;
    buf.length = 0;
    stack.push(i);
    labels[i] = id;
    while (stack.length) {
      const j = stack.pop()!;
      buf.push(j);
      const x = j % W, y = (j / W) | 0;
      if (x > 0 && mask[j - 1] && labels[j - 1] < 0) { labels[j - 1] = id; stack.push(j - 1); }
      if (x < W - 1 && mask[j + 1] && labels[j + 1] < 0) { labels[j + 1] = id; stack.push(j + 1); }
      if (y > 0 && mask[j - W] && labels[j - W] < 0) { labels[j - W] = id; stack.push(j - W); }
      if (y < H - 1 && mask[j + W] && labels[j + W] < 0) { labels[j + W] = id; stack.push(j + W); }
    }
    components.push({ pixels: Int32Array.from(buf) });
  }
  return { labels, components };
}
