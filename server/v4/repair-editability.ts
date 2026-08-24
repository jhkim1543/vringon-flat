/**
 * 편집성 지표만 다시 계산해 qa_v4.json 을 고친다.
 *
 * `d="…"` 를 경계 없이 찾던 정규식이 `data-shared="main_compartment_shell"` 같은 값까지
 * 걸어서 서브패스·앵커가 부풀어 있었다. 그 지표들은 **저장된 SVG 만으로** 결정되므로
 * 파이프라인을 다시 돌릴 필요가 없다 — 같은 함수에 같은 입력을 다시 넣는다.
 *
 *   npx tsx server/v4/repair-editability.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { complexity } from "./export.js";

const ORDER = ["shoe_1", "shoe_2", "shoe_3", "bag_1", "bag_2", "bag_3", "jewelry_1", "jewelry_2", "jewelry_3"];

function subpathStats(svg: string): { subpaths: number; maxInPath: number } {
  let total = 0, max = 0;
  for (const m of svg.matchAll(new RegExp('(?:^|[\\s"])d="([^"]*)"', "g"))) {
    const n = (m[1].match(new RegExp("[Mm]", "g")) ?? []).length;
    total += n;
    if (n > max) max = n;
  }
  return { subpaths: total, maxInPath: max };
}

console.log();
for (const name of ORDER) {
  const src = path.join("outputs", "v4", `v4_${name}`);
  const rep = JSON.parse(await fs.readFile(path.join(src, "qa_v4.json"), "utf8"));
  const e = rep.qa.editability;
  const before = { p: e.paths, s: e.subpaths, m: e.maxSubpathsInPath, a: e.anchors };

  const fid = await fs.readFile(path.join(src, "fidelity.svg"), "utf8");
  const edt = await fs.readFile(path.join(src, "editable.svg"), "utf8");
  const cf = complexity(fid), ce = complexity(edt);
  const sub = subpathStats(fid);

  e.paths = cf.paths; e.anchors = cf.anchors; e.uses = cf.uses; e.kb = cf.kb;
  e.subpaths = sub.subpaths;
  e.maxSubpathsInPath = sub.maxInPath;
  e.objectComplexity = cf.paths + sub.subpaths + cf.uses;
  e.editableReduction = {
    paths: cf.paths ? +(1 - ce.paths / cf.paths).toFixed(3) : 0,
    anchors: cf.anchors ? +(1 - ce.anchors / cf.anchors).toFixed(3) : 0,
    kb: cf.kb ? +(1 - ce.kb / cf.kb).toFixed(3) : 0,
  };

  // anchorDensity 는 앵커 수에 비례한다 — 윤곽 길이는 그대로이므로 비율로 옮긴다
  if (before.a > 0) e.anchorDensity = +((e.anchorDensity * cf.anchors) / before.a).toFixed(2);

  const notes: string[] = (e.notes as string[]).filter(
    (n) => !n.includes("한 패스에 서브패스"),
  );
  if (sub.maxInPath > 200) notes.push(`한 패스에 서브패스 ${sub.maxInPath}개 — Illustrator 에서 통째로 선택된다`);
  e.notes = notes;
  e.pass = e.anchorDensity <= 12 && e.shortPathRatio <= 0.35 && sub.maxInPath <= 200;

  rep.job.state = [
    rep.qa.fidelity.pass ? "FIDELITY_PASS" : "FIDELITY_REVIEW",
    e.pass ? "EDITABILITY_PASS" : "EDITABILITY_REVIEW",
    rep.qa.semantic.pass ? "SEMANTIC_PASS" : "SEMANTIC_REVIEW",
  ].join(" / ");

  const out = JSON.stringify(rep, null, 1);
  await fs.writeFile(path.join(src, "qa_v4.json"), out, "utf8");
  await fs.writeFile(path.join("docs", "samples-v4", name, "qa_v4.json"), out, "utf8");

  console.log(
    `  ${name.padEnd(11)} 패스 ${before.p}→${e.paths} · 서브패스 ${before.s}→${e.subpaths} · ` +
    `최대 ${before.m}→${e.maxSubpathsInPath} · 앵커 ${before.a}→${e.anchors} · ${e.pass ? "PASS" : "REVIEW"}`,
  );
}
