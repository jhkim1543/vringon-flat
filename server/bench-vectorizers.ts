/**
 * 벡터라이저 엔진 벤치마크 — 같은 입력에 모든 가용 엔진을 돌려 비교한다.
 * 실행: npx tsx server/bench-vectorizers.ts <jobId|이미지경로> [--layer linework|flat]
 *
 * 비교 지표는 "디자이너가 Illustrator에서 다룰 수 있는가"에 맞춘다:
 *   패스 수 · 앵커 수 · 열린 패스 비율(=선 굵기 조절 가능 여부) · 충실도 IoU
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "./config.js";
import { vtraceLayer } from "./vector/vtracerEngine.js";
import { centerlineTrace } from "./vector/centerline.js";
import { vectorizeSvg as adobeTrace } from "./clients/adobeTraceClient.js";
import type { IRPath } from "./types.js";

const arg = process.argv[2];
if (!arg) throw new Error("usage: tsx server/bench-vectorizers.ts <jobId|이미지경로> [--layer linework|flat]");
const wantLayer = process.argv.includes("--layer")
  ? process.argv[process.argv.indexOf("--layer") + 1]
  : "flat";

// 입력 결정: jobId면 해당 잡의 플랫/선 레이어, 아니면 이미지 경로 그대로
let src = arg;
if (!arg.includes("/") && !arg.includes("\\")) {
  const d = path.join(config.outputsDir, arg);
  src =
    wantLayer === "linework"
      ? path.join(d, "layers", "layer__linework.png")
      : path.join(d, "layers", "_aligned_flat.png");
}
console.log(`입력: ${src}\n`);

const OUT = path.join(config.outputsDir, "_bench");
await fs.mkdir(OUT, { recursive: true });

interface Result {
  engine: string;
  paths: number;
  anchors: number;
  openPct: number;
  iou: number | null;
  note?: string;
}
const results: Result[] = [];

const S = 512;
async function silhouette(buf: Buffer, isSvg: boolean): Promise<Uint8Array> {
  const img = isSvg ? sharp(buf, { density: 150 }) : sharp(buf);
  const { data, info } = await img
    .flatten({ background: "#ffffff" })
    .resize(S, S, { fit: "contain", background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const m = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) m[i] = data[i * info.channels] < 245 ? 1 : 0;
  return m;
}
const refMask = await silhouette(await fs.readFile(src), false);
function iouOf(m: Uint8Array): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i] && refMask[i]) inter++;
    if (m[i] || refMask[i]) uni++;
  }
  return uni ? inter / uni : 0;
}

function statsFromSvg(svg: string) {
  const tags = svg.match(/<path\b[^>]*>/g) ?? [];
  let anchors = 0, open = 0;
  for (const t of tags) {
    const d = /\bd="([^"]+)"/.exec(t)?.[1] ?? "";
    anchors += (d.match(/[LlCcSsQqTtAaHhVv]/g) ?? []).length;
    if (!/[Zz]\s*$/.test(d.trim())) open++;
  }
  return { paths: tags.length, anchors, openPct: tags.length ? (100 * open) / tags.length : 0 };
}
function svgFromPaths(paths: IRPath[], w: number, h: number): string {
  const body = paths
    .map((p) =>
      p.stroke
        ? `<path d="${p.d}" fill="none" stroke="${p.stroke}" stroke-width="${p.strokeWidth}"/>`
        : `<path d="${p.d}" fill="${p.fill ?? "#000"}"/>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#fff"/>${body}</svg>`;
}

const meta = await sharp(src).metadata();
const W = meta.width!, H = meta.height!;

// ── 1) 우리 엔진 ─────────────────────────────────────────────
if (wantLayer === "linework") {
  const p = await centerlineTrace(src, { color: "#111111" });
  const svg = svgFromPaths(p, W, H);
  await fs.writeFile(path.join(OUT, "ours.svg"), svg);
  results.push({ engine: "우리 (중심선 추출)", ...statsFromSvg(svg), iou: iouOf(await silhouette(Buffer.from(svg), true)) });
} else {
  const p = await vtraceLayer(src, { kind: "fill", color: "#808080" });
  const svg = svgFromPaths(p, W, H);
  await fs.writeFile(path.join(OUT, "ours.svg"), svg);
  results.push({ engine: "우리 (VTracer+최적화)", ...statsFromSvg(svg), iou: iouOf(await silhouette(Buffer.from(svg), true)) });
}

// ── 2) Recraft (fal.ai) ─────────────────────────────────────
if (config.hasSam3) {
  try {
    const buf = await sharp(src).flatten({ background: "#ffffff" }).png().toBuffer();
    const r = await fetch("https://fal.run/fal-ai/recraft/vectorize", {
      method: "POST",
      headers: { Authorization: `Key ${config.falKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: `data:image/png;base64,${buf.toString("base64")}` }),
    });
    if (!r.ok) throw new Error(`${r.status}`);
    const j: any = await r.json();
    const url = j.image?.url ?? j.images?.[0]?.url;
    const svg = url.startsWith("data:")
      ? Buffer.from(url.split(",")[1], "base64").toString("utf8")
      : await (await fetch(url)).text();
    await fs.writeFile(path.join(OUT, "recraft.svg"), svg);
    results.push({ engine: "Recraft API", ...statsFromSvg(svg), iou: iouOf(await silhouette(Buffer.from(svg), true)) });
  } catch (e) {
    results.push({ engine: "Recraft API", paths: 0, anchors: 0, openPct: 0, iou: null, note: (e as Error).message.slice(0, 60) });
  }
}

// ── 3) Adobe Illustrator Image Trace ────────────────────────
if (config.hasAdobe) {
  for (const preset of ["enhanced_general", "high_fidelity_photo"] as const) {
    try {
      const svg = await adobeTrace(src, preset);
      await fs.writeFile(path.join(OUT, `adobe_${preset}.svg`), svg);
      results.push({ engine: `Adobe Trace (${preset})`, ...statsFromSvg(svg), iou: iouOf(await silhouette(Buffer.from(svg), true)) });
    } catch (e) {
      results.push({ engine: `Adobe Trace (${preset})`, paths: 0, anchors: 0, openPct: 0, iou: null, note: (e as Error).message.slice(0, 80) });
    }
  }
} else {
  results.push({ engine: "Adobe Trace", paths: 0, anchors: 0, openPct: 0, iou: null, note: "ADOBE_CLIENT_ID/SECRET 없음 — 건너뜀" });
}

// ── 출력 ────────────────────────────────────────────────────
console.log("엔진".padEnd(26), "패스".padStart(6), "앵커".padStart(7), "열린%".padStart(7), "충실도IoU".padStart(10));
console.log("-".repeat(62));
for (const r of results) {
  if (r.iou === null) {
    console.log(r.engine.padEnd(26), "  —".padStart(6), "—".padStart(7), "—".padStart(7), `  ${r.note}`);
    continue;
  }
  console.log(
    r.engine.padEnd(26),
    String(r.paths).padStart(6),
    String(r.anchors).padStart(7),
    r.openPct.toFixed(0).padStart(6) + "%",
    (r.iou * 100).toFixed(1).padStart(9) + "%",
  );
}
console.log(`\n산출물: ${OUT}`);
console.log("열린% = 선 굵기를 Illustrator에서 조절할 수 있는 패스의 비율 (선 레이어에서 중요)");
