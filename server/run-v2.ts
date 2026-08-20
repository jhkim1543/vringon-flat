/**
 * V2 파이프라인 CLI — 개발계획서 구현본을 이미지 하나에 실행한다.
 *
 *   npx tsx server/run-v2.ts <이미지경로> [출력이름] [--preset draft|standard|high]
 *                            [--mode clean_flat|faithful_vector|line_art]
 *                            [--category jewelry.ring] [--max-layers 8]
 *
 * 결과는 outputs/v2/<이름>/ 에 계획서의 산출물 세트로 남는다.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { config } from "./config.js";
import { runV2, DEFAULT_V2_OPTIONS, type V2Options } from "./v2/run2.js";
import type { TargetMode } from "./v2/schema.js";
import type { QualityPreset } from "./v2/qwenWorker.js";

const args = process.argv.slice(2);
const input = args[0];
if (!input) {
  console.error("usage: tsx server/run-v2.ts <image> [name] [--preset standard] [--mode clean_flat] [--category jewelry.ring]");
  process.exit(1);
}
const name = args[1] && !args[1].startsWith("--") ? args[1] : path.basename(input).replace(/\.[^.]+$/, "");
const flag = (k: string): string | undefined => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const opts: V2Options = {
  ...DEFAULT_V2_OPTIONS,
  qualityPreset: (flag("preset") as QualityPreset) ?? "standard",
  targetMode: (flag("mode") as TargetMode) ?? "clean_flat",
  categoryHint: flag("category"),
  maxLayers: Number(flag("max-layers") ?? 8),
  maxRetryRounds: Number(flag("retries") ?? 1),
  workLong: Number(flag("work") ?? 1024),
};

const jobDir = path.join(config.outputsDir, "v2", name);
await fs.mkdir(jobDir, { recursive: true });

console.log(`V2 파이프라인 — ${input}`);
console.log(`  preset=${opts.qualityPreset} mode=${opts.targetMode} maxLayers=${opts.maxLayers}`);
console.log(`  출력 → ${jobDir}\n`);

const t0 = Date.now();
let lastState = "";
const res = await runV2(input, jobDir, opts, (state, msg) => {
  if (state !== lastState) {
    console.log(`\n[${state}]`);
    lastState = state;
  }
  console.log("  ·", msg);
});

console.log(`\n=== 결과: ${res.state} (${((Date.now() - t0) / 1000).toFixed(0)}초) ===`);
console.log(`\n레이어 ${res.manifest.layers.length}개 (back→front):`);
for (const L of [...res.manifest.layers].sort((a, b) => a.z_index - b.z_index)) {
  const sel = null;
  void sel;
  console.log(
    `  z${String(L.z_index).padStart(2)} ${L.id.padEnd(22)} ${L.semantic_role.padEnd(11)} ` +
      `${L.material.padEnd(16)} ${L.vector_profile.padEnd(15)} conf ${L.confidence}` +
      (L.requires_review ? " ⚠검토" : ""),
  );
}

const q = res.qa;
console.log(`\n=== QA (${q.metricVersion}) ===`);
console.log(`  pass=${q.pass} needsReview=${q.needsReview}`);
console.log(`  구조     레이어 ${q.structure.layerCount} · ID고유 ${q.structure.idUnique} · DAG ${q.structure.zOrderDag} · manifest↔SVG ${q.structure.manifestSvgIntegrity}`);
console.log(`  실루엣   foreground IoU ${q.silhouette.foregroundIou} · 경계 F ${q.silhouette.boundaryFScore} (P ${q.silhouette.boundaryPrecision} / R ${q.silhouette.boundaryRecall})`);
console.log(`  색상     masked ΔE2000 ${q.color.maskedDeltaE2000}${q.color.outliers.length ? ` · 이상치 ${q.color.outliers.map((o) => `${o.layerId}(${o.deltaE})`).join(", ")}` : ""}`);
console.log(`  지각     SSIM ${q.perceptual.ssim}`);
console.log(`  Amodal   연속성 ${q.amodal.continuity} · hidden 최대 ${q.amodal.hiddenRatioMax}${q.amodal.uncertainLayers.length ? ` · 검토 ${q.amodal.uncertainLayers.join(", ")}` : ""}`);
console.log(`  벡터     path ${q.vector.totalPaths} · node ${q.vector.totalNodes} · ${q.vector.fileKb}KB · invalid ${q.vector.invalidGeometry} · strict ${q.vector.strictVectorCompliant}`);
if (q.failures.length) {
  console.log(`\n실패 신호 ${q.failures.length}건:`);
  for (const f of q.failures.slice(0, 10))
    console.log(`  · [${f.signal}] ${f.layerId ?? "-"} — ${f.detail}\n      → ${f.action}`);
}
if (res.retries.length) {
  console.log(`\n재시도:`);
  for (const r of res.retries) console.log(`  round ${r.round}: ${r.layerIds.join(", ")} (${r.reason})`);
}
console.log(`\n단계별 소요(초): ${res.stages.map((s) => `${s.id}=${(s.ms / 1000).toFixed(1)}`).join(" ")}`);
console.log(`\n산출물:`);
for (const k of Object.keys(res.artifacts)) console.log(`  ${k}`);
