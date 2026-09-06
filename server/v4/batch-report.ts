/**
 * 배치 테스트 리포트 — **어디서 무엇이 무너지는지**를 한 장으로.
 *
 * 샘플 9종은 손으로 고른 것이라 파이프라인의 실제 실패 분포를 못 보여 준다.
 * 크롤링 30여 장을 돌린 뒤 이 리포트로 (게이트 · 앵커 · 실패 사유)를 모아 본다.
 * 목적은 평균 자랑이 아니라 **꼬리(최악 사례)를 찾는 것**이다.
 *
 *   npx tsx server/v4/batch-report.ts [접두사]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { auditAnchors } from "./anchor-audit.js";

const prefix = process.argv[2] ?? "t_";
const root = "outputs/v4";
const dirs = (await fs.readdir(root))
  .filter((d) => d.startsWith(`v4_${prefix}`))
  .sort();

interface Row {
  name: string;
  cat: string;
  gates: string;
  pass: number;
  f0: number;
  lineF2: number;
  inkRatio: number;
  anchors: number;
  density: number;
  tight4: number;
  fidNotes: string[];
  editNotes: string[];
  semNotes: string[];
}

const rows: Row[] = [];
for (const d of dirs) {
  const name = d.replace(`v4_${prefix}`, "");
  try {
    const q = JSON.parse(await fs.readFile(path.join(root, d, "qa_v4.json"), "utf8"));
    const g = q.qa;
    const gates = (["fidelity", "editability", "semantic"] as const)
      .map((k) => (g[k]?.pass ? "O" : "X")).join("");
    let anchors = g.editability?.anchors ?? 0;
    let tight4 = 0;
    try {
      const a = await auditAnchors(path.join(root, d, "fidelity.svg"));
      anchors = a.total;
      tight4 = a.tight4;
    } catch { /* 렌더 전이면 QA 값을 쓴다 */ }
    rows.push({
      name,
      cat: name.split("_")[0],
      gates,
      pass: gates.split("O").length - 1,
      f0: g.fidelity?.f0 ?? 0,
      lineF2: g.fidelity?.lineF2 ?? 0,
      inkRatio: g.fidelity?.inkRatio ?? 0,
      anchors,
      density: g.editability?.anchorDensity ?? 0,
      tight4,
      fidNotes: g.fidelity?.notes ?? [],
      editNotes: g.editability?.notes ?? [],
      semNotes: g.semantic?.notes ?? [],
    });
  } catch { /* 아직 안 끝난 잡 */ }
}

if (!rows.length) {
  console.log(`\n${prefix} 로 시작하는 완료 잡이 없다.`);
  process.exit(0);
}

console.log(`\n=== 배치 리포트 (${rows.length}건) ===\n`);
console.log("샘플            게이트  F@0     선F@2   잉크비  .ai앵커  밀도   4px미만");
for (const r of rows) {
  console.log(
    `${r.name.padEnd(15)} ${r.gates}   ${r.f0.toFixed(3)}  ${r.lineF2.toFixed(3)}  ` +
    `${r.inkRatio.toFixed(2).padStart(5)}  ${String(r.anchors).padStart(6)}  ` +
    `${r.density.toFixed(1).padStart(5)}  ${(r.tight4 * 100).toFixed(1).padStart(5)}%`,
  );
}

const tot = rows.length * 3;
const got = rows.reduce((a, r) => a + r.pass, 0);
console.log(`\n게이트 통과 ${got}/${tot} (${((got / tot) * 100).toFixed(0)}%)`);

// 카테고리별
const cats = [...new Set(rows.map((r) => r.cat))];
console.log("\n카테고리별:");
for (const c of cats) {
  const rs = rows.filter((r) => r.cat === c);
  const p = rs.reduce((a, r) => a + r.pass, 0);
  const anch = rs.reduce((a, r) => a + r.anchors, 0) / rs.length;
  const t4 = rs.reduce((a, r) => a + r.tight4, 0) / rs.length;
  console.log(
    `  ${c.padEnd(10)} ${rs.length}건 · 게이트 ${p}/${rs.length * 3}` +
    ` · 평균 앵커 ${Math.round(anch)} · 평균 4px미만 ${(t4 * 100).toFixed(1)}%`,
  );
}

// 실패 사유 빈도 — 꼬리를 찾는다
const freq = new Map<string, number>();
const norm = (s: string) => s
  .replace(new RegExp("\\d+(\\.\\d+)?", "g"), "N")
  .replace(new RegExp("[:：].*$"), "")
  .slice(0, 46);
for (const r of rows) {
  for (const n of [...r.fidNotes, ...r.editNotes, ...r.semNotes]) {
    const k = norm(n);
    freq.set(k, (freq.get(k) ?? 0) + 1);
  }
}
console.log("\n실패·경고 사유 빈도 (상위 12):");
for (const [k, v] of [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(v).padStart(3)}회  ${k}`);
}

// 앵커 최악 5
console.log("\n앵커가 많은 상위 5:");
for (const r of [...rows].sort((a, b) => b.anchors - a.anchors).slice(0, 5)) {
  console.log(`  ${r.name.padEnd(15)} ${String(r.anchors).padStart(6)}개 · 밀도 ${r.density.toFixed(1)} · 4px미만 ${(r.tight4 * 100).toFixed(1)}%`);
}
