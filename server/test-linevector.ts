/**
 * 라인 기준 벡터화 단독 검증.
 *
 * schematic 백엔드가 아직 없으므로, 성격이 같은 기존 플랫 이미지
 * (흰 배경 + 검은 라인 + 평면 색면)로 알고리즘을 검증한다.
 *
 * 실행: npx tsx server/test-linevector.ts <png...> [--ink 190] [--out dir]
 */
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { vectorizeByLines, type LineVectorResult } from "./v3/lineVector.js";

const args = process.argv.slice(2);
// 플래그 값(--out DIR, --ink N)은 입력 파일이 아니다
const FLAG_WITH_VALUE = new Set(["--out", "--ink"]);
const files = args.filter((a, i) => !a.startsWith("--") && !FLAG_WITH_VALUE.has(args[i - 1] ?? ""));
const flag = (n: string, d: number) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? args[outIdx + 1] : "outputs/_linevector";

if (!files.length) throw new Error("usage: tsx server/test-linevector.ts <png...> [--ink 190]");

await fs.mkdir(outDir, { recursive: true });

function toSvg(r: LineVectorResult): string {
  const body = [
    ...r.regions.map(
      (p) => `    <path d="${p.d}" fill="${p.fill ?? "none"}" fill-rule="evenodd"/>`,
    ),
    ...r.strokes.map(
      (p) =>
        `    <path d="${p.d}" fill="none" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`,
    ),
  ].join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r.width} ${r.height}" width="${r.width}" height="${r.height}">\n` +
    `  <g id="regions-and-lines">\n${body}\n  </g>\n</svg>\n`
  );
}

console.log("샘플".padEnd(14), "잉크%", "면", "버림", "선", "노드", "커버리지", "시간");
console.log("-".repeat(72));

for (const f of files) {
  const t0 = Date.now();
  try {
  const r = await vectorizeByLines(f, { inkThreshold: flag("ink", 190), workDir: path.join(outDir, ".work") });
  // 잡 폴더명 + 파일명으로 구분 (여러 샘플의 candidates/ 를 함께 돌리면 이름이 겹친다)
  const parts = f.split(/[\/]/);
  const jobIdx = parts.findIndex((x) => /^[0-9a-f]{8}-/.test(x));
  const job = jobIdx >= 0 ? parts[jobIdx].slice(0, 8) : "x";
  const name = job + "_" + path.basename(f, ".png");

  const svg = toSvg(r);
  const svgPath = path.join(outDir, `${name}.line.svg`);
  await fs.writeFile(svgPath, svg, "utf8");

  // 원본 | 잉크 | 벡터 3단 비교
  const target = 460;
  const orig = await sharp(f).flatten({ background: "#fff" }).resize(target, target, { fit: "inside" }).png().toBuffer();
  const inkPng = Buffer.alloc(r.width * r.height, 255);
  for (let i = 0; i < r.ink.length; i++) if (r.ink[i]) inkPng[i] = 0;
  const inkImg = await sharp(inkPng, { raw: { width: r.width, height: r.height, channels: 1 } })
    .resize(target, target, { fit: "inside" }).png().toBuffer();
  const vec = await sharp(Buffer.from(svg), { density: 96 })
    .resize(target, target, { fit: "inside" }).flatten({ background: "#fff" }).png().toBuffer();
  const m = await sharp(orig).metadata();
  await sharp({
    create: { width: 3 * (m.width! + 6), height: m.height!, channels: 3, background: "#888" },
  })
    .composite([
      { input: orig, left: 0, top: 0 },
      { input: inkImg, left: m.width! + 6, top: 0 },
      { input: vec, left: 2 * (m.width! + 6), top: 0 },
    ])
    .png()
    .toFile(path.join(outDir, `${name}.compare.png`));

  console.log(
    name.padEnd(14),
    String((r.stats.inkRatio * 100).toFixed(1)).padStart(5),
    String(r.stats.regionCount).padStart(4),
    String(r.stats.regionDropped).padStart(4),
    String(r.stats.strokeCount).padStart(5),
    String(r.stats.nodes).padStart(6),
    String((r.stats.coverage * 100).toFixed(1) + "%").padStart(8),
    String(((Date.now() - t0) / 1000).toFixed(1) + "s").padStart(7),
  );
  } catch (e) {
    console.log(path.basename(f).padEnd(14), "실패:", (e as Error).message.slice(0, 60));
  }
}
console.log(`\n→ ${outDir}`);
