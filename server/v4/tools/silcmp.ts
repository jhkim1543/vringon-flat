import fs from "node:fs/promises";
import sharp from "sharp";
const n = process.argv[2];
const dir = `outputs/v4/v4_${n}`;
const svg = await fs.readFile(`${dir}/silhouette.svg`, "utf8");
const sc = JSON.parse(await fs.readFile(`${dir}/scene.json`, "utf8"));
const { width: W, height: H } = sc.canvas;
const baked = await sharp(Buffer.from(svg), { density: 200 })
  .resize(W, H, { fit: "fill" }).flatten({ background: "#ffffff" }).png().toBuffer();
const sil = await sharp(baked).resize(700).png().toBuffer();
const sd = `${dir}/schematics`;
const f = (await fs.readdir(sd)).find((x) => /\.(png|jpg)$/.test(x))!;
const sch = await sharp(`${sd}/${f}`).flatten({ background: "#ffffff" }).resize(700).png().toBuffer();
const h = Math.max((await sharp(sch).metadata()).height!, (await sharp(sil).metadata()).height!);
await sharp({ create: { width: 1412, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } } })
  .composite([{ input: sch, left: 0, top: 0 }, { input: sil, left: 712, top: 0 }])
  .png().toFile(`outputs/sil_${n}.png`);
console.log(`outputs/sil_${n}.png (도면 | 실루엣)`);
