/**
 * SAM 3 로 도면에서 파트 마스크를 직접 받는다 (fal.ai).
 *
 * Gemini 폴리곤과 역할은 같지만 결이 다르다 — 폴리곤은 모델이 점 목록을 "말로" 불러
 * 주는 것이라 조밀한 형상에서 일부만 훑고 끝나는 일이 잦았다(실측: bag_1 손잡이가
 * 캔버스의 0.42% 로 축소). SAM 은 픽셀 마스크를 직접 내므로 그 실패 양식이 없다.
 * 대신 **개념 이름으로 찾는** 방식이라, 파트 라벨이 흔한 명사일수록 잘 잡고
 * 추상적일수록 못 잡는다 — 못 잡은 파트는 결과에서 빠질 뿐 에러가 아니다.
 *
 * 응답은 (도면 sha × 파트 목록) 으로 캐시한다 — 같은 도면을 다시 돌릴 때 재과금이 없다.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { spawn } from "node:child_process";
import { sam3Concepts, type Sam3Mask } from "../clients/falClient.js";

/**
 * H100(SSH) 개념 세그먼트 — fal.ai 와 같은 계약의 자체 워커.
 *
 * `SAM3_SSH_HOST` 가 설정되면 이쪽을 먼저 쓴다. fal 계정 잠김(403 TOP_UP)과 무관하게
 * 돌고, 과금이 없다. 워커는 ~/vringon-flat-worker/sam3_worker.py — HF_TOKEN 이 서버에
 * 있으면 SAM 3, 없으면 GroundingDINO + SAM 2.1(게이트 없는 공개 조합)로 동작한다.
 * GPU0 만 쓴다(나머지는 다른 작업 사용 중).
 */
export interface BoxHint {
  box: [number, number, number, number];
  points: [number, number][];
  warpPng: Buffer;
}

async function sshConcepts(
  host: string, imagePath: string, concepts: string[],
  boxes?: [string, [number, number, number, number], [number, number][], string][],
): Promise<Sam3Mask[]> {
  const png = await fs.readFile(imagePath);
  const req = JSON.stringify({ image_b64: png.toString("base64"), concepts, boxes, threshold: 0.3 });
  const cmd = "source ~/miniconda3/etc/profile.d/conda.sh && conda activate ml && " +
    "CUDA_VISIBLE_DEVICES=0 python ~/vringon-flat-worker/sam3_worker.py";
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", host, cmd], { windowsHide: true });
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => errs.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`ssh 워커 exit ${code}: ${Buffer.concat(errs).toString("utf8").slice(-300)}`));
    });
    child.stdin.write(req);
    child.stdin.end();
  });
  const j = JSON.parse(out) as { engine: string; masks: { concept: string; png_b64: string; score: number }[] };
  return j.masks.map((m) => ({ concept: m.concept, maskPng: Buffer.from(m.png_b64, "base64"), score: m.score }));
}

/**
 * 파트 라벨 → SAM 개념 명사. SAM 3 는 **단일 일반 명사**만 인식한다(실측: shoe 0.98 ·
 * vamp/서술형 구절 0개). "Chain shoulder strap" 을 그대로 넘기면 조용히 0개가 온다 —
 * 실제로 그랬다(bag_2/bag_3 전 파트 0개 인식 후 빈 캐시 저장).
 *
 * 규칙: 라벨 안에서 아는 명사를 찾고(구체적일수록 먼저), 없으면 마지막 단어를 쓴다.
 */
const NOUNS = [
  "gemstone", "stone", "bezel", "pearl", "bead",
  "shoelace", "lace", "tongue", "sole", "outsole", "midsole", "insole", "heel", "toe",
  "zipper", "buckle", "clasp", "handle", "strap", "chain", "pocket", "pouch", "frame",
  "ring", "band", "pendant", "charm", "logo", "label", "stitch", "eyelet",
  "collar", "sleeve", "button", "body", "shell", "flap", "lattice", "ornament",
];
export function conceptOf(label: string): string {
  const words = label.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
  for (const n of NOUNS) if (words.includes(n)) return n;
  // 복수형도 본다 (embellishments → 사전 매칭 실패 시 단수화 시도)
  for (const w of words) {
    const sing = w.replace(/s$/, "");
    if (NOUNS.includes(sing)) return sing;
  }
  return words[words.length - 1] ?? label;
}

/**
 * **사진**의 개념 마스크 — 패키지가 없는 카테고리의 "일반 SAM" 경로.
 * H100 워커(`SAM3_SSH_HOST`)가 있으면 그쪽(GroundingDINO + SAM 2.1, HF 토큰이 있으면 SAM 3)을,
 * 없으면 fal.ai SAM 3 를 쓴다. 사진은 선화와 달리 텍스트 접지가 잘 되므로 개념 이름만 넘긴다.
 */
export async function photoConcepts(imagePath: string, concepts: string[]): Promise<Sam3Mask[]> {
  const host = process.env.SAM3_SSH_HOST;
  if (host) return sshConcepts(host, imagePath, concepts);
  return sam3Concepts(imagePath, concepts);
}

export interface Sam3PartMask {
  id: string;
  mask: Uint8Array;
  score: number;
}

export async function segmentSam3(
  schematicPath: string,
  parts: { id: string; label: string }[],
  W: number,
  H: number,
  cacheDir: string,
  say?: (m: string) => void,
  /** 파트별 워프 힌트(박스·내부 점·워프 마스크 PNG). 있으면 텍스트 접지 대신 프롬프트로
   * 쓴다 — 선화에서 텍스트 접지는 전부 통째 객체를 잡는다(실측: bag_2 다섯 개념 모두
   * 가방 전체). 워프 PNG 는 서버에서 후보 선택 심판으로 쓴다. */
  boxHints?: Map<string, BoxHint>,
): Promise<Sam3PartMask[]> {
  const png = await fs.readFile(schematicPath);
  const sha = crypto.createHash("sha256").update(png)
    .update(parts.map((p) => p.id + p.label).join("|"))
    .update(JSON.stringify([...(boxHints ?? new Map<string, BoxHint>()).entries()]
      .map(([k, v]) => [k, v.box, v.points]).sort()))
    .digest("hex").slice(0, 16);
  const cacheFile = path.join(cacheDir, `sam3_${sha}.json`);

  interface Cached { id: string; score: number; maskB64: string; w: number; h: number }
  let cached: Cached[] | null = null;
  try { cached = JSON.parse(await fs.readFile(cacheFile, "utf8")); } catch { /* 없음 */ }

  if (!cached) {
    const concepts = parts.map((p) => ({ id: p.id, concept: conceptOf(p.label) }));
    const sshHost = process.env.SAM3_SSH_HOST;
    // 박스 모드에서는 파트 id 를 키로 쓴다 — 두 파트가 같은 명사로 접히는 문제까지 해소
    const boxes = sshHost && boxHints?.size
      ? parts.filter((p) => boxHints.has(p.id)).map((p) => {
          const hint = boxHints.get(p.id)!;
          return [p.id, hint.box, hint.points, hint.warpPng.toString("base64")] as
            [string, [number, number, number, number], [number, number][], string];
        })
      : undefined;
    say?.(boxes
      ? `SAM 박스 프롬프트 ${boxes.length}개 (워프 bbox)`
      : `SAM 3 개념: ${concepts.map((c2) => c2.concept).join(", ")}`);
    const res = sshHost
      ? await sshConcepts(sshHost, schematicPath, concepts.map((c2) => c2.concept), boxes)
      : await sam3Concepts(schematicPath, concepts.map((c2) => c2.concept));
    cached = [];
    for (const r of res) {
      // 박스 모드면 concept 이 곧 파트 id 다
      const part = boxes
        ? (parts.some((p) => p.id === r.concept) ? { id: r.concept } : null)
        : concepts.find((c2) => c2.concept === r.concept);
      if (!part) continue;
      const m = await sharp(r.maskPng).greyscale().raw().toBuffer({ resolveWithObject: true });
      cached.push({
        id: part.id, score: r.score,
        maskB64: Buffer.from(m.data).toString("base64"),
        w: m.info.width, h: m.info.height,
      });
    }
    // 0개 인식은 캐시하지 않는다 — 일시 장애가 영구 캐시로 굳는 것을 막는다
    if (cached.length) {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(cached));
    }
    say?.(`SAM 3 — ${cached.length}/${parts.length} 파트 인식`);
  } else {
    say?.(`SAM 3 — 캐시 재사용 (${cached.length}/${parts.length} 파트)`);
  }

  const out: Sam3PartMask[] = [];
  for (const c of cached) {
    const src = Buffer.from(c.maskB64, "base64");
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const sy = Math.min(c.h - 1, Math.floor((y / H) * c.h));
      for (let x = 0; x < W; x++) {
        const sx = Math.min(c.w - 1, Math.floor((x / W) * c.w));
        mask[y * W + x] = src[sy * c.w + sx] > 127 ? 1 : 0;
      }
    }
    out.push({ id: c.id, mask, score: c.score });
  }
  return out;
}
