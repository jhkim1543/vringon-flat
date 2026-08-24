/**
 * 파트 마스크 지도 — 도면 위에 파트별 색을 칠해 눈으로 확인한다.
 *
 *   npx tsx server/v4/mask-map.ts bag_1 out.png
 *
 * 마스크는 저장돼 있지 않으므로 run4 와 같은 경로로 재구성한다(도면 seg 는 캐시 재사용,
 * 과금 없음).
 */
import fs from "node:fs/promises";
import sharp from "sharp";
import { segmentSchematic, snapMasksToFaces, type SegHint } from "./segSchematic.js";
import { inkMask } from "../v3/metrics.js";

const name = process.argv[2] ?? "bag_1";
const out = process.argv[3] ?? `outputs/v4/_verify/maskmap_${name}.png`;
const plan = JSON.parse(await fs.readFile(`outputs/v4/v4_${name}/part_plan.json`, "utf8"));
const qa = JSON.parse(await fs.readFile(`outputs/v4/v4_${name}/qa_v4.json`, "utf8"));
const sch = qa.options.schematicFrom as string;

const meta = await sharp(sch).metadata();
const W = meta.width!, H = meta.height!;

const hints: SegHint[] = []; // 캐시가 있으므로 힌트는 안 쓰인다
const seg = await segmentSchematic(sch, plan, hints, `outputs/v4/v4_${name}/masks`);
const ink = await inkMask(await fs.readFile(sch), W, H, qa.options.inkThreshold ?? 170);
const zOf = new Map((plan.parts as { id: string; z: number }[]).map((p) => [p.id, p.z]));
const masks = seg.parts
  .sort((a, b) => (zOf.get(a.id) ?? 99) - (zOf.get(b.id) ?? 99))
  .map((p) => ({ id: p.id, mask: p.mask }));
const snapped = snapMasksToFaces(masks, ink.data, W, H);

const PAL: [number, number, number][] = [
  [230, 80, 80], [80, 140, 230], [90, 190, 110], [240, 170, 60],
  [170, 100, 220], [70, 200, 200], [230, 120, 180], [150, 150, 90],
  [100, 110, 230], [200, 90, 60],
];
const rgb = new Uint8Array(W * H * 3).fill(255);
snapped.forEach((m, i) => {
  const [r, g, b] = PAL[i % PAL.length];
  for (let k = 0; k < W * H; k++) {
    if (!m.mask[k]) continue;
    const j = k * 3;
    rgb[j] = (rgb[j] + r * 2) / 3; rgb[j + 1] = (rgb[j + 1] + g * 2) / 3; rgb[j + 2] = (rgb[j + 2] + b * 2) / 3;
  }
});
for (let k = 0; k < W * H; k++) {
  if (!ink.data[k]) continue;
  const j = k * 3;
  rgb[j] = rgb[j] * 0.25; rgb[j + 1] = rgb[j + 1] * 0.25; rgb[j + 2] = rgb[j + 2] * 0.25;
}

const LEG = 30 * snapped.length + 16;
const legend = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${LEG}">` +
  `<rect width="${W}" height="${LEG}" fill="#ffffff"/>` +
  snapped.map((m, i) => {
    const [r, g, b] = PAL[i % PAL.length];
    return `<rect x="12" y="${10 + i * 30}" width="20" height="20" fill="rgb(${r},${g},${b})"/>` +
      `<text x="42" y="${26 + i * 30}" font-family="Segoe UI, sans-serif" font-size="18" fill="#111">${m.id}</text>`;
  }).join("") + `</svg>`;

const body = await sharp(Buffer.from(rgb), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
await sharp({ create: { width: W, height: H + LEG, channels: 3, background: "#ffffff" } })
  .composite([{ input: body, top: 0, left: 0 }, { input: Buffer.from(legend), top: H, left: 0 }])
  .png().toFile(out);
console.log(`${name} → ${out}  파트 ${snapped.length}개`);
