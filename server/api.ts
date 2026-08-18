/**
 * 공개 REST API (v1) — 외부에서 이 서비스를 쓰는 유일한 계약.
 *
 * 설계 원칙
 *  · **비동기 잡**: 한 건이 2~5분 걸린다(생성 모델 2개 + 분해 + 벡터화).
 *    HTTP 요청을 붙잡고 있지 않고 잡을 만든 뒤 폴링하게 한다.
 *  · **파일은 별도 엔드포인트**: 상태 응답에 바이너리를 싣지 않는다.
 *    `/v1/jobs/{id}/file/{kind}`가 올바른 Content-Type으로 내려준다.
 *  · **키가 있어야만 보호된다**: `API_KEYS`가 비어 있으면 인증 없이 열린다
 *    (로컬 개발). 공개 배포 시 반드시 채울 것.
 *  · **동시 실행 제한**: 외부 모델 호출 비용·레이트리밋 때문에 동시 잡 수를
 *    제한하고 초과분은 429로 즉시 거절한다(큐에 쌓아 두면 타임아웃만 는다).
 *
 * 내부용 `/api/*` 경로는 웹 UI 하위호환으로 남겨 둔다.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { config, assertBaseKeys } from "./config.js";
import { runPipeline, initStages } from "./pipeline/run.js";
import { normalizeInput } from "./pipeline/prepare.js";
import type { Job, JobOptions, Category, Style, LayerDetail } from "./types.js";

export const jobs = new Map<string, Job>();

/** 완료된 잡의 메모리 보관 제한 (산출물 파일은 디스크에 남는다) */
const MAX_JOBS = 200;
function pruneJobs() {
  if (jobs.size <= MAX_JOBS) return;
  const done = [...jobs.values()]
    .filter((j) => j.status !== "running")
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const j of done.slice(0, jobs.size - MAX_JOBS)) jobs.delete(j.id);
}

const upload = multer({ limits: { fileSize: config.maxUploadMb * 1024 * 1024 } });

const VALID_STYLE: Style[] = ["color", "bw", "design"];
const VALID_DETAIL: LayerDetail[] = ["simple", "standard", "detailed"];
const VALID_CATEGORY: Category[] = [
  "footwear", "bag", "jewelry", "apparel", "eyewear", "watch",
  "headwear", "furniture", "electronics", "packaging", "other",
];

/** 다운로드 가능한 산출물 종류 */
const FILE_KINDS = {
  ai: { ext: ".ai", type: "application/postscript", label: "Illustrator (PDF 호환, OCG 레이어)" },
  svg: { ext: ".svg", type: "image/svg+xml", label: "SVG (미리보기·웹)" },
  jsx: { ext: ".jsx", type: "application/javascript", label: "Illustrator 스크립트 (네이티브 .ai 생성)" },
  ir: { ext: ".ir.json", type: "application/json", label: "Vector IR (레이어·그룹·패스 구조)" },
} as const;
type FileKind = keyof typeof FILE_KINDS;

// ── 인증 ────────────────────────────────────────────────────
function requireKey(req: Request, res: Response, next: NextFunction) {
  if (!config.apiKeys.length) return next(); // 키 미설정 = 공개 모드(로컬 개발)
  const given = (req.header("x-api-key") || req.header("authorization")?.replace(/^Bearer\s+/i, "") || "").trim();
  if (given && config.apiKeys.includes(given)) return next();
  res.status(401).json({ error: { code: "unauthorized", message: "X-API-Key 헤더가 필요합니다" } });
}

function fail(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

/** 진행률 0~1 — 완료된 단계 비율 */
function progressOf(job: Job): number {
  const total = job.stages.length;
  const done = job.stages.filter((s) => s.status === "done" || s.status === "skipped").length;
  return +(done / total).toFixed(2);
}

/** 외부에 내보내는 잡 표현 — 내부 절대경로는 절대 노출하지 않는다 */
function publicJob(job: Job, base: string) {
  const files: Record<string, string> = {};
  if (job.status === "done") {
    for (const k of Object.keys(FILE_KINDS)) files[k] = `${base}/v1/jobs/${job.id}/file/${k}`;
  }
  return {
    id: job.id,
    status: job.status,
    createdAt: new Date(job.createdAt).toISOString(),
    progress: progressOf(job),
    error: job.error,
    options: job.options,
    inputNotes: job.inputNotes,
    category: job.plan?.category,
    objectNoun: job.plan?.objectNoun,
    parts: job.plan?.parts.map((p) => ({ id: p.id, name: p.name, group: p.parent, kind: p.kind })),
    stages: job.stages.map((s) => ({
      id: s.id,
      label: s.label,
      status: s.status,
      detail: s.detail,
      ms: s.startedAt && s.endedAt ? s.endedAt - s.startedAt : undefined,
    })),
    engines: job.engines,
    qa: job.qa && {
      pass: job.qa.pass,
      coverage: job.qa.coverage,
      spill: job.qa.spill,
      colorDeltaE: job.qa.colorDeltaE,
      colorOutliers: job.qa.colorOutliers,
      duplicates: job.qa.duplicates,
      emptyLayers: job.qa.emptyLayers,
      notes: job.qa.notes,
    },
    files: job.status === "done" ? files : undefined,
    previewUrl: job.status === "done" ? `${base}/outputs/${job.id}/flat_${job.id.slice(0, 8)}.svg` : undefined,
  };
}

function baseUrl(req: Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

export function mountApi(app: express.Express): void {
  const v1 = express.Router();

  // ── 상태 ──────────────────────────────────────────────────
  v1.get("/health", (_req, res) => {
    res.json({
      ok: true,
      version: config.version,
      ready: !!(config.openaiKey && config.geminiKey && config.falKey),
      engines: {
        understand: `OpenAI ${config.openaiModel}`,
        flatgen: `${config.geminiImageModel} + ${config.openaiImageModel}`,
        decompose: config.hasSam3 ? "Qwen amodal + SAM 3 (fal.ai)" : "FAL_KEY 없음 — 분해 불가",
        vectorize: config.hasVectorizerAI && config.forceVectorizerAI ? "Vectorizer.AI" : "VTracer + 자체 중심선",
      },
      keys: {
        openai: !!config.openaiKey,
        gemini: !!config.geminiKey,
        fal: config.hasSam3,
        vectorizer: config.hasVectorizerAI,
      },
      limits: {
        maxUploadMb: config.maxUploadMb,
        maxConcurrentJobs: config.maxConcurrentJobs,
        runningJobs: [...jobs.values()].filter((j) => j.status === "running").length,
      },
      authRequired: config.apiKeys.length > 0,
    });
  });

  // ── 잡 생성 ───────────────────────────────────────────────
  v1.post("/jobs", requireKey, upload.single("image"), async (req, res) => {
    try {
      try {
        assertBaseKeys();
      } catch (e) {
        return fail(res, 503, "not_configured", (e as Error).message);
      }
      if (!req.file) return fail(res, 400, "missing_image", "multipart/form-data의 image 필드가 필요합니다");

      const running = [...jobs.values()].filter((j) => j.status === "running").length;
      if (running >= config.maxConcurrentJobs) {
        res.setHeader("Retry-After", "60");
        return fail(res, 429, "busy", `동시 실행 한도(${config.maxConcurrentJobs})에 도달했습니다. 잠시 후 다시 시도하세요`);
      }

      const style = (req.body.style as Style) || "color";
      const layerDetail = (req.body.layerDetail as LayerDetail) || "standard";
      const categoryHint = req.body.categoryHint as Category | undefined;
      if (!VALID_STYLE.includes(style)) return fail(res, 400, "bad_style", `style은 ${VALID_STYLE.join("|")} 중 하나`);
      if (!VALID_DETAIL.includes(layerDetail)) return fail(res, 400, "bad_layer_detail", `layerDetail은 ${VALID_DETAIL.join("|")} 중 하나`);
      if (categoryHint && !VALID_CATEGORY.includes(categoryHint))
        return fail(res, 400, "bad_category", `categoryHint는 ${VALID_CATEGORY.join("|")} 중 하나`);

      const options: JobOptions = { style, layerDetail, categoryHint, planFrom: req.body.planFrom || undefined };

      const id = crypto.randomUUID();
      const jobDir = path.join(config.outputsDir, id);
      await fs.mkdir(jobDir, { recursive: true });

      // 입력 정규화 — EXIF 회전 / 알파 / 색공간 / 크기.
      // 여기서 실패하면 사용자 입력 문제이므로 400으로 돌려준다.
      const rawPath = path.join(jobDir, "raw.png");
      let prep;
      try {
        prep = await normalizeInput(req.file.buffer, rawPath);
      } catch (e) {
        await fs.rm(jobDir, { recursive: true, force: true });
        return fail(res, 400, "bad_image", (e as Error).message);
      }

      const job: Job = {
        id,
        createdAt: Date.now(),
        status: "running",
        options,
        inputPath: path.join(jobDir, "input.png"),
        rawPath,
        inputNotes: prep.notes,
        stages: initStages(),
        engines: { segment: "", vectorize: "" },
      };
      jobs.set(id, job);
      pruneJobs();
      void runPipeline(job); // 백그라운드 실행 — 클라이언트는 폴링

      const base = baseUrl(req);
      res.status(202).json({
        id,
        status: "running",
        statusUrl: `${base}/v1/jobs/${id}`,
        pollAfterMs: 5000,
        notes: prep.notes,
      });
    } catch (e) {
      fail(res, 500, "internal", (e as Error).message);
    }
  });

  // ── 잡 조회 ───────────────────────────────────────────────
  v1.get("/jobs", requireKey, (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
    const list = [...jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((j) => publicJob(j, baseUrl(req)));
    res.json({ jobs: list });
  });

  v1.get("/jobs/:id", requireKey, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return fail(res, 404, "not_found", "그런 잡이 없습니다 (서버 재시작 시 메모리에서 사라집니다)");
    res.json(publicJob(job, baseUrl(req)));
  });

  // ── 산출물 다운로드 ───────────────────────────────────────
  v1.get("/jobs/:id/file/:kind", requireKey, async (req, res) => {
    const kind = req.params.kind as FileKind;
    const spec = FILE_KINDS[kind];
    if (!spec) return fail(res, 400, "bad_kind", `kind는 ${Object.keys(FILE_KINDS).join("|")} 중 하나`);

    // 잡 id는 UUID 형식만 허용 — 경로 탈출 차단
    const id = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(res, 400, "bad_id", "잘못된 잡 id");

    const file = path.join(config.outputsDir, id, `flat_${id.slice(0, 8)}${spec.ext}`);
    try {
      await fs.access(file);
    } catch {
      const job = jobs.get(id);
      if (job?.status === "running") return fail(res, 409, "not_ready", "아직 생성 중입니다");
      return fail(res, 404, "not_found", "산출물이 없습니다");
    }
    res.type(spec.type);
    res.setHeader("Content-Disposition", `attachment; filename="vringon-flat-${id.slice(0, 8)}${spec.ext}"`);
    res.sendFile(file);
  });

  app.use("/v1", v1);

  // ── 웹 UI 하위호환 (내부용) ───────────────────────────────
  // 웹 UI는 잡 생성·상태를 /v1으로 부르고, 내부 미리보기(후보 이미지·마스크)만
  // 여기서 받는다. 외부 계약(/v1)에는 내부 경로가 새지 않는다.
  app.get("/api/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return fail(res, 404, "not_found", "job not found");
    // 웹 UI는 내부 필드(candidates/masks 미리보기 URL)를 쓴다
    const { inputPath, rawPath, ...rest } = job;
    void inputPath; void rawPath;
    res.json({
      ...rest,
      inputUrl: `/outputs/${job.id}/input.png`,
      candidates: job.candidates?.map((c) => ({
        ...c,
        imageUrl: `/outputs/${job.id}/candidates/${path.basename(c.imagePath)}`,
      })),
      masks: job.masks?.map((m) => ({
        ...m,
        maskUrl: `/outputs/${job.id}/masks/${path.basename(m.maskPath)}`,
      })),
    });
  });
}
