/**
 * 솎기 허용오차 스윕 — "곡률이 요구하지 않는 중간 앵커"가 얼마나 남았는지.
 *
 * 재생성 없이 scene 의 최종 d 에 thinAnchors 를 더 세게 재적용해 보고,
 * 앵커 감소율과 **형상 이탈**(pathDeviation, 양방향)을 함께 잰다.
 * 이탈이 게이트 여유(작업 2px = 원본 1px) 안이면 그 허용오차는 공짜 절감이다.
 */
import fs from "node:fs/promises";
import { thinAnchors, pathDeviation } from "../refit.js";
import type { VectorScene } from "../types.js";

const TOLS = [0.6, 1.0, 1.5, 2.0];
for (const name of process.argv.slice(2)) {
  const sc = JSON.parse(await fs.readFile(`outputs/v4/v4_${name}/scene.json`, "utf8")) as VectorScene;
  const ds: string[] = [];
  for (const p of sc.primitives) {
    const d = (p as { d?: string }).d;
    if (d && d.length > 30) ds.push(d);
  }
  const base = ds.reduce((a, d) => a + (d.match(/[MLC]/g) ?? []).length, 0);
  console.log(`\n${name} — 패스 ${ds.length} · 현재 앵커 ${base.toLocaleString()}`);
  for (const T of TOLS) {
    let after = 0, devMax = 0, devHit = 0;
    for (const d of ds) {
      const nd = thinAnchors(d, T);
      after += (nd.match(/[MLC]/g) ?? []).length;
      const dev = pathDeviation(d, nd, 1.5);
      if (Number.isFinite(dev)) { if (dev > devMax) devMax = dev; if (dev > 2) devHit++; }
    }
    console.log(`  tol ${T.toFixed(1)}  앵커 ${after.toLocaleString()} (${((1 - after / base) * 100).toFixed(1)}% 감소) · 최대 이탈 ${devMax.toFixed(2)}px · 2px 초과 패스 ${devHit}`);
  }
}
