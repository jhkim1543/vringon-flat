import sharp from "sharp";
import { sam3Concepts, sam3Instances } from "../clients/falClient.js";
import { config } from "../config.js";

/**
 * 입력 정규화 + 제품 격리.
 *
 * 파이프라인 전체가 "흰 배경 위 제품 한 점"을 가정하므로, 임의의 이미지를
 * 그 형태로 맞춰주는 것이 이 모듈의 역할이다. 실측으로 확인된 문제들:
 *
 *  · EXIF orientation: sharp는 자동 회전하지 않는다. 휴대폰 세로 사진이
 *    가로로 들어와 전 과정이 어긋난다 (.rotate()로 해결).
 *  · 비백색 배경: 배경이 회색이면 전경 bbox가 캔버스 전체가 되어 정합·
 *    색샘플링·QA가 모두 무의미해진다 (SAM 3로 제품만 오려서 해결).
 *  · 알파/CMYK/16bit/그레이스케일: sRGB 8bit 3채널로 통일.
 */

export interface PrepareResult {
  width: number;
  height: number;
  notes: string[];
}

const MAX_EDGE = 2048;

/** 임의 이미지 → 흰 배경 sRGB 8bit PNG */
export async function normalizeInput(buf: Buffer, destPath: string): Promise<PrepareResult> {
  const notes: string[] = [];

  let meta: sharp.Metadata;
  try {
    meta = await sharp(buf).metadata();
  } catch (e) {
    throw new Error(`이미지를 읽을 수 없습니다: ${(e as Error).message.slice(0, 120)}`);
  }
  if (!meta.width || !meta.height) throw new Error("이미지 크기를 확인할 수 없습니다");
  if (meta.pages && meta.pages > 1) notes.push(`애니메이션 ${meta.pages}프레임 → 첫 프레임 사용`);
  if (meta.orientation && meta.orientation !== 1) notes.push(`EXIF 회전 ${meta.orientation} 보정`);
  if (meta.space && meta.space !== "srgb") notes.push(`색공간 ${meta.space} → sRGB`);
  if (meta.hasAlpha) notes.push("투명 배경 → 흰색으로 합성");

  // 극단적 종횡비는 파트 분해가 무의미해진다
  const ratio = Math.max(meta.width / meta.height, meta.height / meta.width);
  if (ratio > 6) throw new Error(`종횡비가 너무 극단적입니다 (${ratio.toFixed(1)}:1)`);

  const out = await sharp(buf, { animated: false })
    .rotate() // EXIF orientation 적용
    .flatten({ background: "#ffffff" }) // 알파 → 흰 배경
    .toColourspace("srgb")
    .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .png()
    .toFile(destPath);

  if (Math.max(meta.width, meta.height) > MAX_EDGE)
    notes.push(`${meta.width}x${meta.height} → ${out.width}x${out.height} 축소`);

  return { width: out.width, height: out.height, notes };
}

/** 테두리 픽셀로 배경이 이미 흰색인지 판정 */
export async function backgroundWhiteness(imagePath: string): Promise<number> {
  const S = 128;
  const { data, info } = await sharp(imagePath)
    .resize(S, S, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let white = 0, total = 0;
  const check = (x: number, y: number) => {
    total++;
    if (data[(y * S + x) * ch] > 240) white++;
  };
  for (let x = 0; x < S; x++) { check(x, 0); check(x, S - 1); }
  for (let y = 1; y < S - 1; y++) { check(0, y); check(S - 1, y); }
  return white / total;
}

/**
 * 흰 배경 위 제품을 bbox + 여백으로 크롭한다.
 *
 * 제품이 화면에서 작으면(원거리 촬영, 여백 큰 카탈로그 컷) 640px 작업
 * 해상도에서 파트가 뭉개져 색·경계가 무너진다. 실측: 제품이 화면 14%일 때
 * 벡터 색이 전부 어긋났다. 크롭하면 같은 파이프라인이 제품에 full 해상도를
 * 쓰게 되어 이 문제가 사라진다.
 */
export async function cropToSubject(
  srcPath: string,
  destPath: string,
): Promise<{ cropped: boolean; note: string }> {
  const meta = await sharp(srcPath).metadata();
  const W = meta.width!, H = meta.height!;
  const { data, info } = await sharp(srcPath)
    .flatten({ background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;

  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * ch] < 245) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    await sharp(srcPath).png().toFile(destPath);
    return { cropped: false, note: "전경을 찾지 못함 — 크롭 생략" };
  }

  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const fill = (bw * bh) / (W * H);
  if (fill > 0.55) {
    await sharp(srcPath).png().toFile(destPath);
    return { cropped: false, note: "" };
  }

  const pad = Math.round(Math.max(bw, bh) * 0.06);
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const width = Math.min(W - left, bw + pad * 2);
  const height = Math.min(H - top, bh + pad * 2);

  await sharp(srcPath)
    .extract({ left, top, width, height })
    .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .png()
    .toFile(destPath);

  return {
    cropped: true,
    note: `제품 크롭 ${W}x${H} → ${width}x${height} (화면 점유 ${(fill * 100).toFixed(0)}% → ~88%)`,
  };
}

/**
 * SAM 3이 인식할 가능성이 높은 일반 명사.
 *
 * **카테고리별로 순서를 다르게** 둔다. 공용 목록 하나만 쓰면 엉뚱한 순서로
 * 시도하다 정답에 도달하지 못한다 — 실측: 금반지를 GPT가 "brooch"로 불렀고
 * SAM 3은 그 단어를 모르는데, 폴백이 [shoe, bag, watch, ring...] 순이라
 * 앞 4개만 시도하는 사이 정답인 "ring"이 잘려 배경 제거가 통째로 실패했다.
 */
const FALLBACK_BY_CATEGORY: Record<string, string[]> = {
  footwear: ["shoe", "sneaker", "boot", "sandal"],
  bag: ["bag", "handbag", "backpack", "purse", "suitcase"],
  jewelry: ["ring", "earring", "necklace", "bracelet", "jewelry", "watch"],
  watch: ["watch", "clock", "bracelet"],
  eyewear: ["glasses", "sunglasses"],
  apparel: ["shirt", "jacket", "dress", "clothing"],
  headwear: ["hat", "cap", "helmet"],
  furniture: ["chair", "table", "sofa", "lamp"],
  electronics: ["laptop", "phone", "camera", "headphones"],
  packaging: ["bottle", "box", "can", "jar"],
};
const GENERIC_NOUNS = ["object", "product"];

/**
 * 배경이 흰색이 아니면 SAM 3으로 제품만 오려 흰 배경에 올린다.
 * SAM 3이 실패하면 원본을 그대로 두고 사유를 note로 남긴다(작업 중단 없음).
 */
export async function isolateProduct(
  srcPath: string,
  destPath: string,
  objectNoun: string,
  category = "other",
): Promise<{ isolated: boolean; note: string }> {
  // 테두리 흰색도만 보고 격리를 건너뛰면 안 된다. 흰 배경 사진이라도 제품
  // 아래에 반사판·그림자·받침대가 있으면 테두리는 희지만 화면 중앙에 배경이
  // 남는다(실측: 반사판 위 은반지가 "배경 흰색"으로 판정돼 반사가 그대로
  // 들어갔다). SAM 3이 있으면 항상 시도하고, 유효한 마스크가 없을 때만
  // 원본을 그대로 쓴다 — 호출 비용은 요청당 $0.005 수준이다.
  if (!config.hasSam3) {
    const whiteness = await backgroundWhiteness(srcPath);
    if (whiteness > 0.9) {
      await sharp(srcPath).png().toFile(destPath);
      return { isolated: false, note: "배경이 이미 흰색 — 격리 생략" };
    }
    await sharp(srcPath).png().toFile(destPath);
    return { isolated: false, note: "FAL_KEY 없음 — 배경 격리 불가" };
  }

  const meta = await sharp(srcPath).metadata();
  const W = meta.width!, H = meta.height!;
  // GPT가 준 명사 → 해당 카테고리 어휘 → 범용 순서. 중복은 제거한다.
  const ordered = [
    objectNoun,
    ...(FALLBACK_BY_CATEGORY[category] ?? []),
    ...GENERIC_NOUNS,
  ];
  const tried = [...new Set(ordered.filter(Boolean))];

  for (const noun of tried.slice(0, 6)) {
    // 같은 개념의 **모든 인스턴스**를 남긴다.
    // 마스크 1개만 쓰면 링 3개 중 1개만 남고 나머지는 배경으로 지워져,
    // 뒤따르는 인스턴스 분리 단계가 "1개"만 보게 된다(실측: jewelry_3·shoe_2
    // 모두 "인스턴스 1개 — 분리 생략"). 복수 객체 대응의 전제가 여기서 깨졌다.
    let found;
    try {
      found = await sam3Instances(srcPath, noun, 6);
    } catch {
      continue;
    }
    if (!found.length) continue;

    // 인스턴스 마스크 합집합 (원본 크기 이진)
    const union = new Uint8Array(W * H);
    let kept = 0;
    for (const inst of found) {
      const m = await sharp(inst.maskPng)
        .flatten({ background: "#000000" })
        .resize(W, H, { fit: "fill" })
        .greyscale()
        .threshold(127)
        .raw()
        .toBuffer({ resolveWithObject: true });
      let on = 0;
      for (let i = 0; i < W * H; i++) if (m.data[i * m.info.channels] > 127) on++;
      const cover = on / (W * H);
      // 너무 작으면 오검출, 너무 크면 배경까지 포함
      if (cover < 0.005 || cover > 0.95) continue;
      for (let i = 0; i < W * H; i++) if (m.data[i * m.info.channels] > 127) union[i] = 1;
      kept++;
    }
    let total = 0;
    for (let i = 0; i < W * H; i++) total += union[i];
    const cover = total / (W * H);
    if (!kept || cover < 0.03 || cover > 0.95) continue;

    const src = await sharp(srcPath).removeAlpha().raw().toBuffer();
    const rgb = Buffer.alloc(W * H * 3, 255);
    for (let i = 0; i < W * H; i++) {
      if (union[i]) {
        rgb[i * 3] = src[i * 3];
        rgb[i * 3 + 1] = src[i * 3 + 1];
        rgb[i * 3 + 2] = src[i * 3 + 2];
      }
    }
    await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toFile(destPath);
    return {
      isolated: true,
      note:
        `배경 제거 (SAM 3 "${noun}" ${kept}개 인스턴스, 최고점 ${found[0].score.toFixed(2)}, ` +
        `면적 ${(cover * 100).toFixed(0)}%)`,
    };
  }

  await sharp(srcPath).png().toFile(destPath);
  return { isolated: false, note: "SAM 3이 제품을 찾지 못함 — 원본 그대로 진행" };
}
