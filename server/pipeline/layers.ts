import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import type { LayerPlan, PartMask } from "../types.js";

export interface LayerPng {
  partId: string;
  name: string;
  parent: string;
  kind: "fill" | "line" | "logo" | "stroke";
  pngPath: string;
  dominantColor: string; // #rrggbb — 파트 대표색
  area: number;
}

/**
 * 5단계 준비: 원본 기준 SAM 마스크 × 선택된 플랫 이미지 → 파트별 레이어 PNG.
 * - fill/logo 파트: color flat에서 마스크로 잘라낸 솔리드 영역
 * - Linework 레이어: line art 전체 (파트 경계선·스티치 포함)
 * 마스크는 원본 크기이므로 플랫 이미지 크기에 맞춰 리사이즈해서 적용한다.
 */
export async function extractLayerPngs(
  plan: LayerPlan,
  masks: PartMask[],
  colorFlatPath: string,
  lineArtPath: string,
  outDir: string,
  originalPath: string,
): Promise<{ layers: LayerPng[]; width: number; height: number }> {
  await fs.mkdir(outDir, { recursive: true });
  const meta = await sharp(originalPath).metadata();
  const W = meta.width!;
  const H = meta.height!;

  // 생성 모델이 구도를 바꿨을 수 있으므로 원본 실루엣 bbox에 정합시킨다
  const origBox = await fgBBox(originalPath);
  const flatBuf = await alignToBox(colorFlatPath, origBox, W, H);
  const lineBuf = await alignToBox(lineArtPath, origBox, W, H);
  const flatRaw = await sharp(flatBuf).removeAlpha().raw().toBuffer();

  const layers: LayerPng[] = [];

  for (const part of plan.parts) {
    if (part.kind === "line") continue; // 선 파트는 Linework 레이어에 포함
    const mask = masks.find((m) => m.partId === part.id);
    if (!mask || mask.area === 0) continue;

    let maskRaw: Buffer = await sharp(mask.maskPath)
      .resize(W, H, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();

    // 폴백 사각 마스크(gemini box)는 플랫의 솔리드 색으로 경계를 정제
    if (mask.source === "gemini") {
      const refined = await refineByColorRaw(flatRaw, maskRaw, W, H);
      if (refined) maskRaw = refined;
    }

    // 마스크를 알파 채널로 직접 결합해 파트 영역만 추출
    // (sharp dest-in은 그레이스케일 마스크를 알파로 취급하지 않음)
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      rgba[i * 4] = flatRaw[i * 3];
      rgba[i * 4 + 1] = flatRaw[i * 3 + 1];
      rgba[i * 4 + 2] = flatRaw[i * 3 + 2];
      rgba[i * 4 + 3] = maskRaw[i] > 127 ? 255 : 0;
    }
    const cut = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
      .png()
      .toBuffer();

    const dominantColor = await dominant(cut, W, H);
    const pngPath = path.join(outDir, `layer_${part.id}.png`);
    // 벡터화 입력용: 투명 → 흰 배경 위 솔리드 도형
    await sharp({
      create: { width: W, height: H, channels: 3, background: "#ffffff" },
    })
      .composite([{ input: cut }])
      .png()
      .toFile(pngPath);

    layers.push({
      partId: part.id,
      name: part.name,
      parent: part.parent,
      kind: part.kind,
      pngPath,
      dominantColor,
      area: mask.area,
    });
  }

  // Linework 레이어 (정합된 line art를 이진화)
  const linePath = path.join(outDir, "layer__linework.png");
  await sharp(lineBuf)
    .greyscale()
    .threshold(160)
    .png()
    .toFile(linePath);
  layers.push({
    partId: "__linework",
    name: "Linework",
    parent: "CONSTRUCTION",
    kind: "line",
    pngPath: linePath,
    dominantColor: "#111111",
    area: W * H,
  });

  return { layers, width: W, height: H };
}

/** 전경(비백색) bounding box — 루미넌스 기준 */
export async function fgBBox(
  imagePath: string | Buffer,
): Promise<{ x: number; y: number; w: number; h: number }> {
  const img = sharp(imagePath).flatten({ background: "#ffffff" }).greyscale();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[y * W + x] < 245) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: W, h: H };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * 후보 이미지를 원본 실루엣 bbox에 정합: 후보의 전경을 잘라
 * 원본 전경 bbox 크기로 리사이즈해 같은 위치에 배치한다.
 * (생성 모델이 구도/여백을 바꿔도 마스크·레이어 좌표계가 원본과 일치하게 됨)
 */
export async function alignToBox(
  imagePath: string,
  origBox: { x: number; y: number; w: number; h: number },
  W: number,
  H: number,
): Promise<Buffer> {
  const flatWhite = await sharp(imagePath).flatten({ background: "#ffffff" }).png().toBuffer();
  const candBox = await fgBBox(flatWhite);
  const content = await sharp(flatWhite)
    .extract({ left: candBox.x, top: candBox.y, width: candBox.w, height: candBox.h })
    .resize(origBox.w, origBox.h, { fit: "fill" })
    .png()
    .toBuffer();
  return sharp({
    create: { width: W, height: H, channels: 3, background: "#ffffff" },
  })
    .composite([{ input: content, left: origBox.x, top: origBox.y }])
    .png()
    .toBuffer();
}

/**
 * 사각 마스크 정제: 마스크 영역 안에서 플랫 이미지의 지배색을 찾고,
 * 그 색과 가까운 픽셀만 남긴다 (컬러 플랫은 파트당 단일 솔리드 색이므로
 * 이것이 사실상 파트의 정밀 경계가 된다). 지배색을 못 찾으면 null.
 */
async function refineByColorRaw(
  flat: Buffer, // raw RGB (W*H*3)
  m: Buffer, // raw grayscale (W*H)
  W: number,
  H: number,
): Promise<Buffer | null> {
  // 8×8×8 히스토그램으로 지배색 추정 (흰 배경·검은 윤곽선 제외)
  const bins = new Uint32Array(512);
  for (let i = 0; i < W * H; i++) {
    if (m[i] < 128) continue;
    const r = flat[i * 3], g = flat[i * 3 + 1], b = flat[i * 3 + 2];
    if (r > 245 && g > 245 && b > 245) continue; // background
    if (r < 40 && g < 40 && b < 40) continue; // outline
    bins[((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5)]++;
  }
  let bestBin = -1, bestCount = 0;
  for (let i = 0; i < 512; i++) if (bins[i] > bestCount) { bestCount = bins[i]; bestBin = i; }
  if (bestBin < 0 || bestCount < 50) return null;
  const dr = ((bestBin >> 6) << 5) + 16;
  const dg = (((bestBin >> 3) & 7) << 5) + 16;
  const db = ((bestBin & 7) << 5) + 16;

  const out = Buffer.alloc(W * H);
  const TH2 = 48 * 48; // 인접 파트 색(연회색 vs 크림)이 섞이지 않는 선
  for (let i = 0; i < W * H; i++) {
    if (m[i] < 128) continue;
    const r = flat[i * 3] - dr, g = flat[i * 3 + 1] - dg, b = flat[i * 3 + 2] - db;
    if (r * r + g * g + b * b <= TH2) out[i] = 255;
  }
  return out;
}

/** 알파가 있는 픽셀들의 평균색 → hex */
async function dominant(rgba: Buffer, W: number, H: number): Promise<string> {
  const { data } = await sharp(rgba)
    .resize(Math.min(W, 128), Math.min(H, 128), { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 200) {
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  if (!n) return "#cccccc";
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
