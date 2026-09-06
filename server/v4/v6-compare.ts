/**
 * 판(version) 사이 품질 비교 — 무엇이 나아졌고 무엇이 나빠졌는지 **샘플 단위로** 본다.
 *
 * 평균만 보면 "좋아졌다"는 말이 늘 참이 된다(한 건이 크게 오르면 다섯 건이 조금씩
 * 내려앉은 것을 덮는다). 그래서 오른 것과 내린 것을 따로 세고, 게이트가 뒤집힌
 * 샘플은 이름으로 적는다.
 *
 *   # 지금 상태를 기준으로 저장
 *   npx tsx server/v4/v6-compare.ts save v5.2
 *   # 나중에 견주기
 *   npx tsx server/v4/v6-compare.ts diff v5.2
 */
import fs from "node:fs/promises";
import path from "node:path";

const mode = process.argv[2] ?? "diff";
const tag = process.argv[3] ?? "prev";
const root = "outputs/v4";
const snapDir = path.join("outputs", "_snapshots");
const snapPath = path.join(snapDir, `${tag}.json`);

interface Snap {
  gates: string; f0: number; lineF2: number; inkRatio: number;
  chamfer: number; detail: number; anchors: number;
}

async function collect(): Promise<Record<string, Snap>> {
  const out: Record<string, Snap> = {};
  for (const d of (await fs.readdir(root)).filter((x) => x.startsWith("v4_") && !x.startsWith("v4__"))) {
    try {
      const q = JSON.parse(await fs.readFile(path.join(root, d, "qa_v4.json"), "utf8")).qa;
      out[d.replace(/^v4_/, "")] = {
        gates: (["fidelity", "editability", "semantic"] as const).map((k) => (q[k]?.pass ? "O" : "X")).join(""),
        f0: q.fidelity?.f0 ?? 0,
        lineF2: q.fidelity?.lineF2 ?? 0,
        inkRatio: q.fidelity?.inkRatio ?? 0,
        chamfer: q.fidelity?.chamfer ?? 0,
        detail: q.fidelity?.detailRecall ?? 0,
        anchors: q.editability?.anchors ?? 0,
      };
    } catch { /* 아직 안 끝난 잡 */ }
  }
  return out;
}

const now = await collect();

if (mode === "save") {
  await fs.mkdir(snapDir, { recursive: true });
  await fs.writeFile(snapPath, JSON.stringify(now, null, 1), "utf8");
  console.log(`\n${tag} 기준 저장 — ${Object.keys(now).length}건 · ${snapPath}`);
  process.exit(0);
}

let prev: Record<string, Snap>;
try {
  prev = JSON.parse(await fs.readFile(snapPath, "utf8"));
} catch {
  console.log(`\n${snapPath} 가 없다. 먼저 \`save ${tag}\` 를 돌려라.`);
  process.exit(1);
}

const names = [...new Set([...Object.keys(prev), ...Object.keys(now)])].sort();
const gateN = (g: string) => (g.match(/O/g) ?? []).length;

let up = 0, down = 0, same = 0, pG = 0, nG = 0, tot = 0;
const flips: string[] = [];
const regressions: string[] = [];

for (const n of names) {
  const a = prev[n], b = now[n];
  if (!a || !b) continue;
  tot++;
  pG += gateN(a.gates); nG += gateN(b.gates);
  if (a.gates !== b.gates) {
    const arrow = gateN(b.gates) > gateN(a.gates) ? "↑" : gateN(b.gates) < gateN(a.gates) ? "↓" : "=";
    flips.push(`  ${arrow} ${n.padEnd(15)} ${a.gates} → ${b.gates}`);
  }
  const df = +(b.f0 - a.f0).toFixed(4);
  if (df > 0.005) up++; else if (df < -0.005) { down++; regressions.push(`  ${n.padEnd(15)} F@0 ${a.f0.toFixed(3)} → ${b.f0.toFixed(3)} (${df.toFixed(3)}) · 앵커 ${a.anchors} → ${b.anchors}`); }
  else same++;
}

const mean = (f: (s: Snap) => number, src: Record<string, Snap>) => {
  const v = names.map((n) => src[n]).filter(Boolean).map(f);
  return v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0;
};

console.log(`\n=== ${tag} → 현재 (${tot}건 대조) ===\n`);
console.log(`게이트   ${pG}/${tot * 3} (${((pG / (tot * 3)) * 100).toFixed(0)}%) → ${nG}/${tot * 3} (${((nG / (tot * 3)) * 100).toFixed(0)}%)`);
console.log(`F@0      ${mean((s) => s.f0, prev).toFixed(4)} → ${mean((s) => s.f0, now).toFixed(4)}`);
console.log(`선F@2    ${mean((s) => s.lineF2, prev).toFixed(4)} → ${mean((s) => s.lineF2, now).toFixed(4)}`);
console.log(`chamfer  ${mean((s) => s.chamfer, prev).toFixed(3)} → ${mean((s) => s.chamfer, now).toFixed(3)}`);
console.log(`잉크비   ${mean((s) => s.inkRatio, prev).toFixed(3)} → ${mean((s) => s.inkRatio, now).toFixed(3)}`);
console.log(`앵커     ${Math.round(mean((s) => s.anchors, prev))} → ${Math.round(mean((s) => s.anchors, now))}`);
console.log(`\nF@0 기준: 오름 ${up} · 내림 ${down} · 제자리 ${same}`);

if (flips.length) { console.log("\n게이트가 뒤집힌 샘플:"); console.log(flips.join("\n")); }
else console.log("\n게이트가 뒤집힌 샘플 없음");

if (regressions.length) { console.log("\n**나빠진 샘플** (덮지 말고 봐야 할 것):"); console.log(regressions.join("\n")); }
else console.log("\n나빠진 샘플 없음");
