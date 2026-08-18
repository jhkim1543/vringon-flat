import path from "node:path";
import fs from "node:fs/promises";
import { config } from "../config.js";
import { understandImage } from "../clients/openaiClient.js";
import { generateFlats } from "./flatgen.js";
import { isolateProduct, cropToSubject } from "./prepare.js";
import { splitInstances } from "./instances.js";
import { rankCandidates } from "./rank.js";
import { decomposeLayers } from "./decompose.js";
import { compositeQa, editabilityCheck, sanitizeIr } from "./qa.js";
import { vectorizeLayers } from "./vectorize.js";
import { buildAiPdf } from "../writers/aiPdfWriter.js";
import { buildJsx } from "../writers/jsxWriter.js";
import { buildSvg } from "../writers/svgWriter.js";
import type { Job, StageId, VectorIR } from "../types.js";

const STAGE_LABELS: Record<StageId, string> = {
  prepare: "0. 입력 정규화 · 배경 격리",
  understand: "1. 이미지 이해 (GPT-5.6 — Layer Plan)",
  flatgen: "2. 플랫 스케치 생성 (Gemini + GPT Image)",
  rank: "3. Candidate 자동 평가/선택",
  segment: "4. 레이어 분해 (Qwen amodal + GPT 명명 + SAM 3)",
  qa: "5. 재합성 QA (레이어 검증)",
  vectorize: "6. 레이어별 벡터화 (VTracer)",
  optimize: "7. Vector Optimizer",
  build: "8. .ai / .jsx / .svg 생성",
};

export function initStages(): Job["stages"] {
  return (Object.keys(STAGE_LABELS) as StageId[]).map((id) => ({
    id,
    label: STAGE_LABELS[id],
    status: "pending",
  }));
}

export async function runPipeline(job: Job) {
  const jobDir = path.join(config.outputsDir, job.id);
  await fs.mkdir(jobDir, { recursive: true });

  const stage = (id: StageId) => job.stages.find((s) => s.id === id)!;
  const start = (id: StageId, detail?: string) => {
    const s = stage(id);
    s.status = "running";
    s.detail = detail;
    s.startedAt = Date.now();
  };
  const done = (id: StageId, detail?: string) => {
    const s = stage(id);
    s.status = "done";
    if (detail) s.detail = detail;
    s.endedAt = Date.now();
  };

  try {
    // 0. 입력 정규화는 업로드 시 끝났고, 여기서는 이해 → 배경 격리 순으로 간다.
    //    (격리에 쓸 명사를 GPT가 알려주므로 이해가 먼저다.)
    start("prepare", job.inputNotes?.join(" / "));

    // 1. Semantic understanding — 배경이 남아 있는 원본으로 판단한다
    start("understand");
    // OpenAI가 죽어 있어도(크레딧 소진) 재현 실행이 가능하도록 기존 잡의
    // plan.json을 재사용할 수 있다. 없으면 정상 경로.
    const reuse = job.options.planFrom
      ? path.join(config.outputsDir, job.options.planFrom, "plan.json")
      : null;
    let plan: NonNullable<Job["plan"]>;
    if (reuse && (await fs.stat(reuse).catch(() => null))) {
      plan = JSON.parse(await fs.readFile(reuse, "utf8"));
    } else {
      plan = await understandImage(job.rawPath, job.options.layerDetail, job.options.categoryHint);
    }
    // 재사용했더라도 이 잡에 plan.json을 남긴다 — 재빌드(rebuild.ts)가 읽는다
    await fs.writeFile(path.join(jobDir, "plan.json"), JSON.stringify(plan, null, 2));
    job.plan = plan;
    done("understand", `${plan.category} (${plan.objectNoun}) / ${plan.parts.length} parts`);

    // 0-b. 배경 격리 → 제품 크롭.
    //      파이프라인 전체가 "흰 배경을 꽉 채운 제품 한 점"을 가정한다.
    //      제품이 작게 찍힌 사진은 크롭하지 않으면 파트가 뭉개진다.
    const isoPath = path.join(jobDir, "isolated.png");
    const iso = await isolateProduct(
      job.rawPath,
      isoPath,
      plan.objectNoun,
      plan.category,
    );
    const crop = await cropToSubject(isoPath, job.inputPath);

    // 0-c. 복수 객체 → 인스턴스 분리. 한 화면에 신발 2개·링 3개가 있으면
    //      파트 이름이 중복돼 배정이 깨지고 선F1이 63~74%로 떨어졌다(실측).
    //      인스턴스마다 2~7단계를 독립 실행하고 하나의 IR로 합친다.
    const split = await splitInstances(
      job.inputPath,
      path.join(jobDir, "instances"),
      plan.objectNoun,
    );
    done(
      "prepare",
      [...(job.inputNotes ?? []), iso.note, crop.note, split.note].filter(Boolean).join(" / "),
    );

    const multi = split.instances.length > 1;
    const perInstance: {
      inst: (typeof split.instances)[number];
      ir: import("../types.js").VectorIR;
      layers: import("./layers.js").LayerPng[];
      qa: NonNullable<Job["qa"]>;
    }[] = [];
    let candidatesTotal = 0;
    let engineNote = "";

    for (const inst of split.instances) {
      const tag = multi ? `[${inst.index + 1}/${split.instances.length}] ` : "";
      const instDir = multi ? path.join(jobDir, `inst_${inst.index}`) : jobDir;
      await fs.mkdir(instDir, { recursive: true });

      // 2. Flat generation (양 모델 × lineart/colorflat)
      start("flatgen");
      const candidates = await generateFlats(
        inst.imagePath,
        plan,
        path.join(instDir, "candidates"),
        (msg) => (stage("flatgen").detail = tag + msg),
      );
      candidatesTotal += candidates.length;
      if (!multi) job.candidates = candidates;
      done("flatgen", `${candidatesTotal} candidates`);

      // 3. Ranking
      start("rank");
      const winners = await rankCandidates(inst.imagePath, candidates);
      if (!winners.lineart || !winners.colorflat)
        throw new Error("candidate 평가 실패: 승자 없음");
      if (!multi) job.winner = { lineart: winners.lineart.id, colorflat: winners.colorflat.id };
      done(
        "rank",
        `${tag}lineart=${winners.lineart.id}(${winners.lineart.score?.total}) colorflat=${winners.colorflat.id}(${winners.colorflat.score?.total})`,
      );

      // 4. 레이어 분해 — Qwen amodal + 연결요소 + GPT 명명 + SAM 3
      start("segment");
      const dec = await decomposeLayers(
        plan,
        winners.colorflat.imagePath,
        winners.lineart.imagePath,
        inst.imagePath,
        path.join(instDir, "layers"),
        (msg) => (stage("segment").detail = tag + msg),
      );
      engineNote = dec.engine;
      done(
        "segment",
        `${tag}${dec.layers.length} layers — Qwen ${dec.stats.qwenLayers} → 조각 ${dec.stats.components} → 명명 ${dec.stats.named}`,
      );

      // 5. 재합성 QA — 레이어는 플랫에서 파생되므로 플랫과 대조 (qa.ts 참고)
      start("qa");
      const qa = await compositeQa(dec.layers, path.join(instDir, "layers", "_aligned_flat.png"));
      done(
        "qa",
        `${tag}coverage ${(qa.coverage * 100).toFixed(1)}% · spill ${(qa.spill * 100).toFixed(1)}%` +
          (qa.notes.length ? ` · ${qa.notes.join(" / ")}` : " · 이상 없음"),
      );

      // 6~7. 벡터화 + 최적화
      start("vectorize");
      const { ir, engine } = await vectorizeLayers(dec.layers, dec.width, dec.height, (msg) => {
        stage("vectorize").detail = tag + msg;
      });
      job.engines.vectorize = engine;
      done("vectorize", engine);

      perInstance.push({ inst, ir, layers: dec.layers, qa });
    }
    job.engines.segment = engineNote;

    // 인스턴스 합치기 — 각 인스턴스를 최상위 레이어로 감싸고 원본 좌표계로 이동
    const ir = multi ? mergeInstanceIrs(perInstance, split.instances) : perInstance[0].ir;
    const layers = perInstance.flatMap((p) => p.layers);
    // QA 요약: 최악값 기준(어느 인스턴스든 실패면 실패)
    job.qa = perInstance.length === 1
      ? perInstance[0].qa
      : {
          pass: perInstance.every((p) => p.qa.pass),
          coverage: Math.min(...perInstance.map((p) => p.qa.coverage)),
          spill: Math.max(...perInstance.map((p) => p.qa.spill)),
          duplicates: perInstance.flatMap((p) => p.qa.duplicates),
          emptyLayers: perInstance.flatMap((p) => p.qa.emptyLayers),
          colorDeltaE: Math.max(...perInstance.map((p) => p.qa.colorDeltaE ?? 0)),
          colorOutliers: perInstance.flatMap((p, i) =>
            (p.qa.colorOutliers ?? []).map((o) => ({ ...o, name: `#${i + 1} ${o.name}` })),
          ),
          notes: perInstance.flatMap((p, i) => p.qa.notes.map((n) => `[${i + 1}] ${n}`)),
        };
    if (!job.qa.pass) stage("qa").status = "error";
    // QA 요약 파일 — 데모 자산 생성기·리포트가 재실행 없이 읽는다
    await fs.writeFile(path.join(jobDir, "qa.json"), JSON.stringify(job.qa, null, 2), "utf8");

    start("optimize");
    const pathCount = ir.layers.reduce(
      (n, l) => n + l.groups.reduce((m, g) => m + g.paths.length, 0),
      0,
    );
    // Illustrator가 못 여는 패스(NaN·범위 밖·퇴화)는 산출물에 남기지 않는다
    const sanitized = sanitizeIr(ir);
    const editNotes = editabilityCheck(ir);
    if (sanitized) editNotes.unshift(`유효하지 않은 패스 ${sanitized}개 정화`);
    done(
      "optimize",
      `${pathCount} paths${multi ? ` · 인스턴스 ${perInstance.length}개 병합` : ""}${editNotes.length ? ` · ${editNotes.join(" / ")}` : ""}`,
    );

    // 8. 산출물
    start("build");
    const base = `flat_${job.id.slice(0, 8)}`;
    const aiPath = path.join(jobDir, `${base}.ai`);
    const jsxPath = path.join(jobDir, `${base}.jsx`);
    const svgPath = path.join(jobDir, `${base}.svg`);
    const irPath = path.join(jobDir, `${base}.ir.json`);
    await fs.writeFile(aiPath, buildAiPdf(ir));
    await fs.writeFile(jsxPath, buildJsx(ir, `${base}_native.ai`), "utf8");
    await fs.writeFile(svgPath, buildSvg(ir), "utf8");
    await fs.writeFile(irPath, JSON.stringify(ir, null, 2), "utf8");
    job.outputs = {
      ai: rel(aiPath),
      jsx: rel(jsxPath),
      svg: rel(svgPath),
      layerPngs: layers.map((l) => rel(l.pngPath)),
    };
    done("build");

    job.status = "done";
  } catch (e) {
    // 실행 중인 단계가 여럿일 수 있다(prepare는 understand 뒤에 끝난다).
    // 가장 마지막에 시작한 단계가 실제 실패 지점이다 — 첫 번째를 고르면
    // 엉뚱한 단계에 오류가 표시된다(실측: OpenAI 실패가 prepare로 찍혔다).
    const running = job.stages
      .filter((s) => s.status === "running")
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
    if (running) {
      running.status = "error";
      running.detail = (e as Error).message;
    }
    job.status = "error";
    job.error = (e as Error).message;
  }
}

function rel(abs: string): string {
  return "/outputs/" + path.relative(config.outputsDir, abs).replace(/\\/g, "/");
}

/**
 * 인스턴스별 IR을 하나로 합친다.
 *
 * 각 인스턴스 IR은 "그 인스턴스 이미지"의 좌표계(= 원본 전체 캔버스 크기,
 * 인스턴스만 남기고 흰색)라 캔버스가 이미 동일하다 → 좌표 이동 없이 그대로
 * 합칠 수 있다. 레이어 이름 앞에 `#n ` 접두사를 붙여 Illustrator에서
 * 인스턴스별로 그룹이 구분되게 한다.
 */
export function mergeInstanceIrs(
  per: { inst: { index: number; score: number }; ir: VectorIR }[],
  _all: unknown[],
): VectorIR {
  const first = per[0].ir;
  const merged: VectorIR = { width: first.width, height: first.height, layers: [] };
  // 큰 인스턴스(앞쪽)부터 아래에 깔리도록 점수 역순으로 페인팅
  const ordered = [...per].sort((a, b) => a.inst.score - b.inst.score);
  for (const p of ordered) {
    const n = p.inst.index + 1;
    for (const L of p.ir.layers) {
      merged.layers.push({
        name: `#${n} ${L.name}`,
        groups: L.groups.map((g) => ({ name: g.name, paths: g.paths })),
      });
    }
  }
  return merged;
}
