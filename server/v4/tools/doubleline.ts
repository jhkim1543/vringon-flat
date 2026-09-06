/**
 * **이중선 검사** — 자동 트레이스의 최대 지문.
 *
 * 도식화의 심 라인은 두께 0 의 위치 정보다. 굵기는 표기 규약일 뿐이다. 그런데 사진에서
 * 딴 outline trace 는 선의 **양쪽 경계**를 각각 패스로 만든다. 디자이너가 파일을 열자마자
 * 알아채는 것이 이것이고, 실무자 불신의 근원이다.
 *
 * 재는 법: 한 서브패스 위의 두 점이 **경로를 따라서는 멀리 떨어져 있는데 공간적으로는
 * 가까우면**, 그 패스는 자기 자신을 되짚어 온 것 — 즉 얇은 선의 양쪽 윤곽이다.
 */
import fs from "node:fs/promises";
import { parsePath, type Pt } from "../../vector/pathdata.js";
import type { VectorScene } from "../types.js";

/** 이 굵기 이하로 마주 보면 "선을 윤곽으로 그린 것"으로 본다 (작업 캔버스 px) */
const THIN = Number(process.env.V4_DL_THIN ?? 14);

function samples(sp: ReturnType<typeof parsePath>[number], step = 3): Pt[] {
  const out: Pt[] = [sp.start];
  let cur = sp.start;
  for (const seg of sp.segs) {
    if (seg.type === "L") { out.push(seg.end); cur = seg.end; continue; }
    const [x0, y0] = cur, [x1, y1] = seg.c1!, [x2, y2] = seg.c2!, [x3, y3] = seg.end;
    const rough = Math.hypot(x3 - x0, y3 - y0) + Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(2, Math.min(20, Math.ceil(rough / step)));
    for (let i = 1; i <= n; i++) {
      const t = i / n, m = 1 - t;
      out.push([
        m * m * m * x0 + 3 * m * m * t * x1 + 3 * m * t * t * x2 + t * t * t * x3,
        m * m * m * y0 + 3 * m * m * t * y1 + 3 * m * t * t * y2 + t * t * t * y3,
      ]);
    }
    cur = seg.end;
  }
  return out;
}

for (const name of process.argv.slice(2)) {
  let sc: VectorScene;
  try { sc = JSON.parse(await fs.readFile(`outputs/v4/v4_${name}/scene.json`, "utf8")) as VectorScene; }
  catch { console.log(`  ${name}: 없음`); continue; }

  let ribbonPts = 0, totalPts = 0, ribbonSub = 0, totalSub = 0;
  const widths: number[] = [];
  for (const p of sc.primitives) {
    const d = (p as { d?: string }).d;
    if (!d || p.cls === "FACE_FILL" || p.cls === "TEXTURE_TONE") continue;
    for (const sp of parsePath(d)) {
      if (!sp.closed) continue;
      const pts = samples(sp);
      if (pts.length < 12) continue;
      totalSub++;
      // 경로 길이를 따라 누적 거리
      const acc = [0];
      for (let i = 1; i < pts.length; i++) {
        acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      }
      const perim = acc[acc.length - 1];
      let hit = 0;
      for (let i = 0; i < pts.length; i++) {
        let best = Infinity;
        for (let j = 0; j < pts.length; j++) {
          // 경로상 거리 — 닫힌 곡선이므로 양쪽으로 잰다
          const along = Math.abs(acc[i] - acc[j]);
          const geo = Math.min(along, perim - along);
          if (geo < THIN * 2) continue;          // 경로상 이웃은 당연히 가깝다
          const dd = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
          if (dd < best) best = dd;
        }
        totalPts++;
        if (best <= THIN) { hit++; ribbonPts++; widths.push(best); }
      }
      if (hit > pts.length * 0.5) ribbonSub++;
    }
  }
  widths.sort((a, b) => a - b);
  const med = widths.length ? widths[Math.floor(widths.length / 2)] : 0;
  console.log(
    `${name.padEnd(16)} 닫힌 서브패스 ${String(totalSub).padStart(5)} · ` +
    `그중 절반 이상이 마주 보는 것 ${String(ribbonSub).padStart(5)} (${totalSub ? ((ribbonSub / totalSub) * 100).toFixed(0) : 0}%) · ` +
    `표본점 기준 ${totalPts ? ((ribbonPts / totalPts) * 100).toFixed(0) : 0}% · 마주 보는 간격 중앙 ${med.toFixed(1)}px`,
  );
}
