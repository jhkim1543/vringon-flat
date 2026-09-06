/**
 * **선화 도면 재합성** — 크기 정합 + 글자·로고 원본 이식.
 *
 * 선화 변형(`--lineart`)은 두 가지 드리프트를 실증했다(v6.8):
 *   ① 크기·배치 이동 — 선화 절이 LoRA 학습 분포를 벗어나며 모델이 재구도한다
 *     (실측 jewelry_1: 캔버스의 절반 크기로). 프롬프트의 프레이밍 절은 완화일 뿐
 *     보장이 아니므로, 여기서 **결정적으로** 바로잡는다: 표준 도면과 선화 도면의
 *     주체 박스를 맞춰 선화 도면을 표준 프레임으로 리샘플한다.
 *   ② 글자 뭉갬 — 생성이 글자를 다시 그리며 판독 불가로 만든다("ANTISM"→잡음).
 *     렌더샷과 같은 해법: 비전이 찾은 글자 상자 안을 **표준 도면의 잉크로 갈아**
 *     끼운다. 상자 안을 희게 지우고 표준 도면의 어두운 픽셀만 옮기므로, 표준
 *     도면의 회색 음영은 따라오지 않는다.
 *
 * ①을 먼저 하면 두 도면이 같은 프레임이 되어 ②의 상자 좌표(정규화)가 그대로 맞는다.
 */
import sharp from "sharp";
import { detectSubject, similarityFit } from "../v3/subject.js";
import { findLetterRegions } from "./letterDetect.js";

/**
 * 이 밝기 미만을 "글자 잉크"로 본다. 170(inkThreshold)으로 두면 표준 도면의 회색
 * 그라데이션 음영까지 걸려 검은 띠로 이식된다(실측 jewelry_1: 글자 아래 초승달꼴 띠).
 * 글자는 거의 순검정이므로 훨씬 조인다.
 */
const INK_TH = Number(process.env.V4_SPLICE_INK ?? 100);
/** 글자 상자 여유(px, 표준 도면 좌표) */
const PAD = Number(process.env.V4_SPLICE_PAD ?? 6);

export interface RecomposeResult {
  path: string;
  /** 적용한 크기 보정 배율 (1.0 = 보정 없음) */
  scaleFix: number;
  /** 이식한 글자 상자 수 */
  boxes: number;
}

/** 표준 도면 crop 에서 어두운 픽셀만 검정 RGBA 로 뜬다 (나머지는 투명) */
async function inkOnly(src: string, x: number, y: number, w: number, h: number): Promise<Buffer> {
  const { data, info } = await sharp(src)
    .flatten({ background: "#ffffff" }).removeAlpha()
    .extract({ left: x, top: y, width: w, height: h })
    .raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels, n = info.width * info.height;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * ch;
    const luma = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    if (luma < INK_TH) {
      out[i * 4] = data[p]; out[i * 4 + 1] = data[p + 1]; out[i * 4 + 2] = data[p + 2];
      out[i * 4 + 3] = 255;
    }
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

export async function lineartRecompose(
  lineartPng: string,
  standardPng: string,
  outPath: string,
  letterCacheDir: string,
  say?: (m: string) => void,
): Promise<RecomposeResult> {
  const stdMeta = await sharp(standardPng).metadata();
  const W = stdMeta.width!, H = stdMeta.height!;

  // ── ① 크기 정합: 선화 주체를 표준 주체 박스에 맞춘다 ────────────────
  const [stdSub, laSub] = await Promise.all([
    detectSubject(standardPng),
    detectSubject(lineartPng),
  ]);
  const fit = similarityFit(laSub.box, stdSub.box);
  const laMeta = await sharp(lineartPng).metadata();
  const sameFrame =
    laMeta.width === W && laMeta.height === H &&
    Math.abs(fit.scale - 1) < 0.02 &&
    Math.abs(fit.tx) < 4 && Math.abs(fit.ty) < 4;

  let base: sharp.Sharp;
  let scaleFix = 1;
  if (sameFrame) {
    // 이미 맞다 — 리샘플로 선을 무르게 만들지 않는다
    base = sharp(lineartPng).flatten({ background: "#ffffff" });
  } else {
    scaleFix = fit.scale;
    const sw = Math.max(1, Math.round(laMeta.width! * fit.scale));
    const sh = Math.max(1, Math.round(laMeta.height! * fit.scale));
    const scaled = await sharp(lineartPng)
      .flatten({ background: "#ffffff" }).removeAlpha()
      .resize(sw, sh, { kernel: "lanczos3" })
      .png().toBuffer();
    // 주체 중심을 표준 주체 중심에 놓는다
    const dx = Math.round(stdSub.box.x + stdSub.box.w / 2 - (laSub.box.x + laSub.box.w / 2) * fit.scale);
    const dy = Math.round(stdSub.box.y + stdSub.box.h / 2 - (laSub.box.y + laSub.box.h / 2) * fit.scale);
    const sx0 = Math.max(0, -dx), sy0 = Math.max(0, -dy);
    const tx0 = Math.max(0, dx), ty0 = Math.max(0, dy);
    const cw = Math.min(sw - sx0, W - tx0), chh = Math.min(sh - sy0, H - ty0);
    if (cw < 8 || chh < 8) throw new Error("선화 도면 정합 실패 — 주체가 겹치지 않는다");
    const piece = await sharp(scaled).extract({ left: sx0, top: sy0, width: cw, height: chh }).png().toBuffer();
    base = sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } })
      .composite([{ input: piece, left: tx0, top: ty0 }]);
    // composite 뒤에 다시 composite 를 얹으려면 한 번 구워야 한다
    base = sharp(await base.png().toBuffer());
  }

  // ── ② 글자 이식: 표준 도면의 글자 상자 잉크로 갈아 끼운다 ───────────
  const boxes = await findLetterRegions(standardPng, letterCacheDir, say);
  const ops: sharp.OverlayOptions[] = [];
  for (const [bx0, by0, bx1, by1] of boxes) {
    const x = Math.max(0, Math.floor(bx0 * W) - PAD);
    const y = Math.max(0, Math.floor(by0 * H) - PAD);
    const x1 = Math.min(W, Math.ceil(bx1 * W) + PAD);
    const y1 = Math.min(H, Math.ceil(by1 * H) + PAD);
    const w = x1 - x, h = y1 - y;
    if (w < 4 || h < 4) continue;
    const white = await sharp({ create: { width: w, height: h, channels: 3, background: "#ffffff" } })
      .png().toBuffer();
    ops.push({ input: white, left: x, top: y });
    ops.push({ input: await inkOnly(standardPng, x, y, w, h), left: x, top: y });
  }
  if (ops.length) base = base.composite(ops);

  await base.png().toFile(outPath);
  const parts: string[] = [];
  if (scaleFix !== 1) parts.push(`크기 보정 ×${scaleFix.toFixed(3)}`);
  parts.push(`글자 이식 ${ops.length / 2}곳`);
  say?.(`선화 재합성 — ${parts.join(" · ")}`);
  return { path: outPath, scaleFix, boxes: ops.length / 2 };
}
