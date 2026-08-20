/**
 * V1(플랫 스케치 경로) vs V2(개발계획서 구현) 비교.
 *
 * 두 파이프라인은 목표가 다르므로 "어느 쪽이 낫다"가 아니라 **무엇이 다른지**를
 * 같은 잣대로 잰다. 공통 지표는 원본 대비 실루엣 IoU / 경계 F-score /
 * masked ΔE2000 / 벡터 복잡도이고, 두 결과 모두 최종 SVG를 래스터화해서 잰다.
 *
 * 실행: npx tsx server/compare-v1-v2.ts [샘플명...]
 */
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { config } from "./config.js";
import { area, backgroundMask, boundary, edgeF1, iou, loadRaster, maskedDeltaE } from "./v2/raster.js";

const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));

interface Row {
  sample: string;
  variant: "V1" | "V2";
  layers: number;
  paths: number;
  nodes: number;
  kb: number;
  iou: number;
  boundaryF: number;
  deltaE: number;
  note: string;
}

/** 최종 SVG를 원본과 같은 캔버스로 렌더해 지표를 잰다 */
async function measure(svgPath: string, refPath: string): Promise<Omit<Row, "sample" | "variant" | "layers" | "note">> {
  const ref = await loadRaster(refPath);
  const W = ref.width, H = ref.height;
  const svgText = await fs.readFile(svgPath, "utf8");
  const rendered = await sharp(Buffer.from(svgText), { density: 150 })
    .resize(W, H, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = { data: rendered.data, channels: rendered.info.channels, width: W, height: H };

  const refBg = backgroundMask(ref, W, H);
  const refFg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) refFg[i] = refBg[i] ? 0 : 1;
  const outBg = backgroundMask(out, W, H);
  const outFg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) outFg[i] = outBg[i] ? 0 : 1;

  const eb = edgeF1(boundary(outFg, W, H), boundary(refFg, W, H), W, H, 2);
  const de = maskedDeltaE(out, ref, refFg);

  const paths = (svgText.match(/<path\b/g) ?? []).length;
  const nodes = (svgText.match(/[LCQ]/g) ?? []).length;
  return {
    paths,
    nodes,
    kb: +(Buffer.byteLength(svgText) / 1024).toFixed(1),
    iou: +iou(outFg, refFg).toFixed(4),
    boundaryF: +eb.f1.toFixed(4),
    deltaE: +de.toFixed(2),
  };
}

const jobs = new Map<string, string>();
for (const line of (await fs.readFile(path.join(config.outputsDir, "_samples", "JOBS.txt"), "utf8")).split(/\r?\n/)) {
  const [n, id] = line.trim().split(/\s+/);
  if (n && id) jobs.set(n, id);
}

const rows: Row[] = [];
const targets = names.length ? names : [...jobs.keys()];

for (const name of targets) {
  const v2Dir = path.join(config.outputsDir, "v2", `v2_${name}`);
  const v2Svg = path.join(v2Dir, "layered.svg");
  const ref = path.join(v2Dir, "canonical_input.png"); // 두 쪽 공통 기준 = 격리·크롭된 원본

  let hasV2 = true;
  try { await fs.access(v2Svg); await fs.access(ref); } catch { hasV2 = false; }
  if (!hasV2) continue;

  // V2
  const v2Manifest = JSON.parse(await fs.readFile(path.join(v2Dir, "layer_manifest.json"), "utf8"));
  const v2qa = JSON.parse(await fs.readFile(path.join(v2Dir, "qa_report.json"), "utf8"));
  rows.push({
    sample: name,
    variant: "V2",
    layers: v2Manifest.layers.length,
    ...(await measure(v2Svg, ref)),
    note: `${v2qa.job.state}${v2qa.retries.length ? ` · 재시도 ${v2qa.retries.length}` : ""}`,
  });

  // V1 — 같은 기준 이미지로 다시 잰다
  const id = jobs.get(name);
  if (id) {
    const v1Svg = path.join(config.outputsDir, id, `flat_${id.slice(0, 8)}.svg`);
    try {
      await fs.access(v1Svg);
      const ir = JSON.parse(await fs.readFile(path.join(config.outputsDir, id, `flat_${id.slice(0, 8)}.ir.json`), "utf8"));
      const groups = ir.layers.reduce((n: number, L: { groups: unknown[] }) => n + L.groups.length, 0);
      rows.push({
        sample: name,
        variant: "V1",
        layers: groups,
        ...(await measure(v1Svg, ref)),
        note: "flat 스케치 경로",
      });
    } catch { /* V1 결과 없음 */ }
  }
}

// ── 표 출력 ─────────────────────────────────────────────────
const pad = (s: string | number, n: number, right = false) => {
  const t = String(s);
  return right ? t.padStart(n) : t.padEnd(n);
};
console.log("\n" + "=".repeat(96));
console.log("V1(플랫 스케치) vs V2(개발계획서 구현) — 같은 기준 이미지, 같은 지표");
console.log("=".repeat(96));
console.log(
  pad("샘플", 12) + pad("경로", 5) + pad("레이어", 7, true) + pad("패스", 7, true) +
  pad("노드", 8, true) + pad("KB", 8, true) + pad("실루엣IoU", 11, true) +
  pad("경계F", 9, true) + pad("색차ΔE", 9, true) + "  " + "비고",
);
console.log("-".repeat(96));
for (const name of targets) {
  for (const v of ["V2", "V1"] as const) {
    const r = rows.find((x) => x.sample === name && x.variant === v);
    if (!r) continue;
    console.log(
      pad(r.variant === "V2" ? name : "", 12) + pad(r.variant, 5) + pad(r.layers, 7, true) +
      pad(r.paths, 7, true) + pad(r.nodes, 8, true) + pad(r.kb, 8, true) +
      pad(r.iou.toFixed(3), 11, true) + pad(r.boundaryF.toFixed(3), 9, true) +
      pad(r.deltaE.toFixed(1), 9, true) + "  " + r.note,
    );
  }
}
console.log("-".repeat(96));

const avg = (v: "V1" | "V2", k: keyof Row) => {
  const xs = rows.filter((r) => r.variant === v).map((r) => Number(r[k]));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
};
for (const v of ["V2", "V1"] as const) {
  const n = rows.filter((r) => r.variant === v).length;
  if (!n) continue;
  console.log(
    pad("평균", 12) + pad(v, 5) + pad(avg(v, "layers").toFixed(1), 7, true) +
    pad(avg(v, "paths").toFixed(0), 7, true) + pad(avg(v, "nodes").toFixed(0), 8, true) +
    pad(avg(v, "kb").toFixed(1), 8, true) + pad(avg(v, "iou").toFixed(3), 11, true) +
    pad(avg(v, "boundaryF").toFixed(3), 9, true) + pad(avg(v, "deltaE").toFixed(1), 9, true),
  );
}
console.log("=".repeat(96));
console.log("\n실루엣IoU·경계F: 높을수록 원본과 형상이 일치 · 색차ΔE2000: 낮을수록 원본 색에 가까움");
console.log("V1은 플랫 스케치로 한 번 옮긴 뒤 벡터화하므로 색차가 구조적으로 크다(의도된 스타일 변환).");

await fs.writeFile(
  path.join(config.outputsDir, "v2", "comparison.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2),
  "utf8",
);
console.log(`\n표 데이터 → outputs/v2/comparison.json`);
