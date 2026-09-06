/** 최종 산출물을 **사람이 보는 그대로**(paint 모드) 굽는다 — 도면과 나란히. */
import fs from "node:fs/promises";
import sharp from "sharp";
import { renderStandalone } from "../export.js";
import type { VectorScene } from "../types.js";

for (const name of process.argv.slice(2)) {
  const dir = `outputs/v4/v4_${name}`;
  const sc = JSON.parse(await fs.readFile(`${dir}/scene.json`, "utf8")) as VectorScene;
  const { width: W, height: H } = sc.canvas;
  const sd = `${dir}/schematics`;
  const f = (await fs.readdir(sd)).find((x) => /^schematic.*\.(png|jpg)$/.test(x))!;
  const w = 950;
  const left = await sharp(`${sd}/${f}`).flatten({ background: "#ffffff" }).resize(w).png().toBuffer();
  const svg = renderStandalone(sc.primitives, W, H, "paint");
  // **리사이즈는 한 체인에 하나만.** 두 번 이어 붙이면 마지막 것만 먹어 비율이 깨진다.
  const baked = await sharp(Buffer.from(svg), { density: 288 })
    .resize(W, H, { fit: "fill" }).flatten({ background: "#ffffff" }).png().toBuffer();
  const right = await sharp(baked).resize(w).png().toBuffer();
  const h = Math.max((await sharp(left).metadata()).height!, (await sharp(right).metadata()).height!);
  await sharp({ create: { width: w * 2 + 16, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: w + 16, top: 0 }])
    .png().toFile(`outputs/paint_${name}.png`);
  console.log(`outputs/paint_${name}.png  (도면 | 최종 벡터)`);
}
