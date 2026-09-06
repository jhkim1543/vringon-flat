/** 두 .ai 를 poppler 로 굽고 픽셀로 견준다 — 표현을 바꿔도 그림이 같은지. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { readAiAnchors } from "../ai-anchor-render.js";
const run = promisify(execFile);
const [A, B] = process.argv.slice(2);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aid-"));
const bake = async (p: string, tag: string) => {
  const pdf = await fs.readFile(p, "latin1");
  const m = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf)!;
  const pw = Number(m[1]), ph = Number(m[2]);
  const L = 1100;
  const W = Math.round(pw >= ph ? L : L * (pw / ph));
  const H = Math.round(pw >= ph ? L * (ph / pw) : L);
  await run("pdftoppm", ["-png", "-singlefile", "-r", "150",
    "-scale-to-x", String(W), "-scale-to-y", String(H), p, path.join(tmp, tag)]);
  return sharp(path.join(tmp, `${tag}.png`)).greyscale().raw().toBuffer({ resolveWithObject: true });
};
const a = await bake(A, "a"), b = await bake(B, "b");
if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
  console.log(`크기가 다르다: ${a.info.width}x${a.info.height} vs ${b.info.width}x${b.info.height}`);
  process.exit(1);
}
let inter = 0, ao = 0, bo = 0;
for (let i = 0; i < a.data.length; i++) {
  const x = a.data[i] < 128, y = b.data[i] < 128;
  if (x && y) inter++; else if (x) ao++; else if (y) bo++;
}
const iou = inter / Math.max(1, inter + ao + bo);
const anA = (await readAiAnchors(A)).dots.length;
const anB = (await readAiAnchors(B)).dots.length;
console.log(`  IoU ${iou.toFixed(4)} · A에만 ${ao} · B에만 ${bo}`);
console.log(`  앵커 ${anA.toLocaleString()} → ${anB.toLocaleString()} (${anA ? ((1 - anB / anA) * 100).toFixed(1) : 0}% 감소)`);
console.log(`  크기 ${((await fs.stat(A)).size / 1024).toFixed(0)}KB → ${((await fs.stat(B)).size / 1024).toFixed(0)}KB`);
