/**
 * 끝점 잇기 A/B — 이미 만든 scene.json 에 bridgeGaps 를 **한 번 더** 돌려 보고
 * 코너 이음·이음매 재피팅이 무엇을 더 얻는지 잰다(잉크 근거는 도면이 없어 생략).
 * 기준선 장면은 이미 옛 bridgeGaps 를 거쳤으므로, 여기서 늘어나는 것은 새 규칙의 몫이다.
 *
 *   npx tsx server/v4/tools/bridgeab.ts <접두> <이름...>
 */
import fs from "node:fs/promises";
import { bridgeGaps } from "../bridgeGaps.js";
import { pathDeviation } from "../refit.js";
import type { ScenePrimitive } from "../types.js";

const [prefix, ...names] = process.argv.slice(2);
const anchors = (prims: ScenePrimitive[]) =>
  prims.reduce((a, p) => a + (((p as { d?: string }).d ?? "").match(/[MLC]/g) ?? []).length, 0);

let tA = 0, tB = 0;
for (const name of names) {
  const raw = await fs.readFile(`outputs/v4/v4_${prefix}_${name}/scene.json`, "utf8");
  const sc = JSON.parse(raw) as { primitives: ScenePrimitive[] };
  // 재피팅 없이 이은 것(J) 과 재피팅까지 한 것(R) 을 따로 만들어, **재피팅만의** 이탈을 잰다.
  // 이은 패스를 원본과 비교하면 흡수한 획만큼 커져 이탈이 뜨는데 그건 기하 오차가 아니다.
  const scJ = JSON.parse(raw) as { primitives: ScenePrimitive[] };
  bridgeGaps(scJ.primitives, undefined, {});
  const joinedD = new Map<string, string>();
  for (const p of scJ.primitives) if ((p as { d?: string }).d) joinedD.set((p as { id: string }).id, (p as { d: string }).d);
  const a0 = anchors(sc.primitives), n0 = sc.primitives.length;
  const rep = bridgeGaps(sc.primitives, undefined, { refitTol: Number(process.env.AB_REFIT ?? 1.3) });
  const a1 = anchors(sc.primitives), n1 = sc.primitives.length;
  // 재피팅이 바꾼 패스의 형상 이탈(양방향) — 게이트 창 2px 안이어야 공짜 절감이다
  let devMax = 0, devOver = 0, changed = 0;
  for (const p of sc.primitives) {
    const id = (p as { id: string }).id, d = (p as { d?: string }).d;
    const jd = joinedD.get(id);
    if (!d || !jd || jd === d) continue;
    changed++;
    const dev = pathDeviation(jd, d, 0.5);
    if (Number.isFinite(dev)) { if (dev > devMax) devMax = dev; if (dev > 2) devOver++; }
  }
  tA += a0; tB += a1;
  console.log(
    `${name.padEnd(10)} 앵커 ${a0} → ${a1} (${(((a1 - a0) / a0) * 100).toFixed(1)}%) · 프리미티브 ${n0} → ${n1}` +
    ` · 이음 ${rep.joined} (코너 ${rep.corner} · 관통 ${rep.through}) · 닫음 ${rep.closed} · 재피팅 −${rep.refitSaved}` +
    ` · 재피팅 패스 ${changed} 최대 이탈 ${devMax.toFixed(2)}px (2px 초과 ${devOver})`,
  );
}
console.log(`합계 앵커 ${tA} → ${tB} (${(((tB - tA) / tA) * 100).toFixed(2)}%)`);
