/**
 * 앵커 실사 — **Illustrator 가 실제로 보여 주는 수**를 센다.
 *
 * 기존 지표는 SVG 의 `<path d>` 만 세었다. 그런데 반복 패턴은 SVG 에서 모티프 하나 +
 * `<use>` 참조로 저장되고, `.ai` 로 나갈 때 **인스턴스마다 펼쳐진다**. 그래서 SVG 기준
 * 앵커 수가 실제 편집 화면보다 훨씬 작게 나왔다(실측 bag_2: SVG 3,0xx → 펼치면 9만 개대).
 *
 * 여기서는 셋을 나눠 센다.
 *   직접   일반 패스의 앵커
 *   모티프 패턴 모티프 자체의 앵커(정의 1회)
 *   펼침   모티프 앵커 × 인스턴스 수 — .ai 에 실제로 들어가는 수
 *
 * 촘촘함은 **이웃 앵커 사이 거리**로 본다. 밀도(개/100px)는 긴 선이 성기면 평균이 좋아
 * 국소 뭉침을 가린다. 4px 미만 비율이 사람이 "점이 너무 많다"고 느끼는 것에 가깝다.
 *
 *   npx tsx server/v4/anchor-audit.ts [샘플,샘플...] [--base .baseline-v47]
 */
import fs from "node:fs/promises";
import { parsePath } from "../vector/pathdata.js";

const PATH_TAG = () => new RegExp("<path\\b([^>]*)>", "g");
const SYMBOL = () =>
  new RegExp('<symbol id="motif-([^"]+)"[^>]*>\\s*<path d="([^"]*)"', "g");
const USE_REF = () => new RegExp('xlink:href="#motif-([^"]+)"', "g");
const ATTR = (n: string) => new RegExp(`${n}="([^"]*)"`);

export interface AnchorReport {
  /** 일반 패스 앵커 */
  direct: number;
  /** 모티프 정의 자체의 앵커 */
  motif: number;
  /** 인스턴스까지 펼친 모티프 앵커 */
  expanded: number;
  /** 직접 + 펼침 — .ai 기준 실제 앵커 */
  total: number;
  instances: number;
  /** 이웃 앵커 간격이 4px 미만인 비율(직접 패스 기준) */
  tight4: number;
  tight8: number;
  medianGap: number;
}

const anchorsIn = (d: string) => (d.match(new RegExp("[MLCQSTA]", "g")) ?? []).length;

export async function auditAnchors(svgPath: string): Promise<AnchorReport> {
  const svg = await fs.readFile(svgPath, "utf8");
  const dEnd = svg.indexOf("</defs>");
  const defs = dEnd > 0 ? svg.slice(svg.indexOf("<defs"), dEnd + 7) : "";

  // 모티프 정의
  const motifAnchors = new Map<string, number>();
  for (const m of defs.matchAll(SYMBOL())) motifAnchors.set(m[1], anchorsIn(m[2]));

  // 인스턴스
  const uses = new Map<string, number>();
  for (const u of svg.matchAll(USE_REF())) uses.set(u[1], (uses.get(u[1]) ?? 0) + 1);

  let motif = 0, expanded = 0, instances = 0;
  for (const [id, a] of motifAnchors) {
    motif += a;
    const n = uses.get(id) ?? 0;
    expanded += a * n;
    instances += n;
  }

  // 일반 패스 — defs 안쪽은 위에서 이미 셌으므로 뺀다
  const body = dEnd > 0 ? svg.slice(dEnd) : svg;
  let direct = 0;
  const gaps: number[] = [];
  for (const m of body.matchAll(PATH_TAG())) {
    const d = ATTR("d").exec(m[1])?.[1];
    if (!d) continue;
    for (const sp of parsePath(d)) {
      direct++;
      let prev = sp.start;
      for (const seg of sp.segs) {
        gaps.push(Math.hypot(seg.end[0] - prev[0], seg.end[1] - prev[1]));
        prev = seg.end;
        direct++;
      }
    }
  }
  gaps.sort((a, b) => a - b);
  const share = (t: number) => (gaps.length ? gaps.filter((g) => g < t).length / gaps.length : 0);
  return {
    direct, motif, expanded, total: direct + expanded, instances,
    tight4: share(4), tight8: share(8),
    medianGap: gaps.length ? gaps[gaps.length >> 1] : 0,
  };
}

// ── CLI ─────────────────────────────────────────────────────
const ORDER = ["shoe_1", "shoe_2", "shoe_3", "bag_1", "bag_2", "bag_3", "jewelry_1", "jewelry_2", "jewelry_3"];

if (process.argv[1]?.replace(/\\/g, "/").endsWith("anchor-audit.ts")) {
  const argv = process.argv.slice(2);
  const baseIdx = argv.indexOf("--base");
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : undefined;
  const names = (
    argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"))[0] ?? ""
  ).split(",").filter(Boolean);
  const list = names.length ? names : ORDER;

  const pad = (v: number, w: number) => String(v).padStart(w);
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  console.log();
  console.log("샘플         직접앵커   모티프  인스턴스     펼친앵커   .ai 총계   4px미만  간격중앙");
  let tD = 0, tE = 0, tT = 0;
  const rows: { name: string; cur: AnchorReport; old?: AnchorReport }[] = [];
  for (const n of list) {
    const cur = await auditAnchors(`outputs/v4/v4_${n}/fidelity.svg`);
    let old: AnchorReport | undefined;
    if (base) {
      try { old = await auditAnchors(`${base}/${n}/fidelity.svg`); } catch { /* 기준선 없음 */ }
    }
    rows.push({ name: n, cur, old });
    tD += cur.direct; tE += cur.expanded; tT += cur.total;
    console.log(
      `${n.padEnd(12)}${pad(cur.direct, 8)} ${pad(cur.motif, 8)} ${pad(cur.instances, 9)}` +
      ` ${pad(cur.expanded, 12)} ${pad(cur.total, 10)}  ${pct(cur.tight4).padStart(7)}` +
      `  ${cur.medianGap.toFixed(1).padStart(7)}`,
    );
  }
  console.log(`${"합계".padEnd(12)}${pad(tD, 8)} ${" ".repeat(18)}${pad(tE, 12)} ${pad(tT, 10)}`);

  if (base) {
    console.log(`\n=== ${base} 대비 ===`);
    let oT = 0;
    for (const r of rows) {
      if (!r.old) continue;
      oT += r.old.total;
      const dl = ((r.cur.total - r.old.total) / Math.max(1, r.old.total)) * 100;
      console.log(
        `${r.name.padEnd(12)} .ai 앵커 ${pad(r.old.total, 8)} → ${pad(r.cur.total, 8)}` +
        ` (${dl.toFixed(1).padStart(6)}%)   4px미만 ${pct(r.old.tight4).padStart(6)} → ${pct(r.cur.tight4).padStart(6)}`,
      );
    }
    if (oT) console.log(`\n합계 ${oT.toLocaleString()} → ${tT.toLocaleString()} (${(((tT - oT) / oT) * 100).toFixed(1)}%)`);
  }
  console.log();
}
