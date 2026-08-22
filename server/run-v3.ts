/**
 * V3 CLI — VRINGON 플랫스케치 기반 레이어드 SVG.
 *
 *   npx tsx server/run-v3.ts <이미지> <이름> [옵션]
 *
 * 옵션
 *   --category shoe|bag|jewelry|...   카테고리 힌트 (schematic 프롬프트에 쓰인다)
 *   --scope whole|part                전체 도면 1회 후 분할(기본) / 파트별 도면
 *
 *   scope=part는 파트 크롭을 도면 모델에 따로 넣는다. LoRA가 **제품 전체 사진**으로
 *   학습돼 있어 조각을 주면 분포 밖으로 나가고, 그 조각으로 완성품을 지어낸다
 *   (실측: 반지의 검은 인레이 크롭 → 목걸이 펜던트를 그려냄. 실루엣 IoU 0.889,
 *   선 일치 F 0.468, 사진 대비 IoU 0.327 / 같은 샘플 scope=whole은 0.958·0.925·0.881).
 *   그래서 기본은 whole이고, part는 실험용으로만 남긴다.
 *   --color                           컬러 플랫 (기본은 모노톤 도식)
 *   --vector hybrid|outline|centerline  선 표현 (기본 hybrid)
 *                                       outline    = 최고 충실도, 선이 채워진 리본
 *                                       centerline = 최고 편집성, 작은 디테일 손실
 *                                       hybrid     = 긴 구조선만 centerline, 나머지 outline
 *   --vector-long 2200                  벡터 작업 캔버스 목표 장변
 *   --texture auto|tone|keep          해프톤 처리 (기본 auto — 질감이 잉크의 75% 이상이면 유지)
 *   --parts 3-10                      구성품 개수 범위
 *   --ink 190                         잉크 판정 임계
 *   --schematic-from <경로>           기존 도면 재사용 (백엔드 없이 벡터화·어셈블 검증)
 *   --no-upscale                      업스케일 단계 생략 (워커 기본은 켬)
 */
import path from "node:path";
import fs from "node:fs/promises";
import { config } from "./config.js";
import { runV3, DEFAULT_V3_OPTIONS, type V3Options } from "./v3/run3.js";
import { activeBackend } from "./v3/schematicClient.js";

const argv = process.argv.slice(2);
const pos = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n: string) => argv.includes(`--${n}`);

const input = pos[0];
const name = pos[1] ?? path.basename(input ?? "", path.extname(input ?? "")) ?? "v3";
if (!input) {
  console.error("usage: tsx server/run-v3.ts <이미지> <이름> [--category shoe] [--scope part|whole] [--color]");
  process.exit(1);
}

const partsRange = (flag("parts") ?? "3-10").split("-").map(Number);
const opts: V3Options = {
  ...DEFAULT_V3_OPTIONS,
  categoryHint: flag("category"),
  minParts: partsRange[0] || 3,
  maxParts: partsRange[1] || 10,
  schematicScope: (flag("scope") as V3Options["schematicScope"]) ?? "whole",
  grayscale: !has("color"),
  inkThreshold: Number(flag("ink") ?? 170),
  vectorMode: (flag("vector") as V3Options["vectorMode"]) ?? "hybrid",
  textureMode: (flag("texture") as V3Options["textureMode"]) ?? "auto",
  vectorLong: Number(flag("vector-long") ?? 2200),
  schematicFrom: flag("schematic-from"),
  upscale: !has("no-upscale"),
};

const backend = activeBackend();
console.log("입력    ", input);
console.log("이름    ", name);
console.log("벡터    ", `${opts.vectorMode} · 작업 장변 ${opts.vectorLong}px · 잉크 임계 ${opts.inkThreshold}`);
console.log(
  "도면    ",
  opts.schematicFrom
    ? `재사용 (${opts.schematicFrom})`
    : backend
      ? `${backend} · ${opts.grayscale ? "모노톤" : "컬러"} · scope=${opts.schematicScope}`
      : "백엔드 없음",
);
if (!backend && !opts.schematicFrom) {
  console.log();
  console.log("  VRINGON 플랫스케치를 부를 수 없습니다. 셋 중 하나가 필요합니다:");
  console.log("    VRINGON_SCHEMATIC_URL   사내 워커 (Server-Vringon-Lib의 client.schematic.host)");
  console.log("    REPLICATE_API_TOKEN     qwen/qwen-image-edit-2511 + 공개 LoRA (워커와 같은 경로)");
  console.log("    FAL_KEY                 fal의 qwen-image-edit + 같은 LoRA");
  console.log();
  console.log("  벡터화·어셈블만 검증하려면 --schematic-from <기존 도면 경로>를 쓰세요.");
  console.log();
}

const jobDir = path.join(config.outputsDir, "v3", `v3_${name}`);
const t0 = Date.now();

const result = await runV3(input, jobDir, opts, (state, msg) => {
  console.log(`  [${state}] ${msg}`);
});

console.log();
console.log("=== 레이어 ===");
console.log("z  파트".padEnd(28), "면".padStart(5), "선".padStart(6), "노드".padStart(7), " 도면");
for (const l of [...result.layers].sort((a, b) => a.z - b.z)) {
  console.log(
    `${String(l.z).padStart(2)} ${(l.label || l.partId).slice(0, 24)}`.padEnd(28),
    String(l.regions).padStart(5),
    String(l.strokes).padStart(6),
    String(l.nodes).padStart(7),
    " " + (l.note ?? l.schematic?.backend ?? ""),
  );
}

console.log();
console.log("=== QA ===  (기준: 사용자가 보는 도면 원본)");
const q = result.qa;
console.log(`  상태          ${result.state}`);
console.log(`  선 일치 F     0px ${q.rawF0}  ·  1px ${q.rawF1}  ·  2px ${q.rawF2}   (전체 잉크)`);
if (q.textureShare > 0.01) console.log(`  선 충실도     1px ${q.lineF1}  ·  2px ${q.lineF2}   (해프톤 ${(q.textureShare*100).toFixed(0)}% 제외 — 합격 판정 기준)`);
console.log(`  선 굵기 비    ${q.inkRatio}  (1.0 = 원본과 같음)`);
console.log(`  거리 오차     평균 ${q.chamfer}px · p95 ${q.p95}px`);
console.log(`  작은 디테일   ${(q.detailRecall * 100).toFixed(1)}% 보존`);
console.log(`  큰 성분       도면 ${q.majorComponents[0]} → 벡터 ${q.majorComponents[1]}`);
console.log(`  실루엣 IoU    ${q.silhouetteIou}`);
console.log(`  종횡비 불일치  ${q.aspectRatio}  (파트 배분에만 영향)`);
console.log(`  파트 커버리지  ${(q.partCoverage * 100).toFixed(1)}%${q.emptyVisibleParts.length ? `  · 빈 파트 ${q.emptyVisibleParts.length}개` : ""}`);
console.log(`  패스/노드     ${q.totalPaths} / ${q.totalNodes}  (invalid ${q.invalidPaths})`);
console.log(`  파일          ${q.fileKb} KB`);
for (const n of q.notes) console.log(`  ! ${n}`);

console.log();
console.log("=== 소요 ===");
for (const [k, v] of Object.entries(result.timings)) console.log(`  ${k.padEnd(20)} ${(v / 1000).toFixed(1)}s`);
console.log(`  ${"합계".padEnd(20)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.log();
console.log(`→ ${jobDir}`);
for (const f of Object.keys(result.artifacts)) console.log(`   ${f}`);

await fs.writeFile(
  path.join(jobDir, "cli_summary.json"),
  JSON.stringify({ input, name, opts, state: result.state, qa: result.qa, layers: result.layers }, null, 2),
  "utf8",
);
