import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { sam3Instances } from "../clients/falClient.js";

/**
 * 복수 객체 입력 대응 — 인스턴스 분리.
 *
 * 파이프라인 전체가 "제품 한 점"을 전제한다. 한 화면에 신발 2개·링 3개가
 * 있으면 Layer Plan의 파트 이름이 중복돼 배정이 깨지고, 선F1이 63~74%로
 * 떨어졌다(실측: shoe_3, jewelry_3). SAM 3의 다중 마스크로 인스턴스를
 * 나누고 각각을 독립 이미지로 잘라 파이프라인에 넣는다.
 *
 * 인스턴스별로 "흰 배경 위 제품 한 점" 이미지를 만든다. 겹치는 부분은
 * 점수가 높은 인스턴스가 가져간다(뒤에 있는 객체는 가려진 상태 그대로 —
 * amodal 복원은 Qwen 단계가 담당).
 */

export interface InstanceCrop {
  index: number;
  imagePath: string; // 흰 배경 위 인스턴스 하나
  score: number;
  /** 원본 좌표계에서의 위치 (합칠 때 사용) */
  bbox: { x: number; y: number; w: number; h: number };
  areaFrac: number;
}

export interface SplitResult {
  instances: InstanceCrop[];
  note: string;
}

/**
 * @param srcPath  정규화된 입력(배경은 이미 흰색이거나 격리됨)
 * @param noun     SAM 3에 줄 일반 명사 (plan.objectNoun)
 */
export async function splitInstances(
  srcPath: string,
  outDir: string,
  noun: string,
): Promise<SplitResult> {
  await fs.mkdir(outDir, { recursive: true });
  const meta = await sharp(srcPath).metadata();
  const W = meta.width!, H = meta.height!;
  const single = (note: string): SplitResult => ({
    instances: [{ index: 0, imagePath: srcPath, score: 1, bbox: { x: 0, y: 0, w: W, h: H }, areaFrac: 1 }],
    note,
  });

  const found = await sam3Instances(srcPath, noun, 6);
  if (found.length < 2) return single(found.length ? "인스턴스 1개 — 분리 생략" : "SAM 3 인스턴스 없음 — 단일로 진행");

  // 마스크를 원본 크기 이진으로
  const masks: Uint8Array[] = [];
  for (const f of found) {
    const { data, info } = await sharp(f.maskPng)
      .flatten({ background: "#000000" })
      .resize(W, H, { fit: "fill" })
      .greyscale()
      .threshold(127)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const m = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) m[i] = data[i * info.channels] > 127 ? 1 : 0;
    masks.push(m);
  }

  // 인스턴스 유효성 — 너무 작거나(오검출), 다른 인스턴스에 거의 포함되면(중복) 버린다
  const areas = masks.map((m) => m.reduce((a, v) => a + v, 0));
  const keep: number[] = [];
  for (let i = 0; i < masks.length; i++) {
    if (areas[i] < W * H * 0.005) continue;
    let dup = false;
    for (const k of keep) {
      let inter = 0;
      for (let p = 0; p < W * H; p++) if (masks[i][p] && masks[k][p]) inter++;
      if (inter > areas[i] * 0.8) { dup = true; break; }
    }
    if (!dup) keep.push(i);
  }
  if (keep.length < 2) return single(`유효 인스턴스 ${keep.length}개 — 단일로 진행`);

  // 겹침 해소: 점수 높은 순으로 픽셀 소유권 배정 (keep은 이미 점수순)
  const owner = new Int16Array(W * H).fill(-1);
  for (const k of keep) for (let p = 0; p < W * H; p++) if (masks[k][p] && owner[p] < 0) owner[p] = k;

  const src = await sharp(srcPath).removeAlpha().raw().toBuffer();
  const out: InstanceCrop[] = [];
  for (let n = 0; n < keep.length; n++) {
    const k = keep[n];
    let minX = W, minY = H, maxX = -1, maxY = -1;
    const rgb = Buffer.alloc(W * H * 3, 255);
    for (let p = 0; p < W * H; p++) {
      if (owner[p] !== k) continue;
      rgb[p * 3] = src[p * 3]; rgb[p * 3 + 1] = src[p * 3 + 1]; rgb[p * 3 + 2] = src[p * 3 + 2];
      const x = p % W, y = (p / W) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (maxX < 0) continue;
    const dest = path.join(outDir, `instance_${n}.png`);
    await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toFile(dest);
    out.push({
      index: n,
      imagePath: dest,
      score: found[k].score,
      bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      areaFrac: areas[k] / (W * H),
    });
  }
  return {
    instances: out,
    note: `SAM 3 "${noun}" 인스턴스 ${out.length}개 분리 (점수 ${out.map((i) => i.score.toFixed(2)).join("/")})`,
  };
}
