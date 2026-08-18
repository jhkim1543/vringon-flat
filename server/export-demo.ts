/**
 * GitHub Pages 데모 자산 생성 — `outputs/`의 실제 결과를 `docs/samples/`로 굽는다.
 *
 * 데모는 정적 페이지라 서버가 없다. 그래서 이 스크립트가 결과물(SVG/.ai/IR)과
 * 지표를 미리 계산해 JSON 하나로 만들어 둔다. 원본 사진·플랫은 웹용으로 줄인다
 * (원본 2MB PNG를 그대로 올리면 저장소가 수백 MB가 된다).
 *
 * 실행: npx tsx server/export-demo.ts
 */
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { config } from "./config.js";
import type { VectorIR } from "./types.js";

const DOCS = path.join(config.root, "docs");
const OUT = path.join(DOCS, "samples");
const SAMPLES = path.join(config.outputsDir, "_samples");

const CATEGORY_LABEL: Record<string, string> = {
  shoe: "신발", bag: "가방", jewelry: "주얼리",
};

interface SampleMeta {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  jobId: string;
  source?: { title: string; url: string };
  width: number;
  height: number;
  instances: number;
  layers: { name: string; group: string; color: string; paths: number; anchors: number; kind: string }[];
  stats: { groups: number; paths: number; anchors: number; unnamed: number; lineGroups: number };
  qa?: { coverage: number; spill: number; colorDeltaE: number; pass: boolean };
  files: { svg: string; ai: string; jsx: string; ir: string; input: string; flat: string };
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  // 샘플 목록·출처
  const jobsTxt = await fs.readFile(path.join(SAMPLES, "JOBS.txt"), "utf8");
  const sources = new Map<string, { title: string; url: string }>();
  try {
    const src = await fs.readFile(path.join(SAMPLES, "SOURCES.txt"), "utf8");
    for (const line of src.split(/\r?\n/)) {
      const [file, title, url] = line.split("\t");
      if (file && url) sources.set(file.replace(/\.png$/, ""), { title, url });
    }
  } catch { /* 출처 파일이 없어도 진행 */ }

  const metas: SampleMeta[] = [];
  for (const line of jobsTxt.split(/\r?\n/)) {
    const [name, jobId] = line.trim().split(/\s+/);
    if (!name || !jobId) continue;
    const jobDir = path.join(config.outputsDir, jobId);
    const base = `flat_${jobId.slice(0, 8)}`;
    const irPath = path.join(jobDir, `${base}.ir.json`);
    let ir: VectorIR;
    try {
      ir = JSON.parse(await fs.readFile(irPath, "utf8"));
    } catch {
      console.log(`  건너뜀 ${name}: IR 없음`);
      continue;
    }

    const dir = path.join(OUT, name);
    await fs.mkdir(dir, { recursive: true });

    // 벡터 산출물은 그대로 복사 (이게 데모의 본체다)
    for (const [kind, ext] of [["svg", ".svg"], ["ai", ".ai"], ["jsx", ".jsx"], ["ir", ".ir.json"]] as const) {
      await fs.copyFile(path.join(jobDir, `${base}${ext}`), path.join(dir, `result${ext}`));
      void kind;
    }

    // 원본 사진 — 웹용 축소 (긴 변 900px, JPEG 82)
    await sharp(path.join(jobDir, "input.png"))
      .flatten({ background: "#ffffff" })
      .resize(900, 900, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(path.join(dir, "input.jpg"));

    // 플랫 스케치 — 인스턴스가 여럿이면 darken 합성해 한 장으로
    const instDirs = (await fs.readdir(jobDir)).filter((f) => /^inst_\d+$/.test(f)).sort();
    const flatPaths = instDirs.length
      ? instDirs.map((d) => path.join(jobDir, d, "layers", "_aligned_flat.png"))
      : [path.join(jobDir, "layers", "_aligned_flat.png")];
    const first = await sharp(flatPaths[0]).metadata();
    const W = first.width!, H = first.height!;
    const comps = [];
    for (const fp of flatPaths)
      comps.push({
        input: await sharp(fp).flatten({ background: "#fff" }).resize(W, H, { fit: "fill" }).png().toBuffer(),
        blend: "darken" as const,
      });
    // 합성과 축소를 한 파이프라인에 두면 sharp가 축소를 먼저 적용해 크기가 어긋난다.
    // 합성 결과를 버퍼로 확정한 뒤 다시 열어 축소한다.
    const merged = await sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } })
      .composite(comps)
      .png()
      .toBuffer();
    await sharp(merged)
      .resize(900, 900, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toFile(path.join(dir, "flat.jpg"));

    // 레이어 표 — IR 그룹 단위
    const layers: SampleMeta["layers"] = [];
    let paths = 0, anchors = 0, unnamed = 0, lineGroups = 0;
    for (const L of ir.layers) {
      for (const g of L.groups) {
        const a = g.paths.reduce((n, p) => n + (p.d.match(/[LC]/g) ?? []).length, 0);
        const p0 = g.paths[0];
        const isLine = !!p0 && !p0.fill;
        layers.push({
          name: g.name,
          group: L.name,
          color: p0?.fill ?? p0?.stroke ?? "#000000",
          paths: g.paths.length,
          anchors: a,
          kind: isLine ? "stroke" : "fill",
        });
        paths += g.paths.length;
        anchors += a;
        if (/^(Region|Detail)\b/.test(g.name)) unnamed++;
        if (isLine) lineGroups++;
      }
    }

    // QA 지표 — 리포트 캐시가 있으면 쓰고, 없으면 생략
    let qa: SampleMeta["qa"];
    try {
      qa = JSON.parse(await fs.readFile(path.join(jobDir, "qa.json"), "utf8"));
    } catch { /* 선택 항목 */ }

    const category = name.replace(/_\d+$/, "");
    metas.push({
      id: name,
      name,
      category,
      categoryLabel: CATEGORY_LABEL[category] ?? category,
      jobId,
      source: sources.get(name),
      width: ir.width,
      height: ir.height,
      instances: instDirs.length || 1,
      layers,
      stats: { groups: layers.length, paths, anchors, unnamed, lineGroups },
      qa,
      files: {
        svg: `samples/${name}/result.svg`,
        ai: `samples/${name}/result.ai`,
        jsx: `samples/${name}/result.jsx`,
        ir: `samples/${name}/result.ir.json`,
        input: `samples/${name}/input.jpg`,
        flat: `samples/${name}/flat.jpg`,
      },
    });
    console.log(`  ${name.padEnd(12)} 그룹 ${String(layers.length).padStart(3)} · 패스 ${String(paths).padStart(5)} · 앵커 ${String(anchors).padStart(5)}`);
  }

  await fs.writeFile(
    path.join(OUT, "index.json"),
    JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), samples: metas }, null, 2),
    "utf8",
  );

  // 총 용량 보고 — GitHub Pages에 올릴 것이므로 감시한다
  let bytes = 0;
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else bytes += (await fs.stat(p)).size;
    }
  };
  await walk(OUT);
  console.log(`\n데모 자산 ${metas.length}종 → ${OUT}`);
  console.log(`총 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
