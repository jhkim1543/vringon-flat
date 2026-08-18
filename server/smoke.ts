/**
 * 스모크 테스트 (API 호출 없음 · 무과금):
 * 합성 레이어 PNG → potrace 벡터화 → optimizer → .ai/.jsx/.svg 생성 검증.
 * 실행: npm run smoke
 */
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { vectorizeLayers } from "./pipeline/vectorize.js";
import { buildAiPdf } from "./writers/aiPdfWriter.js";
import { buildJsx } from "./writers/jsxWriter.js";
import { buildSvg } from "./writers/svgWriter.js";
import { config } from "./config.js";
import type { LayerPng } from "./pipeline/layers.js";

const W = 800, H = 500;
const dir = path.join(config.outputsDir, "_smoke");

async function makeShape(name: string, svg: string): Promise<string> {
  const p = path.join(dir, `${name}.png`);
  await sharp(Buffer.from(svg)).png().toFile(p);
  return p;
}

async function main() {
  await fs.mkdir(dir, { recursive: true });

  // 신발 옆면을 흉내낸 합성 레이어 3장
  const vamp = await makeShape(
    "vamp",
    `<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>
     <path d="M100 300 Q250 180 450 220 L450 330 Q260 360 100 340 Z" fill="#c0392b"/></svg>`,
  );
  const sole = await makeShape(
    "sole",
    `<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>
     <path d="M80 350 L700 330 Q730 360 700 390 L90 400 Q60 375 80 350 Z" fill="#2c3e50"/></svg>`,
  );
  const line = await makeShape(
    "line",
    `<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>
     <path d="M120 310 Q300 200 440 235" stroke="#000" stroke-width="3" fill="none"/>
     <path d="M150 330 L650 315" stroke="#000" stroke-width="2" fill="none" stroke-dasharray="8 6"/></svg>`,
  );

  const layers: LayerPng[] = [
    { partId: "vamp", name: "Vamp", parent: "UPPER", kind: "fill", pngPath: vamp, dominantColor: "#c0392b", area: 1 },
    { partId: "sole", name: "Outsole", parent: "SOLE", kind: "fill", pngPath: sole, dominantColor: "#2c3e50", area: 1 },
    { partId: "__linework", name: "Linework", parent: "CONSTRUCTION", kind: "line", pngPath: line, dominantColor: "#111111", area: 1 },
  ];

  const { ir, engine } = await vectorizeLayers(layers, W, H, (m) => console.log("  ·", m));
  console.log(`vectorize engine: ${engine}`);
  const totalPaths = ir.layers.reduce((n, l) => n + l.groups.reduce((m, g) => m + g.paths.length, 0), 0);
  if (totalPaths === 0) throw new Error("FAIL: 벡터 path가 생성되지 않음");

  const ai = buildAiPdf(ir);
  const aiPath = path.join(dir, "smoke.ai");
  await fs.writeFile(aiPath, ai);
  await fs.writeFile(path.join(dir, "smoke.jsx"), buildJsx(ir, "smoke_native.ai"));
  await fs.writeFile(path.join(dir, "smoke.svg"), buildSvg(ir));

  // PDF 구조 검증: xref 오프셋이 실제 "N 0 obj" 위치와 일치하는지
  const raw = ai.toString("latin1");
  const xrefPos = Number(/startxref\n(\d+)/.exec(raw)![1]);
  if (raw.slice(xrefPos, xrefPos + 4) !== "xref") throw new Error("FAIL: startxref 불일치");
  const xrefBody = raw.slice(xrefPos);
  const entries = [...xrefBody.matchAll(/^(\d{10}) 00000 n /gm)].map((m) => Number(m[1]));
  entries.forEach((off, i) => {
    const expect = `${i + 1} 0 obj`;
    if (raw.slice(off, off + expect.length) !== expect)
      throw new Error(`FAIL: xref[${i + 1}] 오프셋 불일치 (${off})`);
  });
  if (!raw.includes("/OCProperties")) throw new Error("FAIL: OCG 레이어 없음");

  console.log(`\nOK — layers=${ir.layers.length} paths=${totalPaths}`);
  console.log(`  ${aiPath}`);
  console.log(`  xref entries=${entries.length} 모두 정합`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
