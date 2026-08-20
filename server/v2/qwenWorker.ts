/**
 * S05 후보 프롬프트 구성 + S06 Qwen 레이어 후보 생성 — 개발계획서 §7.2, §8.2.
 *
 * 모델 백엔드는 두 가지를 지원한다. 계획서 §17.1이 지적한 대로
 * Qwen-Image-Layered-Control은 공개 inference provider가 없어 자체 호스팅이 전제다.
 *
 *  · layered_control (계획서의 1순위) — 자체 호스팅 DiffSynth 엔드포인트.
 *    `QWEN_LC_URL`이 있으면 레이어별 프롬프트로 단일 레이어를 직접 추출한다.
 *  · layered_hosted (지금 실행 가능한 경로) — fal의 `qwen-image-layered`.
 *    한 번 호출로 N개 amodal RGBA 레이어를 내놓으므로, 호출 파라미터(seed·레이어 수)를
 *    바꿔가며 얻은 레이어들을 visible mask와 매칭해 레이어별 후보로 삼는다.
 *
 * 두 백엔드 모두 같은 계약(LayerCandidate)을 지키므로 GPU가 준비되면 env만 바꾸면 된다.
 * 모든 후보에 model revision·seed·config hash를 남긴다(부록 A).
 */
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import sharp from "sharp";
import { config } from "../config.js";
import { qwenLayered } from "../clients/falClient.js";
import { withRetry } from "../clients/retry.js";
import { alphaMask, area, iou } from "./raster.js";
import { EXTRACT_PROMPT_VERSION, type LayerManifest, type ManifestLayer } from "./schema.js";

/** 예시 3. 레이어별 positive prompt (계획서 원문 템플릿) */
export function positivePrompt(L: ManifestLayer, objectCategory: string, occluders: string[]): string {
  const occluderList = occluders.length ? occluders.join(", ") : "nothing";
  return [
    `Extract only the ${labelEn(L)} of the ${objectCategory}.`,
    `Return the layer isolated on a transparent canvas at the exact original position,`,
    `scale, perspective, and orientation. Preserve the visible shape and material appearance.`,
    `Complete the portions hidden behind ${occluderList} as one continuous, plausible object,`,
    `using ${L.hidden_geometry_hint || "smooth contour continuation"}. Keep the full object inside the original canvas.`,
    `Do not include any other product part, background, external shadow, duplicated geometry,`,
    `text, watermark, crop, rescaling, camera change, or invented ornament.`,
  ].join("\n");
}

/** 예시 4. 공통 negative prompt (계획서 원문) */
export const NEGATIVE_PROMPT = [
  "other parts, background, table, external cast shadow, duplicate, crop,",
  "rescale, shifted position, altered perspective, additional gemstone, extra prong,",
  "new engraving, text, watermark, disconnected fragments, opaque background",
].join("\n");

/** 강한 negative — high/retry preset에서 hallucination을 더 누른다 */
export const NEGATIVE_PROMPT_STRONG =
  NEGATIVE_PROMPT +
  ", invented hidden ornament, changed silhouette, mirrored geometry, extra hole, new highlight";

/** 영문 라벨 — manifest label이 한국어여도 프롬프트는 영어로 (§7.2) */
function labelEn(L: ManifestLayer): string {
  const s = L.visible_description?.trim();
  if (s && /[a-z]/i.test(s)) return s.split(/[.,;]/)[0].slice(0, 60);
  return L.id.replace(/_/g, " ");
}

// ── 프리셋 (§8.2) ───────────────────────────────────────────
export type QualityPreset = "draft" | "standard" | "high" | "retry";

export interface CandidateConfig {
  seed: number;
  cfg: number;
  steps: number;
  negative: string;
  numLayers: number; // hosted 백엔드에서 분해 개수
}

/** §7.3 seed_set — 후보 재생성·비교를 위해 고정 */
export const SEED_SET = [104, 209, 813, 1440, 2571, 3312, 4127, 5008];

export function candidateConfigs(preset: QualityPreset, manifestLayers: number): CandidateConfig[] {
  const base = { cfg: 4, steps: 30, negative: NEGATIVE_PROMPT, numLayers: clampLayers(manifestLayers) };
  switch (preset) {
    case "draft":
      return [{ ...base, seed: SEED_SET[0] }, { ...base, seed: SEED_SET[1] }].slice(0, 2);
    case "standard":
      // seed 4개 (계획서: seed 4개 또는 seed 2 × CFG 2)
      return SEED_SET.slice(0, 4).map((seed) => ({ ...base, seed }));
    case "high":
      // seed + negative 강도 + hidden hint 변형 (6개)
      return [
        ...SEED_SET.slice(0, 3).map((seed) => ({ ...base, seed })),
        ...SEED_SET.slice(3, 5).map((seed) => ({ ...base, seed, negative: NEGATIVE_PROMPT_STRONG })),
        { ...base, seed: SEED_SET[5], cfg: 5.5, negative: NEGATIVE_PROMPT_STRONG },
      ];
    case "retry":
      // 문제 원인에 맞춘 재작성 — 최대 4개 추가
      return [
        { ...base, seed: SEED_SET[5], negative: NEGATIVE_PROMPT_STRONG },
        { ...base, seed: SEED_SET[6], negative: NEGATIVE_PROMPT_STRONG, cfg: 5 },
        { ...base, seed: SEED_SET[7], numLayers: clampLayers(manifestLayers + 2) },
        { ...base, seed: SEED_SET[2], numLayers: clampLayers(manifestLayers - 1), cfg: 3.5 },
      ];
  }
}

const clampLayers = (n: number) => Math.max(4, Math.min(12, n));

export interface LayerCandidate {
  layerId: string;
  /** amodal RGBA (가려진 부분까지 포함된 생성 결과) */
  rgbaPath: string;
  /** 생성 결과의 알파 마스크 */
  alpha: Uint8Array;
  seed: number;
  cfg: number;
  steps: number;
  backend: string;
  modelRevision: string;
  configHash: string;
  /** hosted 백엔드에서 몇 번째 분해 레이어가 매칭됐는지 */
  sourceIndex?: number;
  /** visible mask와의 IoU — 매칭 근거 */
  matchIou: number;
}

export interface CandidateResult {
  candidates: Map<string, LayerCandidate[]>;
  backend: string;
  calls: number;
  cached: number;
  /** 생성 실패 사유 — 비어 있지 않으면 가림 복원이 생략된 레이어가 있다 */
  errors: string[];
}

/**
 * S06 실행. 레이어별로 K개 후보를 만든다.
 * §17.3 캐시 키: input_hash + manifest_hash + layer_id + prompt_version + model_revision + config_hash
 */
export async function generateLayerCandidates(
  imagePath: string,
  manifest: LayerManifest,
  visibleMasks: Map<string, Uint8Array>,
  W: number,
  H: number,
  preset: QualityPreset,
  outDir: string,
  onProgress?: (m: string) => void,
): Promise<CandidateResult> {
  await fs.mkdir(outDir, { recursive: true });
  const configs = candidateConfigs(preset, manifest.layers.length);
  const backend = config.qwenLayeredControlUrl ? "layered_control" : "layered_hosted";
  const modelRevision = config.qwenLayeredControlUrl
    ? config.qwenModelRevision || "self-hosted"
    : "fal:qwen-image-layered";

  const inputHash = crypto
    .createHash("sha256")
    .update(await fs.readFile(imagePath))
    .digest("hex")
    .slice(0, 16);
  const manifestHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(manifest.layers.map((L) => [L.id, L.z_index, L.material])))
    .digest("hex")
    .slice(0, 12);

  const out = new Map<string, LayerCandidate[]>();
  for (const L of manifest.layers) out.set(L.id, []);
  let calls = 0, cached = 0;
  const genErrors: string[] = [];

  if (backend === "layered_control") {
    // ── 1순위: 레이어별 프롬프트 추출 (계획서 설계 그대로) ──
    for (const L of manifest.layers) {
      const occl = L.occluded_by
        .map((id) => manifest.layers.find((x) => x.id === id)?.label ?? id)
        .filter(Boolean);
      const pos = positivePrompt(L, manifest.object.category, occl);
      for (const c of configs) {
        const hash = cfgHash({ pos, ...c, prompt: EXTRACT_PROMPT_VERSION });
        const dest = path.join(outDir, `${L.id}__${hash}.png`);
        let hit = true;
        try {
          await fs.access(dest);
        } catch {
          hit = false;
          try {
            const png = await callLayeredControl(imagePath, pos, c);
            await fs.writeFile(dest, png);
            calls++;
          } catch (e) {
            const msg = (e as Error).message.slice(0, 120);
            onProgress?.(`후보 생성 실패 (${L.id}, seed ${c.seed}): ${msg}`);
            genErrors.push(msg);
            continue;
          }
        }
        if (hit) cached++;
        out.get(L.id)!.push({
          layerId: L.id,
          rgbaPath: dest,
          alpha: await alphaMask(dest, W, H),
          seed: c.seed, cfg: c.cfg, steps: c.steps,
          backend, modelRevision,
          configHash: hash,
          matchIou: 1,
        });
      }
      onProgress?.(`${L.id}: 후보 ${configs.length}개`);
    }
  } else {
    // ── 실행 가능한 경로: 전체 분해 후 manifest 레이어에 매칭 ──
    // 호출마다 얻은 N개 레이어를 visible mask와 IoU로 매칭한다. 한 호출이
    // 모든 레이어의 후보를 한 개씩 공급하므로 K = configs.length가 된다.
    for (const c of configs) {
      const hash = cfgHash({ ...c, manifestHash, inputHash, prompt: EXTRACT_PROMPT_VERSION });
      const cacheDir = path.join(outDir, `_call_${hash}`);
      let layers: { index: number; rgbaPng: Buffer; coverage: number }[];
      try {
        const files = (await fs.readdir(cacheDir)).filter((f) => f.endsWith(".png")).sort();
        if (!files.length) throw new Error("empty");
        layers = await Promise.all(
          files.map(async (f, i) => ({
            index: i,
            rgbaPng: await fs.readFile(path.join(cacheDir, f)),
            coverage: 0,
          })),
        );
        cached++;
      } catch {
        // §22.3 장애 복구: 생성 워커가 죽어도 잡 전체를 실패시키지 않는다.
        // 후보가 없으면 가시영역만으로 레이어를 구성하고(가림 복원 없음)
        // QA가 그 사실을 hidden=0으로 드러낸다.
        try {
          const caption = peelingCaption(manifest);
          layers = await qwenLayered(imagePath, c.numLayers, caption);
          calls++;
          await fs.mkdir(cacheDir, { recursive: true });
          for (const l of layers)
            await fs.writeFile(path.join(cacheDir, `q${String(l.index).padStart(2, "0")}.png`), l.rgbaPng);
        } catch (e) {
          const msg = (e as Error).message.slice(0, 120);
          onProgress?.(`후보 생성 실패 (seed ${c.seed}) → 가시영역만 사용: ${msg}`);
          genErrors.push(msg);
          continue;
        }
      }

      // 각 분해 레이어의 알파를 캔버스 좌표로 올린다
      const alphas: { index: number; alpha: Uint8Array; a: number }[] = [];
      for (const l of layers) {
        const alpha = await alphaMask(l.rgbaPng, W, H);
        const a = area(alpha);
        // 배경(거의 전면)·빈 레이어 제외
        if (a > W * H * 0.9 || a < W * H * 0.002) continue;
        alphas.push({ index: l.index, alpha, a });
      }

      // manifest 레이어 ↔ 분해 레이어 매칭 (탐욕, IoU 최대)
      const usedSrc = new Set<number>();
      const pairs: { layerId: string; srcIdx: number; score: number }[] = [];
      for (const L of manifest.layers) {
        const vm = visibleMasks.get(L.id);
        if (!vm) continue;
        for (const s of alphas) {
          // 가시 마스크가 생성 레이어 안에 얼마나 들어가는가 (amodal은 더 크므로 IoU만으론 낮게 나온다)
          let inside = 0;
          for (let i = 0; i < vm.length; i++) if (vm[i] && s.alpha[i]) inside++;
          const containment = inside / Math.max(1, area(vm));
          const score = 0.7 * containment + 0.3 * iou(vm, s.alpha);
          pairs.push({ layerId: L.id, srcIdx: s.index, score });
        }
      }
      pairs.sort((x, y) => y.score - x.score);
      const usedLayer = new Set<string>();
      for (const p of pairs) {
        if (usedLayer.has(p.layerId) || usedSrc.has(p.srcIdx)) continue;
        if (p.score < 0.25) continue;
        usedLayer.add(p.layerId); usedSrc.add(p.srcIdx);
        const src = alphas.find((s) => s.index === p.srcIdx)!;
        const dest = path.join(outDir, `${p.layerId}__${hash}_${p.srcIdx}.png`);
        const raw = layers.find((l) => l.index === p.srcIdx)!.rgbaPng;
        await sharp(raw).resize(W, H, { fit: "fill" }).png().toFile(dest);
        out.get(p.layerId)!.push({
          layerId: p.layerId,
          rgbaPath: dest,
          alpha: src.alpha,
          seed: c.seed, cfg: c.cfg, steps: c.steps,
          backend, modelRevision,
          configHash: hash,
          sourceIndex: p.srcIdx,
          matchIou: +p.score.toFixed(3),
        });
      }
    }
    onProgress?.(
      `후보: ${[...out.entries()].map(([id, cs]) => `${id}=${cs.length}`).join(" ")} (호출 ${calls}, 캐시 ${cached})`,
    );
  }

  if (genErrors.length)
    onProgress?.(`후보 생성 ${genErrors.length}건 실패 — 해당 레이어는 가시영역만으로 구성됩니다`);
  return { candidates: out, backend, calls, cached, errors: [...new Set(genErrors)] };
}

/**
 * hosted 백엔드용 caption — LayerPeeler(SIGGRAPH Asia 2025)의 peeling order 사상.
 * manifest의 앞→뒤 순서를 그대로 알려 주어 분해 경계가 manifest와 맞도록 유도한다.
 */
function peelingCaption(m: LayerManifest): string {
  const front2back = [...m.layers].sort((a, b) => b.z_index - a.z_index).map((L) => labelEn(L));
  return (
    `${m.object.style} ${m.object.category}, ${m.object.view} view. ` +
    `Decompose in peeling order, topmost first: ${front2back.join(", ")}. ` +
    `One distinct part per layer with complete amodal shape on transparent background.`
  );
}

function cfgHash(o: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 12);
}

/** 자체 호스팅 Qwen-Image-Layered-Control 호출 (OpenAPI 계약은 배포 측과 합의) */
async function callLayeredControl(
  imagePath: string,
  prompt: string,
  c: CandidateConfig,
): Promise<Buffer> {
  const url = config.qwenLayeredControlUrl;
  if (!url) throw new Error("QWEN_LC_URL 미설정");
  const b64 = (await fs.readFile(imagePath)).toString("base64");
  return withRetry(
    async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.qwenLayeredControlKey ? { Authorization: `Bearer ${config.qwenLayeredControlKey}` } : {}),
        },
        body: JSON.stringify({
          image_base64: b64,
          prompt,
          negative_prompt: c.negative,
          seed: c.seed,
          cfg_scale: c.cfg,
          num_inference_steps: c.steps,
          output_format: "png",
        }),
      });
      if (!res.ok) throw new Error(`layered-control ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = (await res.json()) as { image_base64?: string; image_url?: string };
      if (j.image_base64) return Buffer.from(j.image_base64, "base64");
      if (j.image_url) return Buffer.from(await (await fetch(j.image_url)).arrayBuffer());
      throw new Error("layered-control 응답에 이미지가 없습니다");
    },
    { label: "qwen-lc" },
  );
}
