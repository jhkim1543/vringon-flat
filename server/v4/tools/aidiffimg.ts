import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
const run = promisify(execFile);
const [A, B] = process.argv.slice(2);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aid-"));
const bake = async (p: string, tag: string) => {
  const pdf = await fs.readFile(p, "latin1");
  const m = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf)!;
  const pw = Number(m[1]), ph = Number(m[2]);
  const L = 900;
  const W = Math.round(pw >= ph ? L : L * (pw / ph));
  const H = Math.round(pw >= ph ? L * (ph / pw) : L);
  await run("pdftoppm", ["-png", "-singlefile", "-r", "150",
    "-scale-to-x", String(W), "-scale-to-y", String(H), p, path.join(tmp, tag)]);
  return sharp(path.join(tmp, `${tag}.png`)).greyscale().raw().toBuffer({ resolveWithObject: true });
};
const a = await bake(A, "a"), b = await bake(B, "b");
const { width: W, height: H } = a.info;
const rgb = Buffer.alloc(W * H * 3, 255);
for (let i = 0; i < W * H; i++) {
  const x = a.data[i] < 128, y = b.data[i] < 128;
  if (x && y) { rgb[i * 3] = 40; rgb[i * 3 + 1] = 40; rgb[i * 3 + 2] = 40; }
  else if (x) { rgb[i * 3] = 220; rgb[i * 3 + 1] = 40; rgb[i * 3 + 2] = 40; }
  else if (y) { rgb[i * 3] = 40; rgb[i * 3 + 1] = 120; rgb[i * 3 + 2] = 230; }
}
await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toFile("outputs/aidiff.png");
console.log("outputs/aidiff.png  빨강=이전만 · 파랑=이후만 · 검정=둘다");
