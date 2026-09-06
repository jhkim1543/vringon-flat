/**
 * **전체 회고 감사** — 지금까지 지적된 것이 실제로 고쳐졌는지 산출물에서 다시 잰다.
 *
 * 문서에 "고쳤다"고 적힌 것을 믿지 않는다. 항목마다 **측정 방법**을 함께 찍어서,
 * 읽는 쪽이 숫자의 근거를 알 수 있게 한다.
 *
 *   npx tsx server/v4/__audit.ts <잡이름...>
 */
import fs from "node:fs/promises";
import { parsePath } from "../../vector/pathdata.js";
import { readAiAnchors } from "../ai-anchor-render.js";
import { isInkPrimitive, lumaOf } from "../export.js";
import type { VectorScene, StrokePrimitive } from "../types.js";

interface Row { k: string; how: string; v: string; ok: boolean | null }

async function auditOne(name: string): Promise<Row[]> {
  const dir = `outputs/v4/v4_${name}`;
  const sc = JSON.parse(await fs.readFile(`${dir}/scene.json`, "utf8")) as VectorScene;
  const qa = JSON.parse(await fs.readFile(`${dir}/qa_v4.json`, "utf8")).qa;
  const out: Row[] = [];

  // ① 검게 채운 면이 살아 있나 — 짙은 fill 프리미티브의 존재
  const darkFills = sc.primitives.filter(
    (p) => (p.cls === "FACE_FILL" || p.cls === "TEXTURE_TONE")
      && lumaOf((p as { fill?: string }).fill) < 160).length;
  const paleFills = sc.primitives.filter(
    (p) => p.cls === "FACE_FILL" && lumaOf((p as { fill?: string }).fill) >= 160).length;
  out.push({
    k: "검게 채운 면", how: "FACE_FILL 중 밝기<160 인 것",
    v: `짙은 ${darkFills} · 옅은 ${paleFills}`, ok: null,
  });

  // ② 라이브 스트로크인가 — 잉크를 스트로크로 내는가 면 윤곽으로 내는가
  const ink = sc.primitives.filter(isInkPrimitive);
  const strokes = ink.filter((p) => p.cls === "STRUCTURAL_STROKE" || p.cls === "DASH_OR_STITCH").length;
  const outlines = ink.filter((p) => p.cls === "OUTLINE_SHAPE").length;
  out.push({
    k: "라이브 스트로크", how: "잉크 프리미티브 중 stroke 비율",
    v: `스트로크 ${strokes} · 면윤곽 ${outlines} (${ink.length ? ((strokes / ink.length) * 100).toFixed(0) : 0}%)`,
    ok: strokes > outlines,
  });

  // ③ 선 굵기 위계 — 고유 굵기 값의 개수
  const ws = new Set<number>();
  for (const p of sc.primitives) {
    const w = (p as StrokePrimitive).width;
    if (typeof w === "number" && w > 0) ws.add(+w.toFixed(2));
  }
  out.push({
    k: "선 굵기 등급", how: "고유 stroke-width 개수",
    v: ws.size ? `${ws.size}개 (${[...ws].sort((a, b) => a - b).map((v) => v.toFixed(1)).join(", ")})` : "스트로크 없음",
    ok: ws.size === 0 ? null : ws.size >= 2 && ws.size <= 6,
  });

  // ④ 끊긴 획 — 획 시작(M) 이 앵커에서 차지하는 몫
  let M = 0, C = 0;
  for (const p of sc.primitives) {
    const d = (p as { d?: string }).d;
    if (!d) continue;
    M += (d.match(/M/g) ?? []).length;
    C += (d.match(/C/g) ?? []).length;
  }
  out.push({
    k: "획 끊김", how: "M(획 시작) / 전체 앵커",
    v: `M ${M} · C ${C} → 끝점이 앵커의 ${M + C ? ((M * 2 / (M + C)) * 100).toFixed(0) : 0}%`,
    ok: M + C > 0 ? (M * 2) / (M + C) < 0.5 : null,
  });

  // ⑤ bbox 가 캔버스 전체로 떨어지지 않았나 — 옛 정규식 결함의 지문
  const full = sc.primitives.filter((p) => {
    const b = p.bbox;
    return b && b[0] <= 0 && b[1] <= 0 && b[2] >= sc.canvas.width - 1 && b[3] >= sc.canvas.height - 1;
  }).length;
  out.push({
    k: "bbox 정상", how: "캔버스 전체와 같은 bbox 개수 (0 이어야)",
    v: `${full}개`, ok: full === 0,
  });

  // ⑥ 퇴화 조각 — 한 점 안에 들어오는 큐빅
  let degen = 0;
  for (const p of sc.primitives) {
    const d = (p as { d?: string }).d;
    if (!d) continue;
    for (const sp of parsePath(d)) {
      let cur = sp.start;
      for (const s of sp.segs) {
        const xs = [cur[0], s.c1?.[0] ?? cur[0], s.c2?.[0] ?? s.end[0], s.end[0]];
        const ys = [cur[1], s.c1?.[1] ?? cur[1], s.c2?.[1] ?? s.end[1], s.end[1]];
        if (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < 0.05) degen++;
        cur = s.end;
      }
    }
  }
  out.push({ k: "퇴화 조각", how: "한 점 안에 들어오는 큐빅", v: `${degen}개`, ok: degen <= 2 });

  // ⑦ 재현성 기록
  const run = (sc.provenance as { run?: Record<string, unknown> }).run;
  out.push({
    k: "재현성 기록", how: "provenance.run 존재",
    v: run ? `코드 ${String(run.codeVersion)} · 입력해시 ${String(run.inputSha256 ?? "-").slice(0, 12)}…` : "없음",
    ok: !!run,
  });

  // ⑧ .ai 실앵커 + 예산
  try {
    const a = await readAiAnchors(`${dir}/layered.ai`);
    out.push({
      k: ".ai 실앵커", how: "PDF 내용 스트림에서 직접",
      v: `${a.dots.length.toLocaleString()} (QA 값 ${qa.editability.anchors.toLocaleString()})`,
      ok: a.dots.length <= 20000,
    });
  } catch {
    out.push({ k: ".ai 실앵커", how: "PDF 내용 스트림", v: ".ai 없음", ok: false });
  }

  // ⑨ 게이트
  out.push({
    k: "3게이트", how: "qa_v4.json",
    v: (["fidelity", "editability", "semantic"] as const).map((k) => (qa[k]?.pass ? "O" : "X")).join(""),
    ok: !(["fidelity", "editability", "semantic"] as const).some((k) => !qa[k]?.pass),
  });

  return out;
}

for (const name of process.argv.slice(2)) {
  console.log(`\n=== ${name} ===`);
  try {
    for (const r of await auditOne(name)) {
      const mark = r.ok === null ? " " : r.ok ? "O" : "X";
      console.log(`  [${mark}] ${r.k.padEnd(14)} ${r.v}`);
      console.log(`      ↳ ${r.how}`);
    }
  } catch (e) {
    console.log(`  ! ${(e as Error).message.slice(0, 80)}`);
  }
}
