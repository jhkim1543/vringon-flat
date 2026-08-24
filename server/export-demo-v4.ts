/**
 * V4 데모 자산 — `outputs/v4/` → `docs/samples-v4/`.
 *
 * V4의 요점은 **하나의 장면에서 목적별로 다른 SVG가 나온다**는 것이므로, 세 가지를 모두
 * 싣고 화면에서 바꿔 볼 수 있게 한다. 그리고 왜 그 표현이 선택됐는지(라우팅 근거)도 함께.
 *
 * 실행: npx tsx server/export-demo-v4.ts
 */
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { config } from "./config.js";

const DOCS = path.join(config.root, "docs");
const OUT = path.join(DOCS, "samples-v4");
const V4 = path.join(config.outputsDir, "v4");
const V3 = path.join(config.outputsDir, "v3");
const LABEL: Record<string, string> = { shoe: "신발", bag: "가방", jewelry: "주얼리" };

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const jobs = Object.fromEntries(
    (await fs.readFile(path.join(config.outputsDir, "_samples", "JOBS.txt"), "utf8"))
      .trim().split("\n").map((l) => l.split(" ")),
  );

  const dirs = (await fs.readdir(V4, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name.startsWith("v4_")).map((d) => d.name).sort();

  const samples: Record<string, unknown>[] = [];
  for (const dir of dirs) {
    const src = path.join(V4, dir);
    const name = dir.slice(3);
    let rep: Record<string, any>;
    try { rep = JSON.parse(await fs.readFile(path.join(src, "qa_v4.json"), "utf8")); }
    catch { console.log(`  건너뜀 ${name}`); continue; }

    const dest = path.join(OUT, name);
    await fs.mkdir(dest, { recursive: true });
    for (const f of ["fidelity.svg", "editable.svg", "production.svg", "qa_v4.json",
      "layered.ai", "native-layers.jsx"]) {
      await fs.copyFile(path.join(src, f), path.join(dest, f));
    }
    // scene.json 은 라우팅 근거가 들어 있어 크다 — 요약만 싣는다
    const scene = JSON.parse(await fs.readFile(path.join(src, "scene.json"), "utf8"));
    const routes = (scene.primitives as Record<string, any>[]).slice(0, 400).map((p) => ({
      id: p.id, cls: p.cls, partId: p.partId ?? null, area: p.area,
      why: p.route?.why ?? "", confidence: p.route?.confidence ?? 0,
      kind: p.kind ?? null, instances: p.instances?.length ?? null,
    }));
    await fs.writeFile(path.join(dest, "routes.json"), JSON.stringify(routes, null, 1), "utf8");

    // 사진 · 도면
    await sharp(path.join(src, "canonical_input.png")).flatten({ background: "#ffffff" })
      .resize(900, 900, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 84 })
      .toFile(path.join(dest, "input.jpg"));
    const skDir = path.join(V3, `v3_${name}_v31`, "schematics");
    try {
      const sk = (await fs.readdir(skDir)).filter((f) => f.endsWith(".png") && !f.includes(".mono."))[0];
      await sharp(path.join(skDir, sk)).flatten({ background: "#ffffff" })
        .resize(900, 900, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 84 })
        .toFile(path.join(dest, "schematic.jpg"));
    } catch { /* 도면 없으면 생략 */ }

    // 같은 샘플의 V3.2 결과 — 비교용
    let v3: Record<string, unknown> | null = null;
    try {
      const q = JSON.parse(await fs.readFile(path.join(V3, `v3_${name}_v31`, "qa_report.json"), "utf8")).qa;
      await fs.copyFile(path.join(V3, `v3_${name}_v31`, "layered.svg"), path.join(dest, "v3.svg"));
      v3 = { paths: q.totalPaths, anchors: q.totalNodes, f0: q.rawF0, lineF2: q.lineF2 ?? q.rawF2, kb: q.fileKb, svg: `samples-v4/${name}/v3.svg` };
    } catch { /* V3 없음 */ }

    const category = name.replace(/_\d+$/, "");
    samples.push({
      id: name, name, category, categoryLabel: LABEL[category] ?? category,
      state: rep.job.state, canvas: rep.job.canvas,
      counts: rep.counts, qa: rep.qa, timings: rep.timings,
      correspondence: rep.correspondence,
      parts: (scene.parts ?? []).map((p: Record<string, unknown>) => ({ id: p.id, label: p.label, z: p.z })),
      sharedBoundaries: (scene.sharedBoundaries ?? []).length,
      v3,
      files: {
        fidelity: `samples-v4/${name}/fidelity.svg`,
        editable: `samples-v4/${name}/editable.svg`,
        production: `samples-v4/${name}/production.svg`,
        ai: `samples-v4/${name}/layered.ai`,
        jsx: `samples-v4/${name}/native-layers.jsx`,
        routes: `samples-v4/${name}/routes.json`,
        qa: `samples-v4/${name}/qa_v4.json`,
        input: `samples-v4/${name}/input.jpg`,
        schematic: `samples-v4/${name}/schematic.jpg`,
      },
    });
    console.log(
      `  ${name.padEnd(11)} 패스 ${String(rep.qa.editability.paths).padStart(5)} · ` +
      `선F@2 ${rep.qa.fidelity.lineF2} · prim ${rep.qa.editability.primitives} · ` +
      `pat ${rep.qa.editability.pathsSavedByPatterns} · ${rep.job.state}`,
    );
  }

  await fs.writeFile(path.join(OUT, "index.json"),
    JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), samples }, null, 2), "utf8");

  let bytes = 0;
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else bytes += (await fs.stat(p)).size;
    }
  };
  await walk(OUT);
  console.log(`\nV4 데모 자산 ${samples.length}종 → ${OUT}`);
  console.log(`총 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
