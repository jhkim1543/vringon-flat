/**
 * V2(레이어 분리 벡터 SVG) 데모 자산 생성 — `outputs/v2/`의 실제 결과를
 * `docs/samples-v2/`로 굽는다.
 *
 * 정적 페이지가 소비할 것만 고른다: 최종 SVG·매니페스트·QA 리포트·레이어별 SVG·
 * 웹용 축소 원본. 중간 후보(candidates/, work/)와 대용량 레이어 PNG는 제외한다
 * (저장소가 80MB로 불어난다).
 *
 * 실행: npx tsx server/export-demo-v2.ts
 */
import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { config } from "./config.js";
import type { LayerManifest } from "./v2/schema.js";

const DOCS = path.join(config.root, "docs");
const OUT = path.join(DOCS, "samples-v2");
const V2 = path.join(config.outputsDir, "v2");

const CATEGORY_LABEL: Record<string, string> = { shoe: "신발", bag: "가방", jewelry: "주얼리" };

interface V2Sample {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  state: string;
  width: number;
  height: number;
  /** manifest 레이어 (back→front) */
  layers: {
    id: string;
    label: string;
    role: string;
    material: string;
    profile: string;
    profileReason?: string;
    z: number;
    confidence: number;
    requiresReview: boolean;
    occludedBy: string[];
    paths: number;
  }[];
  qa: {
    pass: boolean;
    needsReview: boolean;
    foregroundIou: number;
    boundaryF: number;
    deltaE: number;
    ssim: number;
    integrity: number;
    invalidGeometry: number;
    strict: boolean;
    paths: number;
    nodes: number;
    kb: number;
    failures: { signal: string; layerId: string | null; detail: string; action: string }[];
    notes: string[];
  };
  provenance: Record<string, unknown>;
  retries: { round: number; layerIds: string[]; reason: string }[];
  stages: { id: string; ms: number; detail?: string }[];
  files: Record<string, string>;
  /** 같은 샘플의 V1 결과 (있으면 비교용) */
  v1?: { svg: string; groups: number };
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  // V1 잡 매핑
  const jobs = new Map<string, string>();
  try {
    const txt = await fs.readFile(path.join(config.outputsDir, "_samples", "JOBS.txt"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const [n, id] = line.trim().split(/\s+/);
      if (n && id) jobs.set(n, id);
    }
  } catch { /* V1 없이도 진행 */ }

  const dirs = (await fs.readdir(V2, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name.startsWith("v2_"))
    .map((d) => d.name)
    .sort();

  const samples: V2Sample[] = [];
  for (const dir of dirs) {
    const src = path.join(V2, dir);
    const name = dir.replace(/^v2_/, "");
    let manifest: LayerManifest, report: Record<string, unknown>;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(src, "layer_manifest.json"), "utf8"));
      report = JSON.parse(await fs.readFile(path.join(src, "qa_report.json"), "utf8"));
    } catch {
      console.log(`  건너뜀 ${name}: manifest/qa 없음`);
      continue;
    }

    const dest = path.join(OUT, name);
    await fs.mkdir(path.join(dest, "layers"), { recursive: true });

    // 최종 SVG · 매니페스트 · QA (데모의 본체)
    for (const f of ["layered.svg", "layer_manifest.json", "qa_report.json", "prompts.json"]) {
      try { await fs.copyFile(path.join(src, f), path.join(dest, f)); } catch { /* 선택 */ }
    }
    // 레이어별 SVG — 개별 파트 편집 가능함을 보여주는 근거
    let layerSvgs = 0;
    try {
      for (const f of await fs.readdir(path.join(src, "layers"))) {
        if (!f.endsWith(".svg")) continue;
        await fs.copyFile(path.join(src, "layers", f), path.join(dest, "layers", f));
        layerSvgs++;
      }
    } catch { /* 없으면 생략 */ }

    // 원본(격리·크롭된 canonical) — 웹용 축소
    const canonical = path.join(src, "canonical_input.png");
    const meta = await sharp(canonical).metadata();
    await sharp(canonical)
      .flatten({ background: "#ffffff" })
      .resize(900, 900, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 84 })
      .toFile(path.join(dest, "input.jpg"));

    // 재현 패키지는 작은 것만 (예시용)
    try {
      const st = await fs.stat(path.join(src, "job_bundle.zip"));
      if (st.size < 2 * 1024 * 1024) await fs.copyFile(path.join(src, "job_bundle.zip"), path.join(dest, "job_bundle.zip"));
    } catch { /* 선택 */ }

    // 레이어별 path 수 (최종 SVG에서 센다)
    const svgText = await fs.readFile(path.join(src, "layered.svg"), "utf8");
    const pathCount = new Map<string, number>();
    for (const m of svgText.matchAll(/<g id="layer-([^"]+)"[^>]*>([\s\S]*?)<\/g>/g))
      pathCount.set(m[1], (m[2].match(/<path\b/g) ?? []).length);

    const sel = (report.selection ?? []) as { layer_id: string; profile?: string; profile_reason?: string }[];
    const qa = report.qa as Record<string, any>;

    const category = name.replace(/_\d+$/, "");
    const files: Record<string, string> = {
      svg: `samples-v2/${name}/layered.svg`,
      manifest: `samples-v2/${name}/layer_manifest.json`,
      qa: `samples-v2/${name}/qa_report.json`,
      input: `samples-v2/${name}/input.jpg`,
    };
    try {
      await fs.access(path.join(dest, "job_bundle.zip"));
      files.bundle = `samples-v2/${name}/job_bundle.zip`;
    } catch { /* 없음 */ }

    const v1Id = jobs.get(name);
    let v1: V2Sample["v1"];
    if (v1Id) {
      try {
        const irPath = path.join(config.outputsDir, v1Id, `flat_${v1Id.slice(0, 8)}.ir.json`);
        const ir = JSON.parse(await fs.readFile(irPath, "utf8"));
        v1 = {
          svg: `samples/${name}/result.svg`, // V1 데모 자산과 공유
          groups: ir.layers.reduce((n: number, L: { groups: unknown[] }) => n + L.groups.length, 0),
        };
      } catch { /* V1 자산 없음 */ }
    }

    samples.push({
      id: name,
      name,
      category,
      categoryLabel: CATEGORY_LABEL[category] ?? category,
      state: (report.job as Record<string, string>).state,
      width: meta.width!,
      height: meta.height!,
      layers: [...manifest.layers]
        .sort((a, b) => a.z_index - b.z_index)
        .map((L) => {
          const s = sel.find((x) => x.layer_id === L.id);
          return {
            id: L.id,
            label: L.label,
            role: L.semantic_role,
            material: L.material,
            profile: s?.profile ?? L.vector_profile,
            profileReason: s?.profile_reason,
            z: L.z_index,
            confidence: L.confidence,
            requiresReview: L.requires_review,
            occludedBy: L.occluded_by,
            paths: pathCount.get(L.id) ?? 0,
          };
        }),
      qa: {
        pass: qa.pass,
        needsReview: qa.needsReview,
        foregroundIou: qa.silhouette.foregroundIou,
        boundaryF: qa.silhouette.boundaryFScore,
        deltaE: qa.color.maskedDeltaE2000,
        ssim: qa.perceptual.ssim,
        integrity: qa.structure.manifestSvgIntegrity,
        invalidGeometry: qa.vector.invalidGeometry,
        strict: qa.vector.strictVectorCompliant,
        paths: qa.vector.totalPaths,
        nodes: qa.vector.totalNodes,
        kb: qa.vector.fileKb,
        failures: (qa.failures ?? []).slice(0, 6),
        notes: qa.notes ?? [],
      },
      provenance: report.provenance as Record<string, unknown>,
      retries: (report.retries ?? []) as V2Sample["retries"],
      stages: ((report.stages ?? []) as { id: string; ms: number; detail?: string }[]).map((s) => ({
        id: s.id, ms: s.ms, detail: s.detail,
      })),
      files,
      v1,
    });
    console.log(`  ${name.padEnd(12)} 레이어 ${manifest.layers.length} · path ${qa.vector.totalPaths} · 레이어SVG ${layerSvgs}`);
  }

  // V1↔V2 비교표 (compare-v1-v2.ts가 만든 것을 그대로 싣는다)
  let comparison: unknown = null;
  try {
    comparison = JSON.parse(await fs.readFile(path.join(V2, "comparison.json"), "utf8"));
  } catch { /* 없으면 생략 */ }

  await fs.writeFile(
    path.join(OUT, "index.json"),
    JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), samples, comparison }, null, 2),
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
  console.log(`\nV2 데모 자산 ${samples.length}종 → ${OUT}`);
  console.log(`총 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
