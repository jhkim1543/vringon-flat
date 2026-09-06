/**
 * 전달용 대조 이미지 — 샘플마다 **원본 사진 · 도면 · 최종 벡터 · 앵커** 네 장을 굽는다.
 *
 * 벡터는 SVG 가 아니라 **`.ai` 를 poppler 로 구운 것**이다. 받는 쪽이 보는 것은 배포되는
 * 파일이지 우리가 화면에 그린 그림이 아니다.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { readAiAnchors } from "../ai-anchor-render.js";

const run = promisify(execFile);
const OUT = process.argv[2];
const LONG = 1250;

async function findPhoto(name: string): Promise<string | null> {
  const stem = name.replace(/^[tsfx]_/, "").replace(/_line$/, "");
  for (const p of [`inputs/test30/${stem}.png`, `outputs/_samples/${stem}.png`]) {
    try { await fs.access(p); return p; } catch { /* 다음 */ }
  }
  return null;
}

for (const name of process.argv.slice(3)) {
  const dir = `outputs/v4/v4_${name}`;
  const ai = `${dir}/layered.ai`;
  try { await fs.access(ai); } catch { console.log(`  ! ${name}: .ai 없음`); continue; }
  const clean = name.replace(/^[tsfx]_/, "");
  const sub = path.join(OUT, clean + (name.endsWith("_line") ? "" : ""));
  await fs.mkdir(sub, { recursive: true });

  const photo = await findPhoto(name);
  if (photo) await sharp(photo).resize(LONG, LONG, { fit: "inside" }).png().toFile(path.join(sub, "1_원본사진.png"));

  const sd = `${dir}/schematics`;
  const files = await fs.readdir(sd);
  const sf = files.find((x) => /^schematic.*\.(png|jpg)$/.test(x)) ?? files.find((x) => /\.(png|jpg)$/.test(x));
  if (sf) {
    await sharp(path.join(sd, sf)).flatten({ background: "#ffffff" })
      .resize(LONG, LONG, { fit: "inside" }).png().toFile(path.join(sub, "2_도면.png"));
  }

  const pdf = await fs.readFile(ai, "latin1");
  const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf)!;
  const pw = Number(box[1]), ph = Number(box[2]);
  const W = Math.round(pw >= ph ? LONG : LONG * (pw / ph));
  const H = Math.round(pw >= ph ? LONG * (ph / pw) : LONG);
  const stem = path.join(sub, "3_벡터");
  await run("pdftoppm", ["-png", "-r", "150", "-singlefile", "-scale-to-x", String(W), "-scale-to-y", String(H), ai, stem]);

  const a = await readAiAnchors(ai);
  const sx = W / a.page[0], sy = H / a.page[1];
  const R = Math.max(1.8, Math.min(W, H) * 0.0026);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<g stroke="#b9c4d0" stroke-width="${(R * 0.45).toFixed(2)}" fill="none" opacity="0.8">` +
    a.handles.map(([x1, y1, x2, y2]) =>
      `<path d="M${(x1 * sx).toFixed(1)} ${(y1 * sy).toFixed(1)}L${(x2 * sx).toFixed(1)} ${(y2 * sy).toFixed(1)}"/>`).join("") +
    `</g><g>` +
    a.dots.map((d) => `<circle cx="${(d.x * sx).toFixed(1)}" cy="${(d.y * sy).toFixed(1)}" r="${R.toFixed(2)}" ` +
      `fill="${d.corner ? "#e0342c" : "#2f6fd0"}" stroke="#fff" stroke-width="${(R * 0.3).toFixed(2)}"/>`).join("") +
    `</g></svg>`;
  await sharp(`${stem}.png`).composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png().toFile(path.join(sub, "4_앵커.png"));

  const q = JSON.parse(await fs.readFile(`${dir}/qa_v4.json`, "utf8")).qa;
  const g = (["fidelity", "editability", "semantic"] as const).map((k) => (q[k]?.pass ? "O" : "X")).join("");
  console.log(`  ${clean.padEnd(16)} 앵커 ${String(a.dots.length).padStart(6)} · 게이트 ${g}`);
}
