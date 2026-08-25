/**
 * 레이어 렌더 — **실제 산출물**의 파트별 기하를 색으로 그린다.
 *
 * 마스크 지도(mask-map.ts)는 "마스크가 어떻게 생겼나"를 보여 주지만, 정작 알고 싶은 것은
 * "최종 SVG 의 패스들이 파트별로 나뉘었나"다. 이 도구는 scene.json 의 프리미티브를
 * partId 별 색으로 그려서 그 질문에 직접 답한다. 회색은 주인 없는 기하다.
 *
 *   npx tsx server/v4/layer-render.ts <샘플> out.png
 */
import fs from "node:fs/promises";
import sharp from "sharp";
import { renderPrimitive } from "./export.js";
import type { VectorScene, ScenePrimitive, PatternPrimitive } from "./types.js";

const PAL = [
  "#e35050", "#508cd6", "#5abe6e", "#f0aa3c", "#aa64dc",
  "#46c8c8", "#e678b4", "#96965a", "#646edc", "#c85a3c",
];

const name = process.argv[2] ?? "bag_1";
const out = process.argv[3] ?? `outputs/v4/_verify/layers_${name}.png`;
const scene = JSON.parse(
  await fs.readFile(`outputs/v4/v4_${name}/scene.json`, "utf8"),
) as VectorScene;
const { width: W, height: H } = scene.canvas;

const colorOf = new Map<string, string>();
scene.parts.forEach((p, i) => colorOf.set(p.id, PAL[i % PAL.length]));

/** 프리미티브를 파트 색으로 다시 칠한다 */
function recolor(p: ScenePrimitive): ScenePrimitive {
  const c = (p.partId && colorOf.get(p.partId)) || "#b4b4b4";
  const q = { ...p } as Record<string, unknown>;
  if (p.cls === "STRUCTURAL_STROKE" || p.cls === "DASH_OR_STITCH") q.color = c;
  else if (p.cls === "GEOMETRIC_PRIMITIVE") {
    if ((p as { paint?: string }).paint === "fill") q.fill = c; else q.stroke = c;
  } else q.fill = c;
  return q as unknown as ScenePrimitive;
}

// 면은 옅게 깔고 선을 위에 — 안 그러면 큰 면이 다 덮는다
const Z: Record<string, number> = {
  FACE_FILL: 0, TEXTURE_TONE: 1, REPEATING_PATTERN: 2,
  OUTLINE_SHAPE: 3, GEOMETRIC_PRIMITIVE: 4, DASH_OR_STITCH: 5, STRUCTURAL_STROKE: 6,
};
const ordered = [...scene.primitives].sort((a, b) => (Z[a.cls] ?? 9) - (Z[b.cls] ?? 9));

const body = ordered.filter((p) => p.cls !== "REPEATING_PATTERN").map((p) => {
  const r = recolor(p);
  const isFace = p.cls === "FACE_FILL" || p.cls === "TEXTURE_TONE";
  const tag = renderPrimitive(r, { sharedAttr: false, indent: "" });
  return isFace ? tag.replace("<path ", '<path opacity="0.35" ') : tag;
}).join("");

// 패턴 인스턴스는 파트가 인스턴스마다 다르다 — 나눠서 다시 그린다
const patSplit = scene.primitives
  .filter((p) => p.cls === "REPEATING_PATTERN")
  .flatMap((p) => {
    const pat = p as PatternPrimitive;
    const byPart = new Map<string, typeof pat.instances>();
    for (const i of pat.instances) {
      const k = i.partId ?? pat.partId ?? "_none";
      (byPart.get(k) ?? byPart.set(k, []).get(k)!).push(i);
    }
    // `<use>` 는 심볼의 fill 을 물려받아 색을 지정할 수 없다 — 시각화에서는 모티프를
    // 인스턴스마다 펼쳐 파트 색으로 직접 칠한다(처음엔 전부 검게 나왔다).
    return [...byPart.entries()].map(([pid, inst]) => {
      const c = colorOf.get(pid) ?? "#b4b4b4";
      return inst.map((i) =>
        `<g transform="translate(${i.x} ${i.y})${i.rotate ? ` rotate(${i.rotate})` : ""}` +
        `${i.scale !== 1 ? ` scale(${i.scale})` : ""}">` +
        `<path d="${pat.motif}" fill="${c}" fill-rule="evenodd"/></g>`).join("");
    });
  }).join("");

const defsUnused = scene.primitives
  .filter((p) => p.cls === "REPEATING_PATTERN")
  .map((p) => {
    const t = p as PatternPrimitive;
    return `<symbol id="motif-${t.id}" viewBox="0 0 ${t.motifSize[0]} ${t.motifSize[1]}" overflow="visible">` +
      `<path d="${t.motif}" fill="currentColor" fill-rule="evenodd"/></symbol>`;
  }).join("");

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
  `viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
  `<rect width="${W}" height="${H}" fill="#ffffff"/>` +
  body + patSplit + `</svg>`;

void defsUnused;
const LONG = 1100;
const rw = W >= H ? LONG : Math.round(LONG * (W / H));
const img = await sharp(Buffer.from(svg), { density: 96 })
  .resize({ width: rw }).flatten({ background: "#ffffff" }).png().toBuffer();
const m = await sharp(img).metadata();

// 범례 — 파트별 실제 소유 패스 수
const own = new Map<string, number>();
for (const p of scene.primitives) {
  if (p.cls === "REPEATING_PATTERN") {
    const t = p as PatternPrimitive;
    for (const i of t.instances) {
      const k = i.partId ?? t.partId ?? "_none";
      own.set(k, (own.get(k) ?? 0) + 1);
    }
    continue;
  }
  const k = p.partId ?? "_none";
  own.set(k, (own.get(k) ?? 0) + 1);
}
const rows = scene.parts.map((p) => ({ id: p.id, c: colorOf.get(p.id)!, n: own.get(p.id) ?? 0 }));
if (own.get("_none")) rows.push({ id: "(주인 없음)", c: "#b4b4b4", n: own.get("_none")! });

const LEG = 26 * rows.length + 20;
const legend = `<svg xmlns="http://www.w3.org/2000/svg" width="${m.width}" height="${LEG}">` +
  `<rect width="${m.width}" height="${LEG}" fill="#ffffff"/>` +
  rows.map((r, i) =>
    `<rect x="12" y="${10 + i * 26}" width="18" height="18" fill="${r.c}"/>` +
    `<text x="38" y="${25 + i * 26}" font-family="Segoe UI,sans-serif" font-size="15" fill="#111">` +
    `${r.id} — ${r.n}</text>`).join("") + `</svg>`;

await sharp({ create: { width: m.width!, height: m.height! + LEG, channels: 3, background: "#ffffff" } })
  .composite([{ input: img, top: 0, left: 0 }, { input: Buffer.from(legend), top: m.height!, left: 0 }])
  .png().toFile(out);
console.log(`${name} → ${out}  파트 ${scene.parts.length} · 주인 없음 ${own.get("_none") ?? 0}`);
