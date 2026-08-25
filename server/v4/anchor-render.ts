/**
 * 앵커 렌더 — **벡터의 점을 눈에 보이게** 그린다.
 *
 * 결과가 "촘촘한가"는 숫자보다 그림이 빠르다. 이 도구는 최종 SVG 의 모든 앵커를 점으로,
 * 곡선 제어 핸들은 옅은 선으로 얹어 Illustrator 로 열었을 때 보이는 것을 그대로 만든다.
 *
 *   npx tsx server/v4/anchor-render.ts <샘플> out.png [--zoom x,y,w,h]
 *
 * 색은 앵커의 성질을 나눈다.
 *   파랑  곡선 앵커 (C/S/Q/T 로 도착) — 부드러운 지점
 *   빨강  꺾임 앵커 (L/H/V/M 로 도착) — 모서리
 * 핸들이 있는 앵커에는 제어점까지 옅은 회색 선을 긋는다.
 */
import fs from "node:fs/promises";
import sharp from "sharp";
import { parsePath } from "../vector/pathdata.js";

const name = process.argv[2] ?? "bag_1";
const out = process.argv[3] ?? `outputs/v4/_verify/anchors_${name}.png`;
const zoomArg = process.argv.find((a) => a.startsWith("--zoom="));
const which = (process.argv.find((a) => a.startsWith("--svg=")) ?? "--svg=fidelity").slice(6);

const svgPath = `outputs/v4/v4_${name}/${which}.svg`;
const svg = await fs.readFile(svgPath, "utf8");
const vb = new RegExp('viewBox="0 0 ([\\d.]+) ([\\d.]+)"').exec(svg)!;
const W = Number(vb[1]), H = Number(vb[2]);

interface Dot { x: number; y: number; corner: boolean }
const dots: Dot[] = [];
const handles: [number, number, number, number][] = [];

for (const m of svg.matchAll(new RegExp('(?:^|[\\s"])d="([^"]*)"', "g"))) {
  for (const sp of parsePath(m[1])) {
    dots.push({ x: sp.start[0], y: sp.start[1], corner: true });
    for (const seg of sp.segs) {
      dots.push({ x: seg.end[0], y: seg.end[1], corner: seg.type === "L" });
      if (seg.type === "C") {
        handles.push([seg.c1![0], seg.c1![1], seg.c2![0], seg.c2![1]]);
      }
    }
  }
}

// 원본 도면을 옅게 깔고 그 위에 벡터 선 + 앵커
const base = svg
  .replace(new RegExp('stroke-width="([\\d.]+)"', "g"), (_s, w) => `stroke-width="${Math.max(1, Number(w) * 0.6)}"`)
  .replace("</svg>", "");

const R = Math.max(1.6, Math.min(W, H) * 0.0016);
const layer =
  `<g stroke="#b9c4d0" stroke-width="${R * 0.45}" fill="none" opacity="0.85">` +
  handles.map(([x1, y1, x2, y2]) => `<path d="M${x1} ${y1}L${x2} ${y2}"/>`).join("") +
  `</g>` +
  `<g>` +
  dots.map((d) =>
    `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${R}" ` +
    `fill="${d.corner ? "#e0342c" : "#2f6fd0"}" stroke="#ffffff" stroke-width="${R * 0.3}"/>`).join("") +
  `</g></svg>`;

let img = sharp(Buffer.from(base + layer), { density: 96 });
if (zoomArg) {
  const [zx, zy, zw, zh] = zoomArg.slice(7).split(",").map(Number);
  const big = await sharp(Buffer.from(base + layer), { density: 240 }).png().toBuffer();
  const meta = await sharp(big).metadata();
  const sx = meta.width! / W;
  img = sharp(big).extract({
    left: Math.round(zx * sx), top: Math.round(zy * sx),
    width: Math.round(zw * sx), height: Math.round(zh * sx),
  });
}

const LONG = 1400;
const png = await img.resize({ width: LONG, withoutEnlargement: false })
  .flatten({ background: "#ffffff" }).png().toBuffer();
const m2 = await sharp(png).metadata();

const corners = dots.filter((d) => d.corner).length;
const cap =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${m2.width}" height="86">` +
  `<rect width="${m2.width}" height="86" fill="#ffffff"/>` +
  `<text x="18" y="34" font-family="Segoe UI, Malgun Gothic, sans-serif" font-size="26" font-weight="700" fill="#111">` +
  `${name} — 앵커 ${dots.length.toLocaleString()}개</text>` +
  `<circle cx="28" cy="62" r="7" fill="#2f6fd0"/><text x="44" y="69" font-family="Segoe UI, Malgun Gothic, sans-serif" font-size="19" fill="#444">곡선 ${(dots.length - corners).toLocaleString()}</text>` +
  `<circle cx="180" cy="62" r="7" fill="#e0342c"/><text x="196" y="69" font-family="Segoe UI, Malgun Gothic, sans-serif" font-size="19" fill="#444">꺾임 ${corners.toLocaleString()}</text>` +
  `<text x="340" y="69" font-family="Segoe UI, Malgun Gothic, sans-serif" font-size="19" fill="#888">회색 선 = 베지에 제어 핸들</text>` +
  `</svg>`;

await sharp({ create: { width: m2.width!, height: m2.height! + 86, channels: 3, background: "#ffffff" } })
  .composite([{ input: Buffer.from(cap), top: 0, left: 0 }, { input: png, top: 86, left: 0 }])
  .png().toFile(out);

console.log(`${name} → ${out}  앵커 ${dots.length} (곡선 ${dots.length - corners} · 꺾임 ${corners})`);
