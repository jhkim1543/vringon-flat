/**
 * **사내 세그 우선(segmentation-first)** — VRINGON 의 카테고리별 SAM 3.1 패키지로 사진을 먼저
 * 파트로 나누고, 그 파트가 곧 레이어가 된다.
 *
 * 지금까지는 GPT 가 "이 제품은 어떤 부품으로 되어 있나"를 말로 정하고(파트 계획), 그 다음에
 * 마스크를 찾았다. 실측에서 이 계획이 실행마다 달랐고(jewelry_1 4파트↔3파트), 파트 이름이
 * 바뀌면 획·앵커가 통째로 달라졌다. 사내 워커(vringon-ai-workers-services `common.segmentation-sam3`)
 * 는 신발 27·가방 36·주얼리 14·상의 19·하의 15 클래스를 **고정 어휘**로 학습한 모델이라,
 * 파트 목록·순서(z_order)·이름이 결정적이고 사내 다른 기능(테크팩·CMF)과 같은 어휘를 쓴다.
 *
 * 워커 저장소의 세그 계약(`segmentation_config.py` 의 z_order / aliases / ignored_classes)을
 * 그대로 옮겼다 — 저장소는 손대지 않고 읽기만 했다. 모델은 H100 의 `partseg_worker.py` 가
 * 같은 벤더 런타임·같은 S3 패키지로 돌린다(HTTP, `VRINGON_SEG_URL` + `VRINGON_SEG_KEY`).
 *
 * 패키지가 없는 카테고리(안경·시계·기타)는 이 모듈이 null 을 돌려주고, 파이프라인은 기존
 * 경로(GPT 파트 계획 + 일반 SAM 개념 마스크)로 간다.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { PartPlan, ProductPart } from "../v3/partPlan.js";
import { labelComponents } from "../v3/label.js";
import type { SubjectBox } from "../v3/subject.js";

/** 사용자 카테고리 힌트 → 사내 세그 카테고리 (워커 `part_segmentation/src/categories.py` 와 같은 별칭) */
export function vringonSegCategory(hint?: string): string | null {
  const h = (hint ?? "").toLowerCase().trim().split(":")[0];
  if (!h) return null;
  if (/\b(shoe|shoes|sneaker|sneakers|footwear|boot|boots|sandal|sandals|heel|heels|loafer|loafers)\b/.test(h)) return "shoe";
  if (/\b(bag|bags|handbag|backpack|tote|clutch|wallet|purse)\b/.test(h)) return "bag";
  if (/\b(jewelry|jewellery|jewel|ring|rings|necklace|earring|earrings|bracelet|bangle|pendant|brooch|cuff)\b/.test(h)) return "jewelry";
  if (/\b(top|tops|outer|outers|outerwear|outwear|jacket|shirt|blouse|hoodie|sweater|coat|t-shirt|tee)\b/.test(h)) return "top/outwear-clothing";
  if (/\b(bottom|bottoms|pants|jeans|shorts|skirt|skirts|dress|dresses|trousers)\b/.test(h)) return "bottom-clothing";
  return null;
}

/** 워커 `segmentation_config.py` — z_order(뒤→앞) · 별칭 · 무시 클래스. 그대로 옮김. */
const SEG_CONFIG: Record<string, { zOrder: string[]; aliases: Record<string, string>; ignored: string[] }> = {
  shoe: {
    aliases: {
      buckel: "buckle", upper: "quarter", sidelogo: "logo",
      "quarter-TPU": "quarter", "quarter-fabric": "quarter", "quarter-leather": "quarter", "quarter-rubber": "quarter",
      "sol-air": "midsole", "sol-plastic": "midsole", "patch-leather": "decoration", "patch-plastic": "decoration",
    },
    ignored: ["lining"],
    zOrder: ["outsole", "heel", "midsole", "vamp", "quarter", "backcounter", "toecap", "tongue", "eyestay", "topline",
      "loop", "logo", "decoration", "zipper", "laces", "strap", "velcro", "buckle", "button", "heeltap"],
  },
  bag: {
    aliases: { "metal-zipper": "zipper", "vislon-zipper": "zipper", ring: "unclassified", bombay: "unclassified" },
    ignored: ["bag-SBkK-EymT-UNxY"],
    zOrder: ["unclassified", "panel-back", "panel-bottom", "panel-side", "panel-top", "panel-front", "bridge", "inside-pouch",
      "opening", "flap", "pocket", "patch", "d-ring-patch", "binding", "edge-paint", "piping", "top-stitching", "zipper-collar",
      "opening-strap", "handle", "shoulder-strap", "strap", "drawstring", "chain", "closure-zipper", "zipper", "closure-button",
      "buckle", "snap", "m-hook", "hidden-magnet", "d-ring", "square-ring", "slider-d-ring", "adjustor", "dog-leash", "puller",
      "rivet", "stud"],
  },
  "top/outwear-clothing": {
    aliases: {}, ignored: [],
    zOrder: ["quarter", "facing", "logo", "decoration", "pocket", "hem", "sleeve", "cuffs", "placket", "pocket-zipper", "zipper",
      "button", "neck", "loop", "collar", "lapel", "hood", "lace", "tag"],
  },
  "bottom-clothing": {
    aliases: {}, ignored: [],
    zOrder: ["quarter", "pocket", "hem", "cuffs", "band", "logo", "decoration", "placket", "zipper", "beltloop", "loop", "lace",
      "button", "hook", "tag"],
  },
  jewelry: {
    aliases: {}, ignored: [],
    zOrder: ["backing", "post", "pin", "chain", "clasp", "bail", "body", "pendant", "engrave", "jewel", "sidejewel", "decoration",
      "logo", "claw"],
  },
};

/** 표면 표기(로고·각인·스티치)는 독립 부품이 아니라 marking — 글리프 판정과 레이어 역할이 갈린다 */
const MARKING = new Set(["logo", "engrave", "top-stitching", "edge-paint", "tag"]);

export interface VringonSegResult {
  category: string;
  package: string;
  engine: string;
  /** 사진(canonical) 좌표의 파트 마스크 — z 순서(뒤→앞) */
  masks: Map<string, Uint8Array>;
  plan: PartPlan;
  /** 파트별 점수·인스턴스 수 (로그·리포트용) */
  detail: { id: string; score: number; instances: number; areaPct: number }[];
  cached: boolean;
  /**
   * 파트 마스크 합집합의 상자 — 사진↔도면 정합의 기준. 배경 검출 상자(detectSubject)는
   * 그림자·배경 잔여·반사상까지 품지만, 이 상자는 모델이 "제품"이라고 한 픽셀만 품는다.
   */
  foregroundBox: SubjectBox;
  /** 거울 반사로 판정해 지운 성분 수 */
  reflectionsRemoved: number;
}

/**
 * **거울 반사상 제거.** 유리판 위 촬영은 제품 아래에 뒤집힌 상이 생기고, 세그 모델은 그것도
 * 충실히 같은 파트로 잡는다(실측 jewelry_2: body ×2). 도면 모델은 반사를 그리지 않으므로 반사를
 * 두면 사진↔도면 정합이 반사만큼 어긋난다(마스크 정합 0.94 → 0.48).
 * 판정: 전경 성분 중 가장 큰 것(A) 아래에 붙어 있고(가로 겹침 ≥ 60%), 둘의 경계선에 대해
 * 상하로 뒤집었을 때 A 와 겹치는(IoU ≥ 0.25) 성분은 반사다. 뒤집어 겹친다는 것이 곧 거울의 정의다.
 */
function removeReflections(masks: Map<string, { mask: Uint8Array }>, W: number, H: number): number {
  const N = W * H;
  const fg = new Uint8Array(N);
  for (const { mask } of masks.values()) for (let i = 0; i < N; i++) if (mask[i]) fg[i] = 1;
  const comps = labelComponents(fg, W, H, 8, Math.max(64, Math.round(N * 0.0005))).components
    .sort((a, b) => b.area - a.area);
  if (comps.length < 2) return 0;
  const A = comps[0];
  const inA = new Uint8Array(N);
  for (let k = 0; k < A.pixels.length; k++) inA[A.pixels[k]] = 1;
  let removed = 0;
  for (const B of comps.slice(1)) {
    if (B.y0 < A.y1 - (A.y1 - A.y0) * 0.15) continue;               // A 아래에 있어야 한다
    const ox = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
    if (ox < (B.x1 - B.x0) * 0.6) continue;                          // 가로로 겹쳐야 한다
    const axis = (A.y1 + B.y0) / 2;                                  // 거울면
    let inter = 0;
    for (let k = 0; k < B.pixels.length; k++) {
      const p = B.pixels[k];
      const x = p % W, y = (p / W) | 0;
      const my = Math.round(2 * axis - y);
      if (my >= 0 && my < H && inA[my * W + x]) inter++;
    }
    const iou = inter / (A.area + B.area - inter);
    if (iou < 0.25) continue;
    for (const { mask } of masks.values()) for (let k = 0; k < B.pixels.length; k++) mask[B.pixels[k]] = 0;
    removed++;
  }
  return removed;
}

interface WorkerClass { name: string; score: number; instances: number; area: number; png_b64: string }
interface WorkerResponse {
  engine: string; package: string; category: string; threshold: number;
  width: number; height: number; prompt_classes: string[]; classes: WorkerClass[]; ms?: number;
}

export function vringonSegAvailable(): boolean {
  return !!process.env.VRINGON_SEG_URL;
}

async function callWorker(png: Buffer, category: string, threshold?: number): Promise<WorkerResponse> {
  const url = process.env.VRINGON_SEG_URL!.replace(/\/$/, "") + "/segment";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Number(process.env.VRINGON_SEG_TIMEOUT_MS ?? 180_000));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": process.env.VRINGON_SEG_KEY ?? "" },
      body: JSON.stringify({ image_b64: png.toString("base64"), category, threshold }),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`seg worker HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as WorkerResponse;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 사진을 사내 패키지로 세그먼트해 파트 계획 + 마스크를 만든다. 패키지 없는 카테고리·워커 미설정이면 null.
 * 캐시 키 = (사진 sha × 카테고리 × 문턱) — 같은 사진은 워커를 다시 부르지 않는다.
 */
export async function segmentWithVringon(
  imagePath: string,
  categoryHint: string | undefined,
  cacheDir: string,
  say?: (m: string) => void,
  opts: { threshold?: number } = {},
): Promise<VringonSegResult | null> {
  const category = vringonSegCategory(categoryHint);
  if (!category || !vringonSegAvailable()) return null;
  const cfg = SEG_CONFIG[category];
  const png = await fs.readFile(imagePath);
  const meta = await sharp(png).metadata();
  const W = meta.width!, H = meta.height!;
  const sha = crypto.createHash("sha256").update(png).update(`|${category}|${opts.threshold ?? "default"}`).digest("hex").slice(0, 20);
  const cacheFile = path.join(cacheDir, `vseg_${sha}.json`);

  let resp: WorkerResponse | null = null;
  let cached = false;
  try { resp = JSON.parse(await fs.readFile(cacheFile, "utf8")); cached = true; } catch { /* 없음 */ }
  if (!resp) {
    say?.(`사내 세그(SAM 3.1 ${category}) — 워커 호출`);
    resp = await callWorker(png, category, opts.threshold);
    // 0개 인식은 캐시하지 않는다 — 일시 장애가 영구 캐시로 굳는 것을 막는다
    if (resp.classes.length) {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(resp));
    }
  }

  // 클래스 → 계약 파트명(별칭·무시), 같은 파트로 접히는 클래스는 합집합
  const byPart = new Map<string, { mask: Uint8Array; score: number; instances: number }>();
  for (const c of resp.classes) {
    if (cfg.ignored.includes(c.name)) continue;
    const part = cfg.aliases[c.name] ?? c.name;
    if (!cfg.zOrder.includes(part)) { say?.(`  · z_order 에 없는 클래스 무시: ${c.name}`); continue; }
    const raw = await sharp(Buffer.from(c.png_b64, "base64")).greyscale().raw().toBuffer({ resolveWithObject: true });
    const mask = new Uint8Array(W * H);
    const { width: mw, height: mh } = raw.info;
    for (let y = 0; y < H; y++) {
      const sy = mh === H ? y : Math.min(mh - 1, Math.floor((y / H) * mh));
      for (let x = 0; x < W; x++) {
        const sx = mw === W ? x : Math.min(mw - 1, Math.floor((x / W) * mw));
        if (raw.data[sy * mw + sx] > 127) mask[y * W + x] = 1;
      }
    }
    const prev = byPart.get(part);
    if (prev) {
      for (let i = 0; i < mask.length; i++) if (mask[i]) prev.mask[i] = 1;
      prev.score = Math.max(prev.score, c.score); prev.instances += c.instances;
    } else byPart.set(part, { mask, score: c.score, instances: c.instances });
  }

  const N = W * H;
  const reflectionsRemoved = removeReflections(byPart, W, H);
  if (reflectionsRemoved) say?.(`  · 거울 반사상 ${reflectionsRemoved}개 성분 제거`);
  // 전경 상자 — 정합 기준
  let fx0 = W, fy0 = H, fx1 = -1, fy1 = -1;
  for (const { mask } of byPart.values()) for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const x = i % W, y = (i / W) | 0;
    if (x < fx0) fx0 = x; if (x > fx1) fx1 = x; if (y < fy0) fy0 = y; if (y > fy1) fy1 = y;
  }
  const foregroundBox: SubjectBox = fx1 < 0 ? { x: 0, y: 0, w: W, h: H } : { x: fx0, y: fy0, w: fx1 - fx0 + 1, h: fy1 - fy0 + 1 };

  // **앞 파트가 뒤 파트를 덮는다** — 워커의 z_order 페인팅과 같은 규칙. 겹치는 픽셀은 앞
  // 파트만 갖고, 뒤 파트는 보이는 부분만 남긴다(우리 파이프라인의 마스크는 "가시 영역").
  const ordered = cfg.zOrder.filter((p) => byPart.has(p));
  const owner = new Int16Array(N).fill(-1);
  ordered.forEach((p, zi) => { const m = byPart.get(p)!.mask; for (let i = 0; i < N; i++) if (m[i]) owner[i] = zi; });
  const masks = new Map<string, Uint8Array>();
  const parts: ProductPart[] = [];
  const detail: VringonSegResult["detail"] = [];
  ordered.forEach((p, zi) => {
    const m = new Uint8Array(N);
    let n = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (let i = 0; i < N; i++) {
      if (owner[i] !== zi) continue;
      m[i] = 1; n++;
      const x = i % W, y = (i / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    // 앞 파트에 완전히 가려진 파트는 레이어로 남길 게 없다
    if (n < N * 0.0002) return;
    const id = p.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
    const d = byPart.get(p)!;
    masks.set(id, m);
    parts.push({
      id, label: p, description: `${p} of the ${category.split("/")[0]}`,
      bbox: [x0 / W, y0 / H, (x1 + 1) / W, (y1 + 1) / H],
      z: parts.length, occludedBy: [], kind: MARKING.has(p) ? "marking" : "component",
      confidence: +d.score.toFixed(3),
    });
    detail.push({ id, score: +d.score.toFixed(3), instances: d.instances, areaPct: +((n / N) * 100).toFixed(2) });
  });
  // 가림 관계: 앞 파트와 픽셀이 닿아 있던(원 마스크 기준) 뒤 파트에 occludedBy 를 적는다
  for (let a = 0; a < parts.length; a++) {
    const ma = byPart.get(parts[a].label)!.mask;
    for (let b = a + 1; b < parts.length; b++) {
      const mb = byPart.get(parts[b].label)!.mask;
      let hit = 0;
      for (let i = 0; i < N; i += 3) if (ma[i] && mb[i]) { hit++; if (hit > 20) break; }
      if (hit > 20) parts[a].occludedBy.push(parts[b].id);
    }
  }

  const plan: PartPlan = {
    category: category.split("/")[0].replace("-clothing", ""),
    objectNoun: category === "top/outwear-clothing" ? "garment" : category.replace("-clothing", ""),
    view: "product photo",
    parts,
    provenance: {
      model: `vringon-sam3.1:${resp.package}`,
      promptVersion: `vseg.v1 (${resp.prompt_classes.length} prompts · thr ${resp.threshold})`,
      inputSha256: crypto.createHash("sha256").update(png).digest("hex"),
      createdAt: new Date().toISOString(),
    },
  };
  say?.(`사내 세그 ${cached ? "캐시 재사용" : `${resp.ms ?? "?"}ms`} — ${parts.length}개 파트: ${
    detail.map((d) => `${d.id} ${d.areaPct}%${d.instances > 1 ? `×${d.instances}` : ""}`).join(" · ")}`);
  return { category, package: resp.package, engine: resp.engine, masks, plan, detail, cached, foregroundBox, reflectionsRemoved };
}
