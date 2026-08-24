/**
 * 끊김 지도 — 도면(기준) 위에 .ai 가 덮지 못한 구간을 빨갛게 칠한다.
 * 숫자만 보고 "끊겼다"고 말하지 않기 위해, 어디가 끊겼는지 눈으로 확인할 수 있게 낸다.
 *
 *   npx tsx server/v4/break-map.ts jewelry_3 <출력경로.png>
 */
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { skeletonize } from "../vector/centerline.js";
import { inkMask } from "../v3/metrics.js";
import { labelComponents } from "../v3/label.js";
const run = promisify(execFile);

const name = process.argv[2] ?? "jewelry_3";
const out = process.argv[3] ?? `outputs/v4/_verify/${name}_breaks.png`;
const dir = `docs/samples-v4/${name}`;
const pdf = await fs.readFile(`${dir}/layered.ai`, "latin1");
const box = new RegExp("/MediaBox \\[0 0 ([\\d.]+) ([\\d.]+)\\]").exec(pdf)!;
const pw = Number(box[1]), ph = Number(box[2]);
const LONG = 1400;
const W = Math.round(pw >= ph ? LONG : LONG * (pw / ph));
const H = Math.round(pw >= ph ? LONG * (ph / pw) : LONG);

const stem = `outputs/v4/_verify/__bm`;
await run("pdftoppm", ["-png", "-gray", "-singlefile", "-scale-to-x", String(W), "-scale-to-y", String(H), `${dir}/layered.ai`, stem]);
const aiMask = await inkMask(await fs.readFile(`${stem}.png`), W, H);
const refMask = await inkMask(await fs.readFile(`${dir}/schematic.jpg`), W, H);
const refSk = skeletonize(refMask.data, W, H);

function dilate(m: Uint8Array, r: number): Uint8Array {
  let cur = m;
  for (let i = 0; i < r; i++) {
    const nx = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i0 = y * W + x;
      if (cur[i0] || (x > 0 && cur[i0 - 1]) || (x < W - 1 && cur[i0 + 1]) ||
        (y > 0 && cur[i0 - W]) || (y < H - 1 && cur[i0 + W])) nx[i0] = 1;
    }
    cur = nx;
  }
  return cur;
}

const covered = dilate(aiMask.data, 3);
const missing = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) if (refSk[i] && !covered[i]) missing[i] = 1;
const { components } = labelComponents(missing, W, H, 8, 1);

// 회색 = .ai 잉크, 빨강 = 기준 선 중 .ai 가 못 덮은 구간(3px 굵혀 보이게)
const rgb = new Uint8Array(W * H * 3).fill(255);
for (let i = 0; i < W * H; i++) {
  if (aiMask.data[i]) { rgb[i * 3] = 190; rgb[i * 3 + 1] = 190; rgb[i * 3 + 2] = 190; }
}
let big = 0;
for (const c of components) {
  const strong = c.area >= 8;
  if (strong) big++;
  for (const idx of c.pixels) {
    const x = idx % W, y = (idx / W) | 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = (ny * W + nx) * 3;
      rgb[j] = 220; rgb[j + 1] = strong ? 30 : 150; rgb[j + 2] = strong ? 30 : 150;
    }
  }
}
await sharp(Buffer.from(rgb), { raw: { width: W, height: H, channels: 3 } }).png().toFile(out);
console.log(`${name} → ${out}  미덮 조각 ${components.length}개 (8px 이상 ${big}개)`);
