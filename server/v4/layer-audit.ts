/**
 * 레이어 분리 감사 — "충분히 나뉘었는가"를 9종 전부 실측한다.
 *
 * 의미 gate 는 파트별 IoU 를 보지만, "레이어로 쓸 수 있는가"는 다른 질문이다.
 * 디자이너가 레이어 패널에서 하는 일은 셋이다 — 파트를 켜고 끄고, 파트를 골라 고치고,
 * 파트 하나만 빼서 넘긴다. 그래서 다음을 잰다.
 *
 *   미귀속(orphan)   partId 가 없는 기하 — 어느 레이어에도 안 들어간다
 *   빈 파트          계획에 있는데 자기 기하가 0 인 파트 — 레이어 패널에 없다
 *   흡수(absorbed)   한 파트가 캔버스의 큰 몫을 독점 — 나머지가 그 안에 갇혔다
 *   잉크 점유        파트별로 실제 잉크를 얼마나 그리는가 (면적이 아니라 그린 양)
 *   경계 공유        두 파트가 같은 경계를 각자 그리는가 (이중선 위험)
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { VectorScene, ScenePrimitive, PatternPrimitive } from "./types.js";

const ORDER = ["shoe_1", "shoe_2", "shoe_3", "bag_1", "bag_2", "bag_3", "jewelry_1", "jewelry_2", "jewelry_3"];

export interface PartAudit {
  id: string;
  label: string;
  z: number;
  /** 이 파트가 소유한 프리미티브 수 (패턴은 인스턴스 단위) */
  own: number;
  /** 이 파트가 그리는 잉크성 기하 (면·톤 제외) */
  inkOwn: number;
  /** 전체 프리미티브 중 이 파트의 몫 */
  share: number;
  sharedWith: string[];
}

export interface SampleAudit {
  name: string;
  parts: PartAudit[];
  totalPrimitives: number;
  /** partId 가 없는 프리미티브 */
  orphans: number;
  orphanShare: number;
  /** 자기 기하가 0 인 파트 */
  emptyParts: string[];
  /** 한 파트가 독점하는 최대 몫 */
  maxShare: number;
  maxSharePart: string;
  /** 잉크성 기하를 하나도 안 가진 파트 (면만 있고 선이 없다 = 윤곽이 남의 것) */
  noInkParts: string[];
  weightedIou: number;
  state: string;
}

function isInk(p: ScenePrimitive): boolean {
  if (p.cls === "FACE_FILL" || p.cls === "TEXTURE_TONE") return false;
  if (p.cls === "GEOMETRIC_PRIMITIVE" && (p as { paint?: string }).paint === "fill") return false;
  if (p.cls === "REPEATING_PATTERN" && (p as PatternPrimitive).paint === "fill") return false;
  return true;
}

export async function auditSample(name: string): Promise<SampleAudit> {
  const dir = path.join("outputs", "v4", `v4_${name}`);
  const scene = JSON.parse(await fs.readFile(path.join(dir, "scene.json"), "utf8")) as VectorScene;
  const qa = JSON.parse(await fs.readFile(path.join(dir, "qa_v4.json"), "utf8"));

  // 패턴은 인스턴스마다 파트가 다를 수 있다 — 단위를 인스턴스로 편다
  type Unit = { partId?: string; ink: boolean; shared: string[] };
  const units: Unit[] = [];
  for (const p of scene.primitives) {
    if (p.cls === "REPEATING_PATTERN") {
      const pat = p as PatternPrimitive;
      for (const i of pat.instances) {
        units.push({ partId: i.partId ?? pat.partId, ink: isInk(p), shared: p.shared ?? [] });
      }
      continue;
    }
    units.push({ partId: p.partId, ink: isInk(p), shared: p.shared ?? [] });
  }

  const byPart = new Map<string, { own: number; inkOwn: number; shared: Set<string> }>();
  let orphans = 0;
  for (const u of units) {
    if (!u.partId || u.partId === "_unassigned") { orphans++; continue; }
    const e = byPart.get(u.partId) ?? byPart.set(u.partId, { own: 0, inkOwn: 0, shared: new Set() }).get(u.partId)!;
    e.own++;
    if (u.ink) e.inkOwn++;
    for (const s of u.shared) e.shared.add(s);
  }

  const total = units.length;
  const parts: PartAudit[] = scene.parts.map((node) => {
    const e = byPart.get(node.id);
    return {
      id: node.id, label: node.label, z: node.z,
      own: e?.own ?? 0,
      inkOwn: e?.inkOwn ?? 0,
      share: total ? +((e?.own ?? 0) / total).toFixed(4) : 0,
      sharedWith: [...(e?.shared ?? [])],
    };
  });

  const emptyParts = parts.filter((p) => p.own === 0).map((p) => p.id);
  const noInkParts = parts.filter((p) => p.own > 0 && p.inkOwn === 0).map((p) => p.id);
  let maxShare = 0, maxSharePart = "";
  for (const p of parts) if (p.share > maxShare) { maxShare = p.share; maxSharePart = p.id; }

  return {
    name, parts, totalPrimitives: total,
    orphans, orphanShare: total ? +(orphans / total).toFixed(4) : 0,
    emptyParts, maxShare, maxSharePart, noInkParts,
    weightedIou: qa.qa.semantic.weightedMeanIou,
    state: qa.job.state,
  };
}

if (process.argv[1]?.endsWith("layer-audit.ts")) {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const names = only.length ? only : ORDER;
  const all: SampleAudit[] = [];
  for (const n of names) all.push(await auditSample(n));

  console.log();
  console.log("샘플         파트  빈파트  선없음  미귀속        최대독점              가중IoU");
  for (const a of all) {
    console.log(
      a.name.padEnd(11) +
      String(a.parts.length).padStart(3) +
      String(a.emptyParts.length).padStart(6) +
      String(a.noInkParts.length).padStart(7) +
      `${a.orphans} (${(a.orphanShare * 100).toFixed(1)}%)`.padStart(13) +
      `  ${a.maxSharePart.slice(0, 20).padEnd(20)} ${(a.maxShare * 100).toFixed(0)}%`.padEnd(28) +
      a.weightedIou.toFixed(3),
    );
    if (a.emptyParts.length) console.log(`             빈 파트: ${a.emptyParts.join(", ")}`);
    if (a.noInkParts.length) console.log(`             선 없음: ${a.noInkParts.join(", ")}`);
  }

  console.log();
  const totalParts = all.reduce((s, a) => s + a.parts.length, 0);
  const totalEmpty = all.reduce((s, a) => s + a.emptyParts.length, 0);
  const totalNoInk = all.reduce((s, a) => s + a.noInkParts.length, 0);
  const totalOrphan = all.reduce((s, a) => s + a.orphans, 0);
  const totalUnits = all.reduce((s, a) => s + a.totalPrimitives, 0);
  console.log(`합계  파트 ${totalParts} · 빈 파트 ${totalEmpty} (${((totalEmpty / totalParts) * 100).toFixed(0)}%) · ` +
    `선 없는 파트 ${totalNoInk} · 미귀속 ${totalOrphan}/${totalUnits} (${((totalOrphan / totalUnits) * 100).toFixed(1)}%)`);

  await fs.writeFile(
    path.join("docs", "samples-v4", "layer-audit.json"),
    JSON.stringify({ samples: all }, null, 1), "utf8",
  );
  console.log("→ docs/samples-v4/layer-audit.json");
}
