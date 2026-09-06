/**
 * `.ai` **파일 자체**의 레이어 구성을 그림으로 보여 준다.
 *
 * "레이어가 잘 나뉘었나"는 scene.json 이 아니라 **배포되는 파일**에서 답해야 한다. 우리가
 * 의도한 것과 파일에 실제로 들어간 것이 다를 수 있기 때문이다(실제로 그런 적이 있다 —
 * 불투명한 면 채움이 공유 경계로 올라가 밑의 잉크를 지웠다).
 *
 * 그래서 여기서는 `.ai` 의 내용 스트림을 직접 해석한다. `/OC /ocN BDC … EMC` 중첩을 따라
 * 도형마다 **기능 레이어**(바깥)와 **파트 하위레이어**(안쪽)를 붙이고, 두 장을 만든다.
 *
 *   1) 대조표  — 기능 레이어마다 그 레이어만 그린 판을 나란히
 *   2) 파트별  — 파트 하위레이어마다 다른 색 (한 장)
 *
 *   npx tsx server/v4/ai-layer-render.ts <샘플> [--out 디렉터리]
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export interface AiShape {
  d: string;
  layer: string;
  sub: string;
  fill: string | null;
  stroke: string | null;
  width: number;
}

const hex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");

/** `.ai` 내용 스트림을 해석해 도형 목록으로. 좌표는 SVG 기준(y 아래로)으로 뒤집는다. */
export async function readAiShapes(aiPath: string): Promise<{ shapes: AiShape[]; page: [number, number] }> {
  const pdf = await fs.readFile(aiPath, "latin1");
  const box = new RegExp("/MediaBox \\[0 0 ([\\d.]+) ([\\d.]+)\\]").exec(pdf)!;
  const pw = Number(box[1]), ph = Number(box[2]);

  const objName = new Map<string, string>();
  for (const m of pdf.matchAll(new RegExp("(\\d+) 0 obj\\s*<<[^>]*?/Type\\s*/OCG[^>]*?/Name\\s*\\(([^)]*)\\)", "g"))) {
    objName.set(m[1], m[2]);
  }
  const ocName = new Map<string, string>();
  const props = new RegExp("/Properties\\s*<<([^>]*)>>").exec(pdf);
  if (props) {
    for (const m of props[1].matchAll(new RegExp("/(oc\\d+)\\s+(\\d+) 0 R", "g"))) {
      ocName.set(m[1], objName.get(m[2]) ?? m[1]);
    }
  }

  const sIdx = pdf.indexOf("stream\n", pdf.indexOf("/Length"));
  const body = pdf.slice(sIdx + 7, pdf.indexOf("endstream", sIdx));

  const shapes: AiShape[] = [];
  const st: number[] = [];
  const oc: string[] = [];
  let d = "";
  let fill: string | null = null, stroke: string | null = null, width = 1;
  const gsStack: { fill: string | null; stroke: string | null; width: number }[] = [];
  const Y = (y: number) => ph - y;

  const TOKEN = new RegExp("(-?\\d*\\.?\\d+)|(/[A-Za-z0-9]+)|([A-Za-z]+\\*?)", "g");
  let t: RegExpExecArray | null;
  let pendingOc: string | null = null;
  const f2 = (v: number) => Math.round(v * 100) / 100;

  const emit = (doFill: boolean, doStroke: boolean) => {
    if (d && (doFill || doStroke)) {
      shapes.push({
        d,
        layer: oc.length ? oc[oc.length - 1] : "(없음)",
        sub: oc.length > 1 ? oc[0] : "(파트 없음)",
        fill: doFill ? fill : null,
        stroke: doStroke ? stroke : null,
        width,
      });
    }
    d = "";
  };

  while ((t = TOKEN.exec(body))) {
    if (t[1] !== undefined) { st.push(Number(t[1])); continue; }
    if (t[2] !== undefined) { if (t[2].startsWith("/oc")) pendingOc = t[2].slice(1); continue; }
    const op = t[3];
    const n = st.length;
    switch (op) {
      case "BDC": oc.unshift(ocName.get(pendingOc ?? "") ?? "(없음)"); pendingOc = null; break;
      case "EMC": oc.shift(); break;
      case "q": gsStack.push({ fill, stroke, width }); break;
      case "Q": { const g = gsStack.pop(); if (g) ({ fill, stroke, width } = g); break; }
      case "rg": if (n >= 3) fill = hex(st[n - 3], st[n - 2], st[n - 1]); break;
      case "RG": if (n >= 3) stroke = hex(st[n - 3], st[n - 2], st[n - 1]); break;
      case "g": if (n >= 1) fill = hex(st[n - 1], st[n - 1], st[n - 1]); break;
      case "G": if (n >= 1) stroke = hex(st[n - 1], st[n - 1], st[n - 1]); break;
      case "w": if (n >= 1) width = st[n - 1]; break;
      case "m": if (n >= 2) d += `M${f2(st[n - 2])} ${f2(Y(st[n - 1]))}`; break;
      case "l": if (n >= 2) d += `L${f2(st[n - 2])} ${f2(Y(st[n - 1]))}`; break;
      case "c": if (n >= 6) d += `C${f2(st[n - 6])} ${f2(Y(st[n - 5]))} ${f2(st[n - 4])} ${f2(Y(st[n - 3]))} ${f2(st[n - 2])} ${f2(Y(st[n - 1]))}`; break;
      case "h": d += "Z"; break;
      case "re": if (n >= 4) {
        const [x, y, w, h] = [st[n - 4], st[n - 3], st[n - 2], st[n - 1]];
        d += `M${f2(x)} ${f2(Y(y))}L${f2(x + w)} ${f2(Y(y))}L${f2(x + w)} ${f2(Y(y + h))}L${f2(x)} ${f2(Y(y + h))}Z`;
        break;
      }
      case "f": case "F": case "f*": emit(true, false); break;
      case "S": case "s": emit(false, true); break;
      case "B": case "B*": case "b": case "b*": emit(true, true); break;
      case "n": d = ""; break;
      default: break;
    }
    st.length = 0;
  }
  return { shapes, page: [pw, ph] };
}

const PAL = [
  "#e0342c", "#2f6fd0", "#2f9e52", "#e08a1e", "#8e4fd0",
  "#17a5a5", "#d64f9c", "#7a7a2e", "#4a56c8", "#b8462a",
  "#5aa8e0", "#8ac832", "#c8329e", "#328ac8", "#c86432",
];

const svgOf = (shapes: AiShape[], W: number, H: number, colorOf: (s: AiShape) => string, bg = "#ffffff") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
  `<rect width="${W}" height="${H}" fill="${bg}"/>` +
  shapes.map((s) => {
    const c = colorOf(s);
    return s.fill
      ? `<path d="${s.d}" fill="${c}" fill-rule="evenodd" opacity="0.9"/>`
      : `<path d="${s.d}" fill="none" stroke="${c}" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join("") + `</svg>`;

// ── CLI ─────────────────────────────────────────────────────
if (process.argv[1]?.replace(new RegExp("\\\\", "g"), "/").endsWith("ai-layer-render.ts")) {
  const name = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "bag_1";
  const outArg = process.argv.find((a) => a.startsWith("--out="));
  const outDir = outArg ? outArg.slice(6) : "outputs/v4/_verify/layers";
  await fs.mkdir(outDir, { recursive: true });

  const { shapes, page } = await readAiShapes(`outputs/v4/v4_${name}/layered.ai`);
  const [pw, ph] = page;
  const PANEL = 470;
  const sc = PANEL / Math.max(pw, ph);
  const W = Math.round(pw * sc), H = Math.round(ph * sc);

  // 기능 레이어 순서는 파일에 나온 순서 그대로 — .ai 의 쌓임 순서가 곧 의미다
  const layers: string[] = [];
  for (const s of shapes) if (!layers.includes(s.layer)) layers.push(s.layer);
  const subs: string[] = [];
  for (const s of shapes) if (!subs.includes(s.sub)) subs.push(s.sub);

  const render = async (svg: string) =>
    sharp(Buffer.from(svg), { density: 96 }).resize({ width: W, height: H, fit: "fill" })
      .flatten({ background: "#ffffff" }).png().toBuffer();

  const FONT = "Segoe UI, Malgun Gothic, sans-serif";
  const label = (text: string, sub: string, w: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="52"><rect width="${w}" height="52" fill="#fff"/>` +
    `<text x="10" y="24" font-family="${FONT}" font-size="19" font-weight="700" fill="#111">${text}</text>` +
    `<text x="10" y="44" font-family="${FONT}" font-size="15" fill="#777">${sub}</text></svg>`;

  // 1) 대조표 — 레이어마다 한 판
  const cols = Math.min(4, layers.length + 1);
  const rows = Math.ceil((layers.length + 1) / cols);
  const CW = W + 16, CH = H + 52 + 16;
  const tiles: sharp.OverlayOptions[] = [];
  const idxOf = (v: string, arr: string[]) => arr.indexOf(v);

  const allPng = await render(svgOf(shapes, pw, ph, (s) => PAL[idxOf(s.layer, layers) % PAL.length]));
  tiles.push({ input: Buffer.from(label("전체 (레이어별 색)", `${shapes.length} 도형 · ${layers.length} 레이어`, CW)), top: 8, left: 8 });
  tiles.push({ input: allPng, top: 8 + 52, left: 8 + 8 });

  for (let i = 0; i < layers.length; i++) {
    const only = shapes.filter((s) => s.layer === layers[i]);
    const png = await render(svgOf(only, pw, ph, () => PAL[i % PAL.length]));
    const c = (i + 1) % cols, r = Math.floor((i + 1) / cols);
    const partsHere = new Set(only.map((s) => s.sub)).size;
    tiles.push({ input: Buffer.from(label(layers[i], `${only.length} 도형 · 하위 ${partsHere}`, CW)), top: r * CH + 8, left: c * CW + 8 });
    tiles.push({ input: png, top: r * CH + 8 + 52, left: c * CW + 16 });
  }
  const sheet = path.join(outDir, `layers_${name}.png`);
  await sharp({ create: { width: cols * CW, height: rows * CH, channels: 3, background: "#ffffff" } })
    .composite(tiles).png().toFile(sheet);

  // 2) 파트별 색 한 장
  const BIG = 1100;
  const bs = BIG / Math.max(pw, ph);
  const bw = Math.round(pw * bs), bh = Math.round(ph * bs);
  const partPng = await sharp(Buffer.from(svgOf(shapes, pw, ph, (s) => PAL[Math.max(0, idxOf(s.sub, subs)) % PAL.length])), { density: 96 })
    .resize({ width: bw, height: bh, fit: "fill" }).flatten({ background: "#ffffff" }).png().toBuffer();
  const legend =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${bw}" height="${28 + subs.length * 22}">` +
    `<rect width="${bw}" height="${28 + subs.length * 22}" fill="#fff"/>` +
    `<text x="12" y="20" font-family="${FONT}" font-size="19" font-weight="700" fill="#111">${name}.ai — 파트 하위레이어 ${subs.length}개</text>` +
    subs.map((s, i) =>
      `<circle cx="20" cy="${40 + i * 22}" r="7" fill="${PAL[i % PAL.length]}"/>` +
      `<text x="36" y="${46 + i * 22}" font-family="${FONT}" font-size="15" fill="#444">${s} — ${shapes.filter((x) => x.sub === s).length} 도형</text>`).join("") +
    `</svg>`;
  const legH = 28 + subs.length * 22;
  const partOut = path.join(outDir, `parts_${name}.png`);
  await sharp({ create: { width: bw, height: bh + legH, channels: 3, background: "#ffffff" } })
    .composite([{ input: Buffer.from(legend), top: 0, left: 0 }, { input: partPng, top: legH, left: 0 }])
    .png().toFile(partOut);

  console.log(`${name}: 도형 ${shapes.length} · 기능 레이어 ${layers.length}(${layers.join(", ")}) · 파트 하위 ${subs.length}`);
  console.log(`   → ${sheet}\n   → ${partOut}`);
}
