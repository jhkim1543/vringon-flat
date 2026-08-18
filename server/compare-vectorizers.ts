/**
 * 벡터화 엔진 비교 (일회성).
 * 같은 입력에 대해 자체 파이프라인 / Recraft API / vecglypher API 를 비교한다.
 * 실행: npx tsx server/compare-vectorizers.ts <jobId>
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "./config.js";

const jobId = process.argv[2];
if (!jobId) throw new Error("usage: tsx server/compare-vectorizers.ts <jobId>");
const J = path.join(config.outputsDir, jobId);
const OUT = path.join(J, "compare");
await fs.mkdir(OUT, { recursive: true });

async function falVectorize(model: string, imagePath: string): Promise<string | null> {
  const buf = await sharp(imagePath).png().toBuffer();
  const res = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: { Authorization: `Key ${config.falKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: `data:image/png;base64,${buf.toString("base64")}` }),
  });
  if (!res.ok) {
    console.log(`  ${model} 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const j: any = await res.json();
  const url = j.image?.url ?? j.svg?.url ?? j.images?.[0]?.url ?? j.url;
  if (!url) {
    console.log(`  ${model} 응답에 SVG 없음: ${JSON.stringify(j).slice(0, 200)}`);
    return null;
  }
  if (url.startsWith("data:")) return Buffer.from(url.split(",")[1], "base64").toString("utf8");
  return (await fetch(url)).text();
}

function stats(svg: string) {
  const tags = svg.match(/<path\b[^>]*>/g) ?? [];
  let anchors = 0, closed = 0, open = 0, strokes = 0;
  for (const t of tags) {
    const d = /\bd="([^"]+)"/.exec(t)?.[1] ?? "";
    anchors += (d.match(/[LlCcSsQqTtAaHhVv]/g) ?? []).length;
    if (/[Zz]/.test(d)) closed++; else open++;
    if (/stroke="(?!none)/.test(t)) strokes++;
  }
  return { paths: tags.length, anchors, closed, open, strokes, bytes: svg.length };
}

const LINEWORK = path.join(J, "layers", "layer__linework.png");
const FLAT = path.join(J, "layers", "_aligned_flat.png");

console.log("=== 1) Linework 레이어 (선 품질) ===");
const ownSvg = await fs.readFile(path.join(J, `flat_${jobId.slice(0, 8)}.svg`), "utf8");
const ci = ownSvg.indexOf('<g id="CONSTRUCTION">');
const ownLw = ownSvg.slice(ci, ownSvg.lastIndexOf("</svg>"));
console.log("  자체(중심선):", JSON.stringify(stats(ownLw)));

for (const model of ["fal-ai/recraft/vectorize", "fal-ai/vecglypher/image-to-svg"]) {
  const svg = await falVectorize(model, LINEWORK);
  if (!svg) continue;
  const name = model.split("/")[1];
  await fs.writeFile(path.join(OUT, `lw_${name}.svg`), svg);
  console.log(`  ${model}:`, JSON.stringify(stats(svg)));
}

console.log("\n=== 2) 플랫 전체 (레이어 없는 단순 벡터화 기준선) ===");
for (const model of ["fal-ai/recraft/vectorize"]) {
  const svg = await falVectorize(model, FLAT);
  if (!svg) continue;
  const name = model.split("/")[1];
  await fs.writeFile(path.join(OUT, `flat_${name}.svg`), svg);
  console.log(`  ${model}:`, JSON.stringify(stats(svg)));
  const groups = (svg.match(/<g\b/g) ?? []).length;
  console.log(`    그룹 수: ${groups} (레이어 구조 유무 판단용)`);
}
console.log(`\n산출물: ${OUT}`);
