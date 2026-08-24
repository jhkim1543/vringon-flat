/**
 * V4 CLI — Semantic Topology Vectorizer.
 *
 *   npx tsx server/run-v4.ts <이미지> <이름> [옵션]
 *
 * 옵션
 *   --category shoe|bag|jewelry|...   카테고리 힌트
 *   --color                           컬러 플랫 (기본은 모노톤)
 *   --vector-long 2200                벡터 작업 캔버스 목표 장변
 *   --ink 170                         잉크 임계
 *   --texture auto|tone|keep          해프톤 처리
 *   --schematic-from <경로>           기존 도면 재사용 (백엔드 없이 검증)
 *   --no-upscale                      업스케일 생략
 *
 * 산출물은 하나가 아니다 — 목적이 다르면 파일도 다르다.
 *   fidelity.svg    도면과 최대한 같아 보이는 것
 *   editable.svg    적은 패스·앵커
 *   production.svg  기능 레이어 + 파트 + 공유 경계
 *   scene.json      VectorScene 전문 (라우팅 근거 포함)
 */
import path from "node:path";
import { config } from "./config.js";
import { runV4, DEFAULT_V4_OPTIONS, type V4Options } from "./v4/run4.js";
import { activeBackend } from "./v3/schematicClient.js";

const argv = process.argv.slice(2);
const pos = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n: string) => argv.includes(`--${n}`);

const input = pos[0];
const name = pos[1] ?? path.basename(input ?? "", path.extname(input ?? "")) ?? "v4";
if (!input) {
  console.error("usage: tsx server/run-v4.ts <이미지> <이름> [--category shoe] [--color]");
  process.exit(1);
}

const opts: V4Options = {
  ...DEFAULT_V4_OPTIONS,
  categoryHint: flag("category"),
  grayscale: !has("color"),
  vectorLong: Number(flag("vector-long") ?? 2200),
  inkThreshold: Number(flag("ink") ?? 170),
  textureMode: (flag("texture") as V4Options["textureMode"]) ?? "auto",
  schematicFrom: flag("schematic-from"),
  upscale: !has("no-upscale"),
};

console.log("입력    ", input);
console.log("이름    ", name);
console.log("도면    ", opts.schematicFrom ? `재사용 (${opts.schematicFrom})` : (activeBackend() ?? "백엔드 없음"));
console.log("벡터    ", `작업 장변 ${opts.vectorLong}px · 잉크 임계 ${opts.inkThreshold} · 질감 ${opts.textureMode}`);
console.log();

const jobDir = path.join(config.outputsDir, "v4", `v4_${name}`);
const t0 = Date.now();
const r = await runV4(input, jobDir, opts, (s, m) => console.log(`  [${s}] ${m}`));

console.log();
console.log("=== 표현 라우팅 ===");
const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
for (const [k, v] of Object.entries(r.counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(22)} ${String(v).padStart(5)}  ${((v / total) * 100).toFixed(1)}%`);
}

console.log();
console.log("=== 충실도 gate ===");
const f = r.qa.fidelity;
console.log(`  ${f.pass ? "PASS" : "REVIEW"}`);
console.log(`  선 일치 F     0px ${f.f0}  ·  1px ${f.f1}  ·  2px ${f.f2}   (전체 잉크)`);
if (f.textureShare > 0.01) console.log(`  선 충실도     1px ${f.lineF1}  ·  2px ${f.lineF2}   (해프톤 ${(f.textureShare * 100).toFixed(0)}% 제외)`);
console.log(`  선 굵기 비    ${f.inkRatio}   거리 평균 ${f.chamfer}px · p95 ${f.p95}px`);
console.log(`  작은 디테일   ${(f.detailRecall * 100).toFixed(1)}%`);
console.log(`  구멍          도면 ${f.holes[0]} → 벡터 ${f.holes[1]}`);
console.log(`  큰 성분       도면 ${f.majorComponents[0]} → 벡터 ${f.majorComponents[1]}`);
for (const n of f.notes) console.log(`  ! ${n}`);

console.log();
console.log("=== 편집성 gate ===");
const e = r.qa.editability;
console.log(`  ${e.pass ? "PASS" : "REVIEW"}`);
console.log(`  fidelity      패스 ${e.paths} · 서브패스 ${e.subpaths} · 앵커 ${e.anchors} · use ${e.uses} · ${e.kb}KB`);
console.log(`  객체 복잡도   ${e.objectComplexity}  (한 패스 최대 서브패스 ${e.maxSubpathsInPath})`);
console.log(`  editable 절감  패스 ${(e.editableReduction.paths * 100).toFixed(0)}% · 앵커 ${(e.editableReduction.anchors * 100).toFixed(0)}% · 용량 ${(e.editableReduction.kb * 100).toFixed(0)}%`);
console.log(`  앵커 밀도     ${e.anchorDensity}/100px   짧은 패스 ${(e.shortPathRatio * 100).toFixed(0)}%`);
console.log(`  프리미티브    ${e.primitives}개 (앵커 ${e.anchorsSavedByPrimitives} 절감)`);
console.log(`  패턴          패스 ${e.pathsSavedByPatterns} 절감`);
for (const n of e.notes) console.log(`  ! ${n}`);

console.log();
console.log("=== 의미 gate ===");
const s = r.qa.semantic;
console.log(`  ${s.pass ? "PASS" : "REVIEW"}`);
console.log(`  파트 배분     평균 precision ${s.meanPrecision} · 면적가중 IoU ${s.weightedMeanIou}`);
if (s.failingMajorParts.length) console.log(`  기준 미달 주요 파트  ${s.failingMajorParts.join(", ")}`);
console.log(`  공유 경계     ${s.sharedBoundaries}개`);
console.log(`  종횡비 불일치  ${s.aspectRatio}`);
for (const p of s.perPart) {
  const fmt = (v: number) => (v < 0 ? "  —  " : v.toFixed(3));
  console.log(
    `    ${p.id.padEnd(24)} ${p.kind === "thin" ? "선" : "면"} ${(p.areaShare * 100).toFixed(1).padStart(5)}%` +
    `  path ${String(p.paths).padStart(4)}  prec ${fmt(p.precision)}  recall ${fmt(p.recall)}  IoU ${fmt(p.iou)}` +
    (p.kind === "thin" ? `  F1 ${fmt(p.boundaryF1)}` : ""),
  );
}
for (const n of s.notes) console.log(`  ! ${n}`);

console.log();
console.log(`=== 상태 ===\n  ${r.state}`);
console.log();
console.log("=== 소요 ===");
for (const [k, v] of Object.entries(r.timings)) console.log(`  ${k.padEnd(18)} ${(v / 1000).toFixed(1)}s`);
console.log(`  ${"합계".padEnd(18)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log();
console.log(`→ ${jobDir}`);
for (const a of Object.keys(r.artifacts)) console.log(`   ${a}`);
