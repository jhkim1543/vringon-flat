/**
 * V3(VRINGON 플랫스케치 기반 라인 벡터) 데모 자산 생성 — `outputs/v3/`의 실제 결과를
 * `docs/samples-v3/`로 굽는다.
 *
 * V3 데모의 요점은 **세 장을 나란히 보여주는 것**이다: 사진 → VRINGON 도면 → 라인 벡터.
 * 도면이 중간 산출물이 아니라 "왜 벡터가 깨끗한가"의 근거이므로 반드시 함께 싣는다.
 *
 * 실행: npx tsx server/export-demo-v3.ts
 */
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { config } from "./config.js";

const DOCS = path.join(config.root, "docs");
const OUT = path.join(DOCS, "samples-v3");
const V3 = path.join(config.outputsDir, "v3");

const CATEGORY_LABEL: Record<string, string> = { shoe: "신발", bag: "가방", jewelry: "주얼리" };

/** `<g id="layer-xxx">…</g>` 하나를 독립 SVG로 떼어낸다 */
function layerSvg(svg: string, header: string, id: string): string | null {
  const open = `<g id="layer-${id}"`;
  const at = svg.indexOf(open);
  if (at < 0) return null;
  // 레이어 g는 중첩되지 않으므로 다음 </g>까지가 본문이다
  const end = svg.indexOf("</g>", at);
  if (end < 0) return null;
  return `${header}\n${svg.slice(at, end + 4)}\n</svg>\n`;
}

interface V3Layer {
  id: string;
  label: string;
  z: number;
  kind: string;
  confidence: number;
  occludedBy: string[];
  regions: number;
  strokes: number;
  nodes: number;
  file?: string;
}

interface V3Sample {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  state: string;
  width: number;
  height: number;
  objectNoun: string;
  view: string;
  /** 벡터가 사는 좌표계 (도면 해상도 × supersample) */
  vectorCanvas: { width: number; height: number } | null;
  schematic: { backend: string; prompt: string; seed: number | null; scope: string; upscaled: boolean };
  layers: V3Layer[];
  /** QA 리포트 전문 — 지표가 늘어나므로 형태를 고정하지 않는다 */
  qa: Record<string, any>;
  timings: Record<string, number>;
  files: Record<string, string>;
  /** 같은 샘플의 컬러 결과 (있으면) */
  color?: { svg: string; schematic: string; paths: number; kb: number };
}

async function webImage(src: string, dest: string, max = 900) {
  await sharp(src)
    .flatten({ background: "#ffffff" })
    .resize(max, max, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 84 })
    .toFile(dest);
}

/** 컬러 잡은 `.mono.png`가 아닌 최종 도면을 고른다 */
async function pickSchematic(dir: string): Promise<string | null> {
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".png") && !f.includes(".mono."));
    return files.length ? path.join(dir, files[0]) : null;
  } catch { return null; }
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const dirs = (await fs.readdir(V3, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name.startsWith("v3_"))
    .map((d) => d.name)
    .sort();

  const SUFFIX = "_v31";
  const monoDirs = dirs.filter((d) => d.endsWith(SUFFIX));
  const colorDirs = new Map(
    dirs.filter((d) => d.endsWith("_color")).map((d) => [d.slice(3, -"_color".length), d]),
  );

  const samples: V3Sample[] = [];
  for (const dir of monoDirs) {
    const src = path.join(V3, dir);
    const name = dir.slice(3, -SUFFIX.length);
    let report: Record<string, any>;
    try {
      report = JSON.parse(await fs.readFile(path.join(src, "qa_report.json"), "utf8"));
    } catch {
      console.log(`  건너뜀 ${name}: qa_report 없음`);
      continue;
    }

    const dest = path.join(OUT, name);
    await fs.mkdir(path.join(dest, "layers"), { recursive: true });

    for (const f of ["layered.svg", "qa_report.json", "part_plan.json"]) {
      try { await fs.copyFile(path.join(src, f), path.join(dest, f)); } catch { /* 선택 */ }
    }

    // 사진 · 도면 — 데모의 본체
    const canonical = path.join(src, "canonical_input.png");
    const meta = await sharp(canonical).metadata();
    await webImage(canonical, path.join(dest, "input.jpg"));
    const sk = await pickSchematic(path.join(src, "schematics"));
    if (sk) await webImage(sk, path.join(dest, "schematic.jpg"));

    // 레이어별 SVG — 파트가 실제로 분리돼 있음을 증명한다
    const svg = await fs.readFile(path.join(src, "layered.svg"), "utf8");
    const header = svg.slice(0, svg.indexOf(">", svg.indexOf("<svg")) + 1)
      .replace(/^[\s\S]*?<svg/, '<?xml version="1.0" encoding="UTF-8"?>\n<svg');

    const plan = report.plan ?? {};
    const planParts: Record<string, any>[] = plan.parts ?? [];
    const layers: V3Layer[] = [];
    for (const L of (report.layers ?? []) as Record<string, any>[]) {
      const p = planParts.find((x) => x.id === L.partId) ?? {};
      const one = layerSvg(svg, header, L.partId);
      let file: string | undefined;
      if (one && (L.regions || L.strokes)) {
        await fs.writeFile(path.join(dest, "layers", `${L.partId}.svg`), one, "utf8");
        file = `samples-v3/${name}/layers/${L.partId}.svg`;
      }
      layers.push({
        id: L.partId,
        label: L.label ?? L.partId,
        z: L.z,
        kind: p.kind ?? "component",
        confidence: p.confidence ?? 0,
        occludedBy: p.occludedBy ?? [],
        regions: L.regions ?? 0,
        strokes: L.strokes ?? 0,
        nodes: L.nodes ?? 0,
        file,
      });
    }
    layers.sort((a, b) => a.z - b.z);

    const first = (report.layers ?? [])[0]?.schematic ?? {};
    const category = name.replace(/_\d+$/, "");
    const files: Record<string, string> = {
      svg: `samples-v3/${name}/layered.svg`,
      qa: `samples-v3/${name}/qa_report.json`,
      plan: `samples-v3/${name}/part_plan.json`,
      input: `samples-v3/${name}/input.jpg`,
    };
    if (sk) files.schematic = `samples-v3/${name}/schematic.jpg`;

    // 컬러 변형 — 같은 사진의 컬러 플랫
    let color: V3Sample["color"];
    const cdir = colorDirs.get(name);
    if (cdir) {
      const csrc = path.join(V3, cdir);
      try {
        const crep = JSON.parse(await fs.readFile(path.join(csrc, "qa_report.json"), "utf8"));
        await fs.copyFile(path.join(csrc, "layered.svg"), path.join(dest, "layered_color.svg"));
        const csk = await pickSchematic(path.join(csrc, "schematics"));
        if (csk) await webImage(csk, path.join(dest, "schematic_color.jpg"));
        color = {
          svg: `samples-v3/${name}/layered_color.svg`,
          schematic: `samples-v3/${name}/schematic_color.jpg`,
          paths: crep.qa.totalPaths,
          kb: crep.qa.fileKb,
        };
      } catch { /* 컬러 없음 */ }
    }

    samples.push({
      id: name,
      name,
      category,
      categoryLabel: CATEGORY_LABEL[category] ?? category,
      state: report.job.state,
      width: meta.width!,
      height: meta.height!,
      objectNoun: plan.objectNoun ?? "",
      view: plan.view ?? "",
      vectorCanvas: report.job?.vectorCanvas ?? null,
      schematic: {
        backend: first.backend ?? "unknown",
        prompt: first.prompt ?? "",
        seed: first.seed ?? null,
        scope: report.options?.schematicScope ?? "whole",
        upscaled: !!report.options?.upscale,
      },
      layers,
      qa: report.qa,
      timings: report.timings ?? {},
      files,
      color,
    });
    console.log(
      `  ${name.padEnd(11)} 레이어 ${layers.length} · path ${report.qa.totalPaths} ` +
      `· 선F@2px ${report.qa.lineF2 ?? report.qa.rawF2} · 디테일 ${report.qa.detailRecall}` +
      `${report.qa.pass ? "" : " · REVIEW"}${color ? " · 컬러 O" : ""}`,
    );
  }

  await fs.writeFile(
    path.join(OUT, "index.json"),
    JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), samples }, null, 2),
    "utf8",
  );

  let bytes = 0;
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else bytes += (await fs.stat(p)).size;
    }
  };
  await walk(OUT);
  console.log(`\nV3 데모 자산 ${samples.length}종 → ${OUT}`);
  console.log(`총 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
