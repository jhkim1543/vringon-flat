/** 여러 샘플의 (도면 | 벡터)를 한 장에 — 결과를 눈으로 훑기 위한 대조 시트. */
import fs from "node:fs/promises";
import sharp from "sharp";
import { renderStandalone } from "../export.js";
import type { VectorScene } from "../types.js";

const CELL = 460;
const GAP = 10;
const names = process.argv.slice(3);
const outFile = process.argv[2];

const rows: { buf: Buffer; h: number; label: string }[] = [];
for (const name of names) {
  const dir = `outputs/v4/v4_${name}`;
  let sc: VectorScene;
  try { sc = JSON.parse(await fs.readFile(`${dir}/scene.json`, "utf8")) as VectorScene; }
  catch { console.log(`  ! ${name} 없음`); continue; }
  const { width: W, height: H } = sc.canvas;
  const sd = `${dir}/schematics`;
  const files = await fs.readdir(sd);
  const f = files.find((x) => /^schematic.*\.(png|jpg)$/.test(x)) ?? files.find((x) => /\.(png|jpg)$/.test(x));
  if (!f) { console.log(`  ! ${name} 도면 없음`); continue; }

  const left = await sharp(`${sd}/${f}`).flatten({ background: "#ffffff" })
    .resize(CELL, CELL, { fit: "contain", background: "#ffffff" }).png().toBuffer();
  const baked = await sharp(Buffer.from(renderStandalone(sc.primitives, W, H, "paint")), { density: 200 })
    .resize(W, H, { fit: "fill" }).flatten({ background: "#ffffff" }).png().toBuffer();
  const right = await sharp(baked)
    .resize(CELL, CELL, { fit: "contain", background: "#ffffff" }).png().toBuffer();

  const pair = await sharp({
    create: { width: CELL * 2 + GAP, height: CELL, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).composite([{ input: left, left: 0, top: 0 }, { input: right, left: CELL + GAP, top: 0 }])
    .png().toBuffer();
  rows.push({ buf: pair, h: CELL, label: name });
}

if (!rows.length) { console.log("담을 것이 없다."); process.exit(1); }

const cols = 2;
const cw = CELL * 2 + GAP;
const nRows = Math.ceil(rows.length / cols);
const width = cw * cols + GAP * (cols + 1);
const height = (CELL + 26) * nRows + GAP;

const labels = rows.map((r, i) => {
  const cx = GAP + (i % cols) * (cw + GAP);
  const cy = GAP + Math.floor(i / cols) * (CELL + 26) + CELL;
  return {
    input: Buffer.from(
      `<svg width="${cw}" height="24"><text x="4" y="17" font-family="sans-serif" font-size="15" fill="#333">` +
      `${r.label}   ← 도면 · 벡터 →</text></svg>`),
    left: cx, top: cy,
  };
});

await sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
  .composite([
    ...rows.map((r, i) => ({
      input: r.buf,
      left: GAP + (i % cols) * (cw + GAP),
      top: GAP + Math.floor(i / cols) * (CELL + 26),
    })),
    ...labels,
  ])
  .png().toFile(outFile);
console.log(`${outFile}  (${rows.length}종)`);
