/** 도면과 최종 벡터를 **같은 자리로 확대**해 나란히 — 선이 어떻게 달라졌는지 보려고. */
import fs from "node:fs/promises";
import sharp from "sharp";
import { renderStandalone, isInkPrimitive } from "../export.js";
import type { VectorScene } from "../types.js";

const [name, xs, ys, ws] = process.argv.slice(2);
const dir = `outputs/v4/v4_${name}`;
const sc = JSON.parse(await fs.readFile(`${dir}/scene.json`, "utf8")) as VectorScene;
const { width: W, height: H } = sc.canvas;
const sd = `${dir}/schematics`;
const files = await fs.readdir(sd);
const f = files.find((x) => /^schematic.*\.(png|jpg)$/.test(x)) ?? files.find((x) => /\.(png|jpg)$/.test(x))!;

// 창은 캔버스 비율(0~1)로 받는다 — 샘플마다 크기가 달라서
const fx = Number(xs), fy = Number(ys), fw = Number(ws);
const left = Math.round(W * fx), top = Math.round(H * fy);
let cw = Math.round(W * fw), ch = Math.round(cw * 0.72);
// 창이 캔버스를 넘어가면 sharp 가 통째로 죽는다 — 미리 잘라 맞춘다
cw = Math.min(cw, W - left); ch = Math.min(ch, H - top);
if (cw < 8 || ch < 8) { console.log("창이 캔버스 밖이다"); process.exit(1); }
const OUT = 900;

// **리사이즈와 잘라내기를 한 체인에 넣지 않는다.** sharp 는 순서를 자기 규칙대로
// 정해서, 잘라낼 창이 원본 크기 기준으로 해석돼 범위를 벗어난다.
const schFull = await sharp(`${sd}/${f}`).flatten({ background: "#ffffff" })
  .resize(W, H, { fit: "fill" }).png().toBuffer();
const sch = await sharp(schFull).extract({ left, top, width: cw, height: ch })
  .resize(OUT, null, { kernel: "nearest" }).png().toBuffer();

const svg = renderStandalone(sc.primitives.filter(isInkPrimitive), W, H, "ink");
const baked = await sharp(Buffer.from(svg), { density: 300 })
  .resize(W, H, { fit: "fill" }).flatten({ background: "#ffffff" }).png().toBuffer();
const vecCrop = await sharp(baked).extract({ left, top, width: cw, height: ch }).png().toBuffer();
const vec = await sharp(vecCrop).resize(OUT, null, { kernel: "nearest" }).png().toBuffer();

const h = (await sharp(sch).metadata()).height!;
await sharp({ create: { width: OUT * 2 + 14, height: h, channels: 3, background: { r: 245, g: 245, b: 245 } } })
  .composite([{ input: sch, left: 0, top: 0 }, { input: vec, left: OUT + 14, top: 0 }])
  .png().toFile(`outputs/zoom_${name}.png`);
console.log(`outputs/zoom_${name}.png  (도면 | 벡터 · 창 ${cw}x${ch}px @${left},${top})`);
