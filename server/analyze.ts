/**
 * 벡터/레이어 정밀도 분석기.
 *   · 벡터 충실도  — SVG를 래스터화해 원본 플랫과 픽셀 비교 (IoU / 색오차)
 *   · 선 품질      — 열린패스 비율, 앵커 밀도, 리본(속 빈 이중선) 잔존 여부
 *   · 레이어 분리  — 쌍별 IoU, 포함관계 vs 중복 구분, 커버리지
 * 실행: npx tsx server/analyze.ts <jobId> [--proof]
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "./config.js";
import type { VectorIR } from "./types.js";

const jobId = process.argv[2];
if (!jobId) throw new Error("usage: tsx server/analyze.ts <jobId> [--proof]");
const proof = process.argv.includes("--proof");
const J = path.join(config.outputsDir, jobId);
const base = `flat_${jobId.slice(0, 8)}`;
const ir: VectorIR = JSON.parse(await fs.readFile(path.join(J, `${base}.ir.json`), "utf8"));
const svgText = await fs.readFile(path.join(J, `${base}.svg`), "utf8");

const S = 512;
const bin = async (buf: Buffer | string) => {
  const { data, info } = await sharp(buf)
    .flatten({ background: "#ffffff" })
    .resize(S, S, { fit: "contain", background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const m = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) m[i] = data[i * info.channels] < 245 ? 1 : 0;
  return m;
};
const iou = (a: Uint8Array, b: Uint8Array) => {
  let i = 0, u = 0;
  for (let k = 0; k < a.length; k++) { if (a[k] && b[k]) i++; if (a[k] || b[k]) u++; }
  return u ? i / u : 0;
};

console.log(`\n══ 분석: ${jobId.slice(0, 8)} (캔버스 ${ir.width}×${ir.height}) ══\n`);

// ── 1) 벡터 충실도: SVG 렌더 vs 정렬된 플랫 ────────────────
const flatPath = path.join(J, "layers", "_aligned_flat.png");
const svgRaster = await sharp(Buffer.from(svgText), { density: 200 })
  .flatten({ background: "#ffffff" })
  .resize(ir.width, ir.height, { fit: "fill" })
  .png()
  .toBuffer();

let fidelity = "N/A";
let colorErr = "N/A";
try {
  const a = await bin(flatPath), b = await bin(svgRaster);
  fidelity = (iou(a, b) * 100).toFixed(1) + "%";
  // 평균 색오차 (전경 영역)
  const fr = await sharp(flatPath).flatten({ background: "#fff" }).resize(S, S, { fit: "contain", background: "#fff" }).removeAlpha().raw().toBuffer();
  const vr = await sharp(svgRaster).flatten({ background: "#fff" }).resize(S, S, { fit: "contain", background: "#fff" }).removeAlpha().raw().toBuffer();
  let sum = 0, n = 0;
  for (let i = 0; i < S * S; i++) {
    if (!a[i]) continue;
    sum += Math.hypot(fr[i * 3] - vr[i * 3], fr[i * 3 + 1] - vr[i * 3 + 1], fr[i * 3 + 2] - vr[i * 3 + 2]);
    n++;
  }
  colorErr = n ? (sum / n).toFixed(1) + " (0~441)" : "N/A";
} catch (e) {
  console.log("  래스터 비교 실패:", (e as Error).message.slice(0, 80));
}
console.log("── 벡터 충실도 (원본 플랫 대비) ──");
console.log(`  실루엣 IoU   ${fidelity}`);
console.log(`  평균 색오차  ${colorErr}\n`);

// ── 2) 선 품질 ─────────────────────────────────────────────
console.log("── 선 품질 ──");
let lineFound = false;
for (const L of ir.layers) {
  for (const g of L.groups) {
    const strokePaths = g.paths.filter((p) => p.stroke && !p.fill);
    if (!strokePaths.length) continue;
    lineFound = true;
    let open = 0, closed = 0, anchors = 0, len = 0;
    for (const p of g.paths) {
      const a = (p.d.match(/[LC]/g) ?? []).length;
      anchors += a;
      /Z/.test(p.d) ? closed++ : open++;
      len += pathLength(p.d);
    }
    const density = len ? (anchors / len) * 100 : 0;
    const openPct = (100 * open) / g.paths.length;
    console.log(
      `  ${(L.name + "/" + g.name).padEnd(26)} paths ${String(g.paths.length).padStart(4)}` +
        ` · 열린 ${openPct.toFixed(0).padStart(3)}%` +
        ` · 앵커/100px ${density.toFixed(1).padStart(5)}` +
        ` · 굵기 ${g.paths[0].strokeWidth}` +
        (closed > g.paths.length * 0.3 ? "  ⚠ 닫힌 패스 다수(리본 잔존 의심)" : ""),
    );
  }
}
if (!lineFound) console.log("  ⚠ stroke 선 레이어 없음 — 중심선 추출이 동작하지 않았을 수 있음");

// 면 레이어의 앵커 밀도
console.log("\n── 면 레이어 앵커 밀도 ──");
for (const L of ir.layers) {
  for (const g of L.groups) {
    if (g.paths.some((p) => p.stroke && !p.fill)) continue;
    let anchors = 0, len = 0;
    for (const p of g.paths) {
      anchors += (p.d.match(/[LC]/g) ?? []).length;
      len += pathLength(p.d);
    }
    const d = len ? (anchors / len) * 100 : 0;
    console.log(
      `  ${(L.name + "/" + g.name).padEnd(26)} 앵커 ${String(anchors).padStart(4)}` +
        ` · 둘레 ${Math.round(len).toString().padStart(5)}px · 앵커/100px ${d.toFixed(1)}` +
        (d > 12 ? "  ⚠ 과밀" : ""),
    );
  }
}

// ── 3) 레이어 분리 ─────────────────────────────────────────
console.log("\n── 레이어 분리 ──");
const masks: { name: string; m: Uint8Array; area: number }[] = [];
for (const L of ir.layers) {
  for (const g of L.groups) {
    if (g.paths.some((p) => p.stroke && !p.fill)) continue;
    const one = `<svg xmlns="http://www.w3.org/2000/svg" width="${ir.width}" height="${ir.height}" viewBox="0 0 ${ir.width} ${ir.height}">` +
      `<rect width="100%" height="100%" fill="#fff"/>` +
      g.paths.map((p) => `<path d="${p.d}" fill="#000" fill-rule="evenodd"/>`).join("") +
      `</svg>`;
    const m = await bin(Buffer.from(one));
    let area = 0;
    for (let i = 0; i < m.length; i++) area += m[i];
    masks.push({ name: `${L.name}/${g.name}`, m, area });
  }
}
const dup: string[] = [];
const contain: string[] = [];
for (let i = 0; i < masks.length; i++) {
  for (let j = i + 1; j < masks.length; j++) {
    const v = iou(masks[i].m, masks[j].m);
    if (v < 0.2) continue;
    let inter = 0;
    for (let k = 0; k < masks[i].m.length; k++) if (masks[i].m[k] && masks[j].m[k]) inter++;
    const small = Math.min(masks[i].area, masks[j].area) || 1;
    const line = `${masks[i].name} ↔ ${masks[j].name} IoU ${v.toFixed(2)}`;
    // 오버레이(로고가 몸통 위에 얹힘)는 정상 구조다. 작은 쪽이 큰 쪽 안에
    // 대체로 들어가 있으면 정상으로 본다. 진짜 결함은 (a)동일 형상 중복,
    // (b)포함도 아니면서 절반씩 걸치는 경우다.
    if (v > 0.8) dup.push(line + "  ⚠ 동일 형상 중복");
    else if (inter / small > 0.6) contain.push(line + " (오버레이 — 정상 스택)");
    else dup.push(line + "  ⚠ 부분 겹침 (분리 오류 의심)");
  }
}
console.log(`  면 레이어 ${masks.length}개`);
console.log(dup.length ? dup.map((s) => "  " + s).join("\n") : "  중복/부분겹침 없음");
if (contain.length) console.log(`  포함관계 ${contain.length}쌍 (정상)`);

// ── 4) proof 이미지 ────────────────────────────────────────
if (proof) {
  const dir = path.join(J, "analysis");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "vector_raster.png"), svgRaster);
  // 레이어별 시트
  const tiles: sharp.OverlayOptions[] = [];
  const TW = 200, cols = 6;
  for (let i = 0; i < masks.length; i++) {
    const g = Buffer.alloc(S * S);
    for (let k = 0; k < S * S; k++) g[k] = masks[i].m[k] ? 40 : 245;
    tiles.push({
      input: await sharp(g, { raw: { width: S, height: S, channels: 1 } })
        .resize(TW - 6, TW - 6, { fit: "contain", background: "#ffffff" })
        .extend({ top: 3, bottom: 3, left: 3, right: 3, background: "#888888" })
        .png()
        .toBuffer(),
      left: (i % cols) * TW,
      top: Math.floor(i / cols) * TW,
    });
  }
  if (tiles.length) {
    await sharp({
      create: { width: cols * TW, height: Math.ceil(masks.length / cols) * TW, channels: 3, background: "#ffffff" },
    })
      .composite(tiles)
      .png()
      .toFile(path.join(dir, "layer_sheet.png"));
  }
  console.log(`\n  proof → ${dir}`);
}

function pathLength(d: string): number {
  const nums = d.match(/-?\d+\.?\d*/g)?.map(Number) ?? [];
  let len = 0, px = 0, py = 0, started = false;
  const re = /([MLC])([^MLCZ]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    const n = (m[2].match(/-?\d+\.?\d*/g) ?? []).map(Number);
    if (m[1] === "M") { px = n[0]; py = n[1]; started = true; }
    else if (m[1] === "L") { if (started) len += Math.hypot(n[0] - px, n[1] - py); px = n[0]; py = n[1]; }
    else if (m[1] === "C" && n.length >= 6) {
      if (started) len += Math.hypot(n[0] - px, n[1] - py) + Math.hypot(n[2] - n[0], n[3] - n[1]) + Math.hypot(n[4] - n[2], n[5] - n[3]);
      px = n[4]; py = n[5];
    }
  }
  void nums;
  return len;
}
