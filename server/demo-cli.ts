/**
 * 데모 CLI — demo.rebuilderai.com/flat 의 백엔드(FastAPI)가 자식 프로세스로 부르는 진입점.
 *
 *   tsx server/demo-cli.ts run <이미지> <출력폴더> [--category shoe|bag|jewelry] [--lineart] [--schematic-from p]
 *   tsx server/demo-cli.ts export <출력폴더> <편집.json> <프리셋|all> <출력.ai|출력폴더>
 *
 * `run` 은 최종 확정 구성(v7.0: 얇은 마감 · 사다리 폭 · 허용오차 1.3 · 끝점 잇기)으로 돌고,
 * 진행은 **stdout 에 JSON 한 줄씩** 흘린다 — 백엔드가 그대로 폴링 화면에 넘긴다.
 * 끝나면 출력폴더에 demo.json(요약)을 남긴다.
 *
 * `export` 는 브라우저 편집기가 보낸 앵커 편집(패스별 d 덮어쓰기 · 삭제 · 굵기)을 scene.json 에
 * 적용해 .ai 를 다시 굽는다. 장면의 나머지(레이어·파트·패턴)는 그대로다.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { runV4, DEFAULT_V4_OPTIONS, type V4Options } from "./v4/run4.js";
import { exportAi, type LayerPreset } from "./v4/aiExport.js";
import { activeBackend } from "./v3/schematicClient.js";
import type { VectorScene, ScenePrimitive } from "./v4/types.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
const pos = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !arr[i - 1]?.startsWith("--"));
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n: string) => argv.includes(`--${n}`);

const emit = (o: Record<string, unknown>) => {
  process.stdout.write(JSON.stringify({ t: Date.now(), ...o }) + "\n");
};

async function cmdRun() {
  const [input, outDir] = pos;
  if (!input || !outDir) throw new Error("usage: run <image> <outDir> [--category c] [--lineart]");
  const backend = activeBackend();
  if (!flag("schematic-from") && !backend) {
    emit({ stage: "FAILED", msg: "도면 생성 백엔드가 없습니다 (REPLICATE_API_TOKEN 또는 VRINGON_SCHEMATIC_URL)" });
    process.exit(2);
  }
  const opts: V4Options = {
    ...DEFAULT_V4_OPTIONS,
    categoryHint: flag("category"),
    grayscale: true,
    schematicFrom: flag("schematic-from"),
    upscale: !has("no-upscale"),
    strokeLines: true,
    widthGrades: 4,
    thinFinish: true,
    lineartSchematic: has("lineart"),
  };
  emit({ stage: "START", msg: `도면 백엔드 ${backend ?? "재사용"} · 얇은 마감 v7`, backend });
  const t0 = Date.now();
  const r = await runV4(input, outDir, opts, (s, m) => emit({ stage: s, msg: m }));
  const qa = r.qa;
  const summary = {
    ok: true,
    ms: Date.now() - t0,
    state: r.state,
    category: r.plan.category,
    parts: r.plan.parts.map((p) => ({ id: p.id, label: p.label })),
    counts: r.counts,
    codeVersion: (r.scene.provenance as { run?: { codeVersion?: string } })?.run?.codeVersion ?? null,
    canvas: r.scene.canvas,
    qa: {
      fidelity: { pass: qa.fidelity.pass, lineF2: qa.fidelity.lineF2, shippedLineF2: qa.fidelity.shippedLineF2 ?? null, notes: qa.fidelity.notes },
      editability: { pass: qa.editability.pass, anchors: qa.editability.anchors, paths: qa.editability.paths, kb: qa.editability.kb, notes: qa.editability.notes },
      semantic: { pass: qa.semantic.pass, notes: qa.semantic.notes },
    },
    files: {
      preview: "preview.png", production: "production.svg", editable: "editable.svg", scene: "scene.json",
      ai: "layered.ai", aiByPart: "layered-bypart.ai", aiByColor: "layered-bycolor.ai", input: "canonical_input.png", schematic: "schematic.png",
    },
    timings: r.timings,
  };
  // 편집기 밑그림용 도면 한 장 — 재합성본 > 재사용본 > 생성본 순
  try {
    const sk = path.join(outDir, "schematics");
    const names = await fs.readdir(sk);
    const pick = names.includes("lineart_recomposed.png") ? "lineart_recomposed.png"
      : names.includes("reuse.png") ? "reuse.png"
      : names.filter((n) => /^schematic_.*\.png$/.test(n) && !n.endsWith(".mono.png")).sort().pop();
    if (pick) await fs.copyFile(path.join(sk, pick), path.join(outDir, "schematic.png"));
  } catch { /* 도면이 없으면 밑그림도 없다 */ }
  await fs.writeFile(path.join(outDir, "demo.json"), JSON.stringify(summary, null, 1));
  emit({ stage: "DONE", msg: `앵커 ${qa.editability.anchors} · 패스 ${qa.editability.paths} · 선 F@2 ${qa.fidelity.lineF2}`, summary });
}

interface Edits {
  /** 패스 id → 새 d */
  overrides?: Record<string, string>;
  /** 지운 패스 id */
  deleted?: string[];
  /** 패스 id → 선 굵기 */
  widths?: Record<string, number>;
}

function applyEdits(scene: VectorScene, edits: Edits): { applied: number; deleted: number } {
  const del = new Set(edits.deleted ?? []);
  let applied = 0;
  const kept: ScenePrimitive[] = [];
  for (const p of scene.primitives) {
    if (del.has(p.id)) continue;
    const nd = edits.overrides?.[p.id];
    if (nd && (p as { d?: string }).d !== undefined) { (p as { d: string }).d = nd; applied++; }
    const w = edits.widths?.[p.id];
    if (w !== undefined && (p as { width?: number }).width !== undefined && w > 0) { (p as { width: number }).width = w; applied++; }
    kept.push(p);
  }
  const deleted = scene.primitives.length - kept.length;
  scene.primitives = kept;
  // 공유 경계 목록도 지워진 프리미티브를 가리키면 안 된다
  scene.sharedBoundaries = scene.sharedBoundaries.filter((s) => !del.has(s.primitiveId));
  return { applied, deleted };
}

async function cmdExport() {
  const [outDir, editsPath, preset, target] = pos;
  if (!outDir || !editsPath || !preset || !target) throw new Error("usage: export <outDir> <edits.json> <preset|all> <out.ai|dir>");
  const scene = JSON.parse(await fs.readFile(path.join(outDir, "scene.json"), "utf8")) as VectorScene;
  const edits = JSON.parse(await fs.readFile(editsPath, "utf8")) as Edits;
  const r = applyEdits(scene, edits);
  const presets: LayerPreset[] = preset === "all" ? ["function", "part", "color"] : [preset as LayerPreset];
  const names: Record<LayerPreset, string> = { function: "layered.ai", part: "layered-bypart.ai", color: "layered-bycolor.ai" };
  const written: string[] = [];
  for (const p of presets) {
    const buf = exportAi(scene, p);
    const file = presets.length === 1 && !target.endsWith("/") && target.endsWith(".ai") ? target : path.join(target, names[p]);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, buf);
    written.push(file);
  }
  emit({ stage: "DONE", msg: `편집 반영 ${r.applied} · 삭제 ${r.deleted}`, written, primitives: scene.primitives.length });
}

try {
  if (cmd === "run") await cmdRun();
  else if (cmd === "export") await cmdExport();
  else { console.error("usage: demo-cli run|export …"); process.exit(1); }
} catch (e) {
  emit({ stage: "FAILED", msg: (e as Error).message?.slice(0, 500) ?? String(e) });
  process.exit(1);
}
