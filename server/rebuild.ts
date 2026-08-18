/**
 * 재빌드: 이미 생성된 잡의 candidate와 Qwen 캐시를 재사용해
 * 평가 → 분해 → QA → 벡터화 → 산출물만 다시 실행한다.
 * 이미지 생성 API는 호출하지 않으며, Qwen도 캐시가 있으면 재과금 없다.
 * 복수 인스턴스 잡(inst_0, inst_1 …)도 인스턴스별로 돌려 하나의 IR로 합친다.
 * 실행: npx tsx server/rebuild.ts <jobId>
 */
import path from "node:path";
import fs from "node:fs/promises";
import { config } from "./config.js";
import { rankCandidates } from "./pipeline/rank.js";
import { decomposeLayers } from "./pipeline/decompose.js";
import { compositeQa, editabilityCheck, sanitizeIr } from "./pipeline/qa.js";
import { vectorizeLayers } from "./pipeline/vectorize.js";
import { mergeInstanceIrs } from "./pipeline/run.js";
import { buildAiPdf } from "./writers/aiPdfWriter.js";
import { buildJsx } from "./writers/jsxWriter.js";
import { buildSvg } from "./writers/svgWriter.js";
import { understandImage } from "./clients/openaiClient.js";
import type { FlatCandidate, LayerPlan, VectorIR } from "./types.js";

const jobId = process.argv[2];
if (!jobId) throw new Error("usage: tsx server/rebuild.ts <jobId>");
const jobDir = path.join(config.outputsDir, jobId);
const input = path.join(jobDir, "input.png");

// 인스턴스 디렉터리 — 없으면 잡 루트가 유일한 인스턴스
const instDirs = (await fs.readdir(jobDir))
  .filter((f) => /^inst_\d+$/.test(f))
  .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
  .map((f) => path.join(jobDir, f));
const multi = instDirs.length > 1;
const units = multi
  ? instDirs.map((dir, i) => ({ dir, index: i, input: path.join(jobDir, "instances", `instance_${i}.png`) }))
  : [{ dir: jobDir, index: 0, input }];

// Layer Plan: 캐시가 있으면 재사용, 없으면 1회 생성 후 저장
const planPath = path.join(jobDir, "plan.json");
let plan: LayerPlan;
try {
  plan = JSON.parse(await fs.readFile(planPath, "utf8"));
  console.log("plan: 캐시 사용");
} catch {
  try {
    plan = await understandImage(input, "standard", "footwear");
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2));
    console.log("plan: 새로 생성");
  } catch (e) {
    // OpenAI가 죽어 있어도(크레딧 소진 등) 벡터화 단계는 검증할 수 있어야 한다.
    // 이전 실행이 남긴 레이어 PNG 이름에서 최소 plan을 복원한다.
    const dir = path.join(units[0].dir, "layers");
    const parts = (await fs.readdir(dir))
      .filter((f) => f.startsWith("layer_") && !f.includes("linework") && !f.includes("__base") && !/layer_region_\d+/.test(f))
      .map((f) => f.replace(/^layer_/, "").replace(/\.png$/, ""))
      .map((id) => ({
        id,
        name: id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        parent: "PARTS",
        kind: "fill" as const,
        segPrompt: id,
      }));
    if (!parts.length) throw e;
    plan = { category: "other", objectNoun: "object", view: "side", parts };
    console.log(`plan: OpenAI 불가 → 기존 레이어 ${parts.length}개에서 복원 (${(e as Error).message.slice(0, 60)})`);
  }
}

const per: { inst: { index: number; score: number }; ir: VectorIR }[] = [];
const qaAll: import("./pipeline/qa.js").QaReport[] = [];
for (const u of units) {
  const tag = multi ? `[${u.index + 1}/${units.length}] ` : "";
  // candidate 복원
  const candDir = path.join(u.dir, "candidates");
  const candidates: FlatCandidate[] = (await fs.readdir(candDir))
    .filter((f) => f.endsWith(".png"))
    .map((f) => {
      const id = f.replace(".png", "");
      const [m, kind] = id.split("_");
      return {
        id,
        model: m === "G" ? "gemini" : "gpt-image",
        kind: kind as FlatCandidate["kind"],
        imagePath: path.join(candDir, f),
      };
    });

  const winners = await rankCandidates(u.input, candidates);
  console.log(`\n=== ${tag}재평가 ===`);
  for (const c of candidates)
    console.log(
      c.id.padEnd(16),
      "total", String(c.score?.total).padEnd(6),
      "IoU", c.score?.silhouetteIoU,
      c.id === winners.lineart?.id || c.id === winners.colorflat?.id ? "← WINNER" : "",
    );
  if (!winners.lineart || !winners.colorflat) throw new Error("승자 없음");

  const dec = await decomposeLayers(
    plan,
    winners.colorflat.imagePath,
    winners.lineart.imagePath,
    u.input,
    path.join(u.dir, "layers"),
    (m) => console.log("  ·", m),
  );
  console.log(`\n${tag}분해: ${dec.engine}`);
  console.log(`  ${JSON.stringify(dec.stats)}`);
  for (const l of dec.layers) console.log(`  ${l.parent.padEnd(14)} ${l.name}  ${l.dominantColor}`);

  const qa = await compositeQa(dec.layers, path.join(u.dir, "layers", "_aligned_flat.png"));
  console.log(`\n=== ${tag}재합성 QA ===`);
  console.log(`  pass=${qa.pass} coverage=${qa.coverage} spill=${qa.spill} colorΔE=${qa.colorDeltaE}`);
  if (qa.notes.length) qa.notes.forEach((n) => console.log("  ! " + n));
  qaAll.push(qa);

  const { ir, engine } = await vectorizeLayers(dec.layers, dec.width, dec.height, (m) =>
    console.log("  ·", m),
  );
  console.log(`\n${tag}벡터화: ${engine}`);
  // 인스턴스 점수: 큰 인스턴스가 아래에 깔리도록 면적으로 대신한다
  per.push({ inst: { index: u.index, score: 1 - u.index * 0.01 }, ir });
}

// QA 요약을 잡 폴더에 남긴다 — 데모/리포트가 재실행 없이 읽을 수 있게
await fs.writeFile(
  path.join(jobDir, "qa.json"),
  JSON.stringify(
    {
      pass: qaAll.every((q) => q.pass),
      coverage: Math.min(...qaAll.map((q) => q.coverage)),
      spill: Math.max(...qaAll.map((q) => q.spill)),
      colorDeltaE: Math.max(...qaAll.map((q) => q.colorDeltaE)),
      notes: qaAll.flatMap((q) => q.notes),
    },
    null,
    2,
  ),
  "utf8",
);

const ir = multi ? mergeInstanceIrs(per, []) : per[0].ir;
const anchors = ir.layers.reduce(
  (n, l) => n + l.groups.reduce((m, g) => m + g.paths.reduce((k, p) => k + (p.d.match(/[LC]/g) ?? []).length, 0), 0),
  0,
);
const paths = ir.layers.reduce((n, l) => n + l.groups.reduce((m, g) => m + g.paths.length, 0), 0);
console.log(`  paths=${paths} anchors=${anchors}${multi ? ` · 인스턴스 ${per.length}개 병합` : ""}`);
const sanitized = sanitizeIr(ir);
if (sanitized) console.log(`  ! 유효하지 않은 패스 ${sanitized}개 정화`);
editabilityCheck(ir).forEach((n) => console.log("  ! " + n));

const base = `flat_${jobId.slice(0, 8)}`;
await fs.writeFile(path.join(jobDir, `${base}.ai`), buildAiPdf(ir));
await fs.writeFile(path.join(jobDir, `${base}.jsx`), buildJsx(ir, `${base}_native.ai`), "utf8");
await fs.writeFile(path.join(jobDir, `${base}.svg`), buildSvg(ir), "utf8");
await fs.writeFile(path.join(jobDir, `${base}.ir.json`), JSON.stringify(ir, null, 2), "utf8");
console.log(`\nOK → ${path.join(jobDir, base)}.{ai,jsx,svg,ir.json}`);
