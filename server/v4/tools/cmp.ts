/** 도면 · 벡터 · 겹침을 한 장으로 — 눈으로 확인하기 위한 대조판. */
import fs from "node:fs/promises";
import sharp from "sharp";
import { inkMask, svgInkMask } from "../../v3/metrics.js";
import { renderStandalone, isInkPrimitive } from "../export.js";
import type { VectorScene, GeometricPrimitive, PatternPrimitive } from "../types.js";


for (const name of process.argv.slice(2)) {
  const dir = `outputs/v4/v4_${name}`;
  const sc = JSON.parse(await fs.readFile(`${dir}/scene.json`, "utf8")) as VectorScene;
  const { width: W, height: H } = sc.canvas;
  const sd = `${dir}/schematics`;
  const f = (await fs.readdir(sd)).find((x) => /^schematic.*\.(png|jpg)$/.test(x))!;
  const ref = await inkMask(await fs.readFile(`${sd}/${f}`), W, H);
  const vec = await svgInkMask(renderStandalone(sc.primitives.filter(isInkPrimitive), W, H, "ink"), W, H);

  // 겹침: 도면만 빨강 · 벡터만 파랑 · 둘 다 검정
  const rgb = Buffer.alloc(W * H * 3, 255);
  for (let i = 0; i < W * H; i++) {
    const r = ref.data[i], v = vec.data[i];
    if (r && v) { rgb[i * 3] = 30; rgb[i * 3 + 1] = 30; rgb[i * 3 + 2] = 30; }
    else if (r) { rgb[i * 3] = 220; rgb[i * 3 + 1] = 40; rgb[i * 3 + 2] = 40; }
    else if (v) { rgb[i * 3] = 40; rgb[i * 3 + 1] = 90; rgb[i * 3 + 2] = 230; }
  }
  const w = 900;
  const one = async (buf: Buffer, ch: number) =>
    sharp(buf, { raw: { width: W, height: H, channels: ch as 1 | 3 } }).resize(w).png().toBuffer();
  const gray = (m: Uint8Array) => { const b = Buffer.alloc(W * H); for (let i = 0; i < W * H; i++) b[i] = m[i] ? 0 : 255; return b; };
  const tiles = [await one(gray(ref.data), 1), await one(gray(vec.data), 1), await one(rgb, 3)];
  const meta = await sharp(tiles[0]).metadata();
  const h = meta.height!;
  await sharp({ create: { width: w * 3 + 24, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite(tiles.map((t, i) => ({ input: t, left: i * (w + 12), top: 0 })))
    .png().toFile(`outputs/cmp_${name}.png`);
  console.log(`outputs/cmp_${name}.png  (도면 | 벡터 | 겹침: 빨강=도면만 파랑=벡터만)`);
}
