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

const dirArg = process.argv.find((a) => a.startsWith("--dir="));
const svgPath = dirArg ? `${dirArg.slice(6)}/${name}/${which}.svg` : `outputs/v4/v4_${name}/${which}.svg`;
const svg = await fs.readFile(svgPath, "utf8");
const vb = new RegExp('viewBox="0 0 ([\\d.]+) ([\\d.]+)"').exec(svg)!;
const W = Number(vb[1]), H = Number(vb[2]);

interface Dot { x: number; y: number; corner: boolean }
const dots: Dot[] = [];
const handles: [number, number, number, number][] = [];

/**
 * **패턴은 펼쳐서 센다.** 반복 패턴은 SVG 안에 모티프 하나 + `<use>` 참조로 저장되지만
 * Illustrator 는 인스턴스마다 실제 패스로 펼친다. `d=` 만 훑으면 모티프를 한 번만 세고
 * 원점에 그려 버려서, 화면에 실제로 보이는 것과 전혀 다른 그림이 나온다.
 */
const dEnd = svg.indexOf("</defs>");
const defs = dEnd > 0 ? svg.slice(svg.indexOf("<defs"), dEnd + 7) : "";
const body = dEnd > 0 ? svg.slice(dEnd) : svg;

const motifD = new Map<string, string>();
for (const m of defs.matchAll(new RegExp('<symbol id="motif-([^"]+)"[^>]*>\\s*<path d="([^"]*)"', "g"))) {
  motifD.set(m[1], m[2]);
}

function collect(d: string, tx = 0, ty = 0, sc = 1, rot = 0): void {
  const rad = (rot * Math.PI) / 180, cs = Math.cos(rad), sn = Math.sin(rad);
  const at = (p: [number, number]): [number, number] => {
    const x = p[0] * sc, y = p[1] * sc;
    return [tx + x * cs - y * sn, ty + x * sn + y * cs];
  };
  for (const sp of parsePath(d)) {
    const s = at(sp.start);
    dots.push({ x: s[0], y: s[1], corner: true });
    for (const seg of sp.segs) {
      const e = at(seg.end);
      dots.push({ x: e[0], y: e[1], corner: seg.type === "L" });
      if (seg.type === "C") {
        const c1 = at(seg.c1!), c2 = at(seg.c2!);
        handles.push([c1[0], c1[1], c2[0], c2[1]]);
      }
    }
  }
}

for (const m of body.matchAll(new RegExp('(?:^|[\\s"])d="([^"]*)"', "g"))) collect(m[1]);

const USE = new RegExp('<use[^>]*xlink:href="#motif-([^"]+)"[^>]*>', "g");
const TR = new RegExp("translate\\(([-\\d.]+)[ ,]+([-\\d.]+)\\)");
const RO = new RegExp("rotate\\(([-\\d.]+)\\)");
const SC = new RegExp("scale\\(([-\\d.]+)\\)");
for (const u of body.matchAll(USE)) {
  const d = motifD.get(u[1]);
  if (!d) continue;
  const t = TR.exec(u[0]);
  collect(d, t ? +t[1] : 0, t ? +t[2] : 0, SC.exec(u[0]) ? +SC.exec(u[0])![1] : 1, RO.exec(u[0]) ? +RO.exec(u[0])![1] : 0);
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
