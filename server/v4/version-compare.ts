/**
 * 역대 버전 비교 — **지금 것이 정말 제일 나은가.**
 *
 * 버전마다 좋아진 지표만 골라 보고하면 회귀를 못 본다. 여기서는 세 축을 **모두** 놓고
 * 함께 본다. 하나를 올리려고 다른 하나를 깎았다면 그 자리에서 드러난다.
 *
 *   충실도  도면과 같아 보이는가 (선 F@2px · 전체 잉크 F@2px)
 *   편집성  Illustrator 에서 다룰 만한가 (패스·서브패스·앵커·앵커 밀도)
 *   레이어  파트대로 나뉘었는가 (빈 파트·자기 선 없는 파트·가중 IoU·최대 독점)
 *
 * V3.2~V4.3 의 수치는 각 버전 시점에 실측해 커밋 메시지·README 에 남긴 값이고,
 * 지금 버전은 이 자리에서 다시 잰다.
 */
import fs from "node:fs/promises";
import { auditSample } from "./layer-audit.js";

const ORDER = ["shoe_1", "shoe_2", "shoe_3", "bag_1", "bag_2", "bag_3", "jewelry_1", "jewelry_2", "jewelry_3"];

/** 각 버전 시점에 실측해 문서에 남긴 값 */
const HISTORY = [
  { v: "V3.2", paths: 8738, anchors: 124337, f0: 0.839, lineF2: 0.975, subpaths: null as number | null, emptyParts: null as number | null, noInk: null as number | null, wIou: null as number | null, sem: null as number | null },
  { v: "V4.0", paths: 2800, anchors: 123248, f0: 0.885, lineF2: 0.976, subpaths: null, emptyParts: null, noInk: null, wIou: null, sem: 5 },
  { v: "V4.1", paths: 2800, anchors: 123248, f0: 0.885, lineF2: 0.976, subpaths: 8469, emptyParts: null, noInk: null, wIou: null, sem: 0 },
  { v: "V4.2", paths: 2179, anchors: 114890, f0: 0.885, lineF2: 0.976, subpaths: 7886, emptyParts: null, noInk: null, wIou: null, sem: 0 },
  { v: "V4.3", paths: 2179, anchors: 114890, f0: 0.885, lineF2: 0.976, subpaths: 7886, emptyParts: 14, noInk: 23, wIou: 0.777, sem: 0 },
  // V4.4 (잉크 분할) 는 이 자리에서 직접 재서 기준선으로 저장했다 — outputs/v4/_baseline_v44
  { v: "V4.4", paths: 2581, anchors: 118279, f0: 0.874, lineF2: 0.976, subpaths: 8047, emptyParts: 2, noInk: 0, wIou: 0.907, sem: 8 },
];

const now = {
  paths: 0, anchors: 0, subpaths: 0, f0: 0, lineF2: 0, f2all: 0,
  emptyParts: 0, noInk: 0, wIou: 0, sem: 0, fid: 0, edit: 0,
  maxShare: 0, density: 0, orphans: 0, parts: 0,
};
const rows: string[][] = [];

for (const n of ORDER) {
  const q = JSON.parse(await fs.readFile(`outputs/v4/v4_${n}/qa_v4.json`, "utf8"));
  const a = await auditSample(n);
  const f = q.qa.fidelity, e = q.qa.editability, s = q.qa.semantic;
  now.paths += e.paths; now.anchors += e.anchors; now.subpaths += e.subpaths;
  now.f0 += f.f0; now.lineF2 += f.lineF2; now.f2all += f.f2;
  now.density += e.anchorDensity;
  now.emptyParts += a.emptyParts.length;
  now.noInk += a.noInkParts.length;
  now.orphans += a.orphans;
  now.parts += a.parts.length;
  now.wIou += s.weightedMeanIou;
  now.maxShare = Math.max(now.maxShare, a.maxShare);
  if (f.pass) now.fid++;
  if (e.pass) now.edit++;
  if (s.pass) now.sem++;
  rows.push([
    n, String(e.paths), String(e.subpaths), String(e.maxSubpathsInPath),
    String(e.anchors), e.anchorDensity.toFixed(2),
    f.f0.toFixed(3), f.lineF2.toFixed(3),
    s.weightedMeanIou.toFixed(3),
    `${f.pass ? "F+" : "F-"} ${e.pass ? "E+" : "E-"} ${s.pass ? "S+" : "S-"}`,
  ]);
}
const k = ORDER.length;

console.log();
console.log("── 샘플별 현재값 ──────────────────────────────────────────────────────");
console.log("샘플         패스  서브패스  최대  앵커     밀도   F@0    선F@2  가중IoU  게이트");
for (const r of rows) {
  console.log(
    r[0].padEnd(11) + r[1].padStart(5) + r[2].padStart(9) + r[3].padStart(7) +
    r[4].padStart(8) + r[5].padStart(8) + r[6].padStart(8) + r[7].padStart(7) +
    r[8].padStart(9) + "  " + r[9],
  );
}

console.log();
console.log("── 역대 버전 비교 (9종 합계·평균) ─────────────────────────────────────");
console.log("버전    패스    서브패스   앵커      F@0    선F@2   빈파트  선없음  가중IoU  의미gate");
const fmt = (v: number | null, d = 0) => (v === null ? "—" : d ? v.toFixed(d) : String(v));
for (const h of HISTORY) {
  console.log(
    h.v.padEnd(8) + fmt(h.paths).padStart(6) + fmt(h.subpaths).padStart(10) +
    fmt(h.anchors).padStart(9) + fmt(h.f0, 3).padStart(8) + fmt(h.lineF2, 3).padStart(8) +
    fmt(h.emptyParts).padStart(8) + fmt(h.noInk).padStart(8) +
    fmt(h.wIou, 3).padStart(9) + (h.sem === null ? "—" : `${h.sem}/9`).padStart(10),
  );
}
console.log(
  "지금".padEnd(7) + String(now.paths).padStart(6) + String(now.subpaths).padStart(10) +
  String(now.anchors).padStart(9) + (now.f0 / k).toFixed(3).padStart(8) +
  (now.lineF2 / k).toFixed(3).padStart(8) + String(now.emptyParts).padStart(8) +
  String(now.noInk).padStart(8) + (now.wIou / k).toFixed(3).padStart(9) +
  `${now.sem}/9`.padStart(10),
);

console.log();
console.log(`현재 게이트  충실도 ${now.fid}/9 · 편집성 ${now.edit}/9 · 의미 ${now.sem}/9`);
console.log(`앵커 밀도    평균 ${(now.density / k).toFixed(2)}/100px   (상한 12)`);
console.log(`레이어       파트 ${now.parts}개 · 주인 없는 기하 ${now.orphans}개 · 한 파트 최대 독점 ${(now.maxShare * 100).toFixed(0)}%`);
