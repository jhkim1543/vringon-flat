import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { qwenLayered, sam3Concepts } from "../clients/falClient.js";
import { nameComponents } from "../clients/openaiClient.js";
import { assignByRules } from "./nameRules.js";
import { alignToBox, fgBBox, type LayerPng } from "./layers.js";
import type { LayerPlan } from "../types.js";

/**
 * 레이어 분해 (Qwen amodal + 연결요소 분리 + GPT 명명 + SAM 3 보정).
 *
 * 각 도구를 실측된 능력 범위 안에서만 쓴다:
 *  · Qwen   — 가려진 영역까지 복원한 재질 단위 레이어 (파트 이름은 모름)
 *  · 연결요소 — 같은 재질이 떨어져 있으면 별개 파트 (토캡 vs 힐카운터)
 *  · GPT-5.6 — 각 조각에 Layer Plan의 파트 이름 배정
 *  · SAM 3  — 인식 가능한 일반 명사(sole/shoelace/tongue)로 경계 보정
 *
 * Qwen 출력은 640px이므로 픽셀이 아니라 "형상"으로만 쓰고, 색은 고해상 플랫에서
 * 샘플링한다. 결과 레이어는 원본 해상도의 솔리드 도형이다.
 */

/**
 * SAM 3 경계 보정에 쓸 개념. 단일 일반 명사만 인식하므로(실측: shoe .98 /
 * vamp 0개) 카테고리별로 "모델이 알 법한 흔한 명사"만 넣는다.
 * 목록에 없는 카테고리는 보정을 생략한다 — 없어도 파이프라인은 동작한다.
 */
const SAM3_VOCAB: Record<string, string[]> = {
  footwear: ["sole", "shoelace", "tongue"],
  bag: ["handle", "strap", "zipper", "buckle"],
  jewelry: ["gemstone", "ring"],
  apparel: ["sleeve", "collar", "button", "pocket"],
  eyewear: ["lens"],
  watch: ["strap", "dial"],
  headwear: ["brim"],
  furniture: ["leg", "cushion"],
  electronics: ["screen", "button"],
  packaging: ["label", "cap"],
  other: [],
};

/**
 * 라벨링 작업 해상도 — 긴 변 기준. 종횡비는 입력을 따른다.
 * 640이었을 때 폭 2~3px 파트(금속 프레임·체인)가 마스크 단계에서 소실됐다
 * (실측: bag_2 프레임 통째 소실). 1024로 올려 얇은 파트가 살아남게 한다.
 */
const WORK_LONG = 1024;

export interface DecomposeResult {
  layers: LayerPng[];
  width: number;
  height: number;
  engine: string;
  stats: { qwenLayers: number; components: number; named: number; sam3: number };
}

interface Comp {
  mask: Uint8Array; // wkW×wkH
  area: number;
  cx: number; // 0~1 정규화 중심
  cy: number;
  color: string;
  qwenIndex: number;
}

/** 전체 해상도 레이어 후보 — 스냅·잔차 회수·스트로크 판정을 거쳐 LayerPng가 된다 */
interface PendingLayer {
  mask: Uint8Array; // W×H
  color: string;
  partId: string;
  name: string;
  parent: string;
  kind: "fill" | "line" | "logo" | "stroke";
  area: number;
  /** 작은 조각 여럿(스톤·아일릿)을 묶은 레이어 — 가는 파트 판정에서 제외 */
  repeated?: boolean;
}

export async function decomposeLayers(
  plan: LayerPlan,
  colorFlatPath: string,
  lineArtPath: string,
  originalPath: string,
  outDir: string,
  onProgress?: (msg: string) => void,
): Promise<DecomposeResult> {
  await fs.mkdir(outDir, { recursive: true });
  // 이전 실행의 레이어 PNG를 지운다 — 남겨 두면 재빌드 후 디렉터리에 현재 결과와
  // 옛 결과가 섞여 내보내기·진단이 오염된다(실측: 옛 pink_heel_counter_2가 남아
  // "덮였다/안 덮였다" 판단을 틀리게 함).
  for (const f of await fs.readdir(outDir)) {
    if (f.startsWith("layer_") && f.endsWith(".png")) await fs.unlink(path.join(outDir, f)).catch(() => {});
  }
  const meta = await sharp(originalPath).metadata();
  const W = meta.width!;
  const H = meta.height!;

  // 생성 모델이 구도를 바꿨을 수 있으므로 원본 실루엣에 정합
  const origBox = await fgBBox(originalPath);
  const flatBuf = await alignToBox(colorFlatPath, origBox, W, H);
  const lineBuf = await alignToBox(lineArtPath, origBox, W, H);


  const alignedFlat = path.join(outDir, "_aligned_flat.png");
  await fs.writeFile(alignedFlat, flatBuf);

  // 작업 해상도는 입력 종횡비를 따른다. Qwen도 종횡비를 보존하므로
  // (실측: 1200x600 → 896x448) 정사각으로 강제하면 가는 형상이 찌그러진다.
  const scale = WORK_LONG / Math.max(W, H);
  const wkW = Math.max(64, Math.round(W * scale));
  const wkH = Math.max(64, Math.round(H * scale));

  // ── 1) Qwen amodal 분해 ──────────────────────────────────
  // LayerPeeler(SIGGRAPH Asia 2025)의 사상: 최상단 오버레이부터 바닥 몸체
  // 순서로 벗겨내듯 분해하라고 명시하면 레이어 경계가 더 깨끗해진다.
  const caption =
    `flat technical drawing of a ${plan.category} product with parts: ` +
    plan.parts.map((p) => p.name).join(", ") +
    `. Decompose in peeling order: topmost small overlay elements first ` +
    `(logos, stitching, small trims), then mid-level panels, then the base body last. ` +
    `One distinct part per layer with complete amodal shape.`;
  const nLayers = Math.min(12, Math.max(4, plan.parts.length));
  // 캐시: 재빌드 시 Qwen 재호출(과금) 없이 튜닝할 수 있게 원본 레이어를 보관
  const qwen = await cachedQwen(path.join(outDir, "_qwen"), alignedFlat, nLayers, caption);
  onProgress?.(`Qwen ${qwen.length} layers`);

  // 배경(거의 전면)·노이즈(거의 없음) 레이어 제거
  const useful = qwen.filter((l) => l.coverage < 0.85 && l.coverage > 0.004);

  // ── 2) 레이어별 연결요소 분리 ─────────────────────────────
  const comps: Comp[] = [];
  const CANVAS = wkW * wkH;
  // 캔버스 절반을 넘는 조각은 "물체 통째" 레이어라 파트가 아니다.
  const MAX_COMP = CANVAS * 0.5;
  const MIN_COMP = CANVAS * 0.0025;
  for (const layer of useful) {
    const { data: rgba, info } = await sharp(layer.rgbaPng)
      .ensureAlpha()
      .resize(wkW, wkH, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alpha = new Uint8Array(CANVAS);
    for (let i = 0; i < CANVAS; i++) alpha[i] = rgba[i * info.channels + 3] > 100 ? 1 : 0;

    // 배경 판정은 밝기가 아니라 테두리 연결성으로 (흰 제품 파트 보호)
    const bg = backgroundMask(rgba, info.channels, wkW, wkH);

    // 한 Qwen 레이어 안에도 서로 다른 재질이 섞여 있고, 맞닿아 있으면 연결요소
    // 하나로 뭉친다(실측: 빨간 스트라이프가 네이비 아이스테이에 흡수됨).
    // 그래서 색 클러스터로 먼저 나눈 뒤 각 색 안에서 연결요소를 찾는다.
    for (const cluster of colorClusters(rgba, info.channels, alpha, 8, bg)) {
      for (const c of connectedComponents(cluster.mask, wkW, wkH, MIN_COMP)) {
        if (c.area > MAX_COMP) continue;
        // 색은 클러스터 중심(양자화된 근사값)이 아니라 조각 안 실제 픽셀의
        // 평균으로 정한다. 단색·어두운 제품에서 중심값을 쓰면 5비트 양자화
        // 오차가 그대로 남아 검정이 올리브·남색으로 틀어진다(실측).
        comps.push({
          ...c,
          color: meanColor(rgba, info.channels, c.mask, bg),
          qwenIndex: layer.index,
        });
      }
    }
  }

  // Qwen이 쓸 만한 레이어를 못 내놓는 입력도 있다(단색 제품, 이례적 구도 등).
  // 그럴 때 작업을 중단하지 않고 플랫 이미지 자체를 색으로 분해한다.
  // amodal 복원은 없지만 레이어가 있는 .ai는 나온다.
  let fallbackNote = "";
  if (!comps.length) {
    const { data: rgba, info } = await sharp(flatBuf)
      .ensureAlpha()
      .resize(wkW, wkH, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const fg = new Uint8Array(CANVAS);
    for (let i = 0; i < CANVAS; i++) {
      const p = i * info.channels;
      fg[i] = rgba[p] > 245 && rgba[p + 1] > 245 && rgba[p + 2] > 245 ? 0 : 1;
    }
    for (const cluster of colorClusters(rgba, info.channels, fg, 8)) {
      for (const c of connectedComponents(cluster.mask, wkW, wkH, MIN_COMP)) {
        if (c.area > MAX_COMP) continue;
        comps.push({ ...c, color: cluster.hex, qwenIndex: -1 });
      }
    }
    fallbackNote = " (Qwen 결과 없음 → 플랫 색분해 폴백, amodal 없음)";
    onProgress?.("Qwen 분해가 비어 플랫 색분해로 폴백");
  }
  if (!comps.length) throw new Error("레이어 분해 실패: 유효한 조각이 없습니다");

  let baseMask: Uint8Array | null = null;
  let baseColor = "#cccccc";

  // 작업 해상도 플랫 — 커버리지 안전망·가시색 계산·앞뒤 판정에 공용
  const { data: frgba, info: finfo } = await sharp(flatBuf)
    .ensureAlpha()
    .resize(wkW, wkH, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  // 전경 판정도 테두리 연결성 기준 (흰 제품 파트를 배경으로 오인하지 않게)
  const flatBg = backgroundMask(frgba, finfo.channels, wkW, wkH);

  // ── 커버리지 안전망 ──────────────────────────────────────
  // Qwen 레이어가 제품을 전부 담아 주지 않는 입력이 있다. 단색 제품에서 특히
  // 심했다(실측: 주얼리에서 조각 합집합이 플랫의 66%만 덮어 테두리·힌지가
  // 통째로 누락). 플랫 전경 중 어떤 조각도 덮지 못한 영역을 회수해 베이스
  // 파트로 되돌린다 — 테크팩에는 원래 베이스 몸통 레이어가 있어야 한다.
  {
    const fg = new Uint8Array(CANVAS);
    let fgN = 0;
    for (let i = 0; i < CANVAS; i++) if (!flatBg[i]) { fg[i] = 1; fgN++; }
    // 회수 범위는 원본 실루엣 안으로 제한한다. 플랫은 제품을 약간 크게
    // 그리는 경향이 있어(실측: 전경 42% → 48%), 제한 없이 회수하면 제품
    // 바깥으로 번져 배경 침범(spill)이 늘어난다.
    const { data: orgb, info: oinfo } = await sharp(originalPath)
      .flatten({ background: "#ffffff" })
      .resize(wkW, wkH, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const inSil = new Uint8Array(CANVAS);
    for (let i = 0; i < CANVAS; i++) inSil[i] = orgb[i * oinfo.channels] < 248 ? 1 : 0;
    // 팽창하지 않는다 — 조금만 키워도 베이스가 제품 밖으로 번져
    // 배경 침범(spill)이 9.9%까지 올라간다(실측).

    const covered = new Uint8Array(CANVAS);
    for (const c of comps) for (let i = 0; i < CANVAS; i++) if (c.mask[i]) covered[i] = 1;
    const gap = new Uint8Array(CANVAS);
    let gapN = 0;
    for (let i = 0; i < CANVAS; i++) if (fg[i] && inSil[i] && !covered[i]) { gap[i] = 1; gapN++; }

    if (fgN && gapN > fgN * 0.08) {
      // 조각으로 주입하면 중복제거 순서를 흔들어 기존 파트를 밀어낸다
      // (실측: coverage 0.815 → 0.524). 그래서 맨 아래 깔리는 단일 베이스
      // 레이어로 따로 만든다 — 다른 파트는 그 위에 얹힌다.
      baseMask = new Uint8Array(CANVAS);
      for (let i = 0; i < CANVAS; i++) if (fg[i] && inSil[i]) baseMask[i] = 1;
      // 베이스 색 = 미포함 영역의 평균색. 배경은 테두리 연결성으로 판정하므로
      // 흰 제품(은반지·흰 운동화)의 밝은 면도 색 계산에 정상 반영된다.
      // 베이스 색은 gap이 아니라 제품 전체 영역의 최빈색으로 정한다.
      // gap만 보면 어두운 가장자리에 치우친다.
      baseColor = meanColor(frgba, finfo.channels, baseMask, flatBg);
      onProgress?.(
        `커버리지 안전망: 미포함 ${((100 * gapN) / fgN).toFixed(0)}% → 베이스 레이어 추가`,
      );
    }
  }

  // Qwen 레이어들은 분할(partition)이 아니라 겹쳐 쌓인 스택이다.
  //
  // 여기서 "겹침"을 전부 제거하면 안 된다 — 테크팩 레이어는 원래 겹친다.
  // 베이스 몸통 위에 오버레이 파트가 올라가는 게 정상 구조이고, 포함 관계를
  // 지워버리면 몸통이 사라져 원본을 복원하지 못한다 (실측: coverage 41%).
  //
  // 진짜 결함은 "같은 형상이 두 번" 나오는 것뿐이므로 IoU로만 판정한다.
  // 작은 것부터 담아 구체적인 파트를 우선 확보한다.
  const deduped: Comp[] = [];
  for (const c of [...comps].sort((a, b) => a.area - b.area)) {
    if (deduped.some((k) => iou(c.mask, k.mask) > 0.75)) continue;
    deduped.push(c);
  }
  // 배열 순서 = 페인팅 순서(아래→위). 큰 것이 아래, 작은 오버레이가 위.
  deduped.sort((a, b) => b.area - a.area);

  // 배경 조각 제거 — Qwen이 가끔 거의 흰 큰 사각형을 레이어로 내놓는다(실측:
  // bag_2 캔버스 49% 흰 직사각형). 그대로 두면 이름 규칙에 "Front Panel"로 걸리고
  // 진짜 몸통을 흡수해 체인까지 삼킨다. 플랫에서 배경인 픽셀이 과반이면 버린다.
  {
    const before = deduped.length;
    const keep = deduped.filter((c) => {
      let bgN = 0;
      for (let p = 0; p < CANVAS; p++) if (c.mask[p] && flatBg[p]) bgN++;
      return bgN < c.area * 0.5;
    });
    if (keep.length < before) {
      deduped.length = 0;
      deduped.push(...keep);
      onProgress?.(`배경 조각 ${before - keep.length}개 제거`);
    }
  }

  // 음영 조각 제거 — 큰 파트 안에 들어 있으면서 색이 그 파트와 거의 같은
  // 작은 조각은 재질 경계가 아니라 명암이다. 남겨 두면 도면에 반점으로
  // 찍힌다(실측: 검정 신발 갑피의 갈색 반점).
  {
    const before = deduped.length;
    const keep = deduped.filter((c, i) => {
      if (c.area > CANVAS * 0.01) return true;
      for (let j = 0; j < deduped.length; j++) {
        if (j === i) continue;
        const big = deduped[j];
        if (big.area < c.area * 4) continue;
        let inside = 0;
        for (let p = 0; p < c.mask.length; p++) if (c.mask[p] && big.mask[p]) inside++;
        if (inside < c.area * 0.7) continue;
        if (colorDist(c.color, big.color) < 60) return false; // 음영
      }
      return true;
    });
    if (keep.length < before) {
      deduped.length = 0;
      deduped.push(...keep);
      onProgress?.(`음영 조각 ${before - keep.length}개 제거`);
    }
  }
  onProgress?.(`components ${deduped.length} (중복 제거 전 ${comps.length})`);

  // ── 2-b) 조각의 "보이는 색" ─────────────────────────────────
  //
  // Qwen 조각의 색은 Qwen이 칠한 색이다. amodal 몸통 레이어는 진짜 색이 아니라
  // 연한 회색 실루엣으로 나오는 일이 잦다(실측: shoe_1 몸통 #d4d6d9). 그 색으로
  // 이름을 정하고 스냅 경쟁을 시키면 흰 조각과 헷갈려 검정 갑피가 흰 이름을
  // 물려받는다. 그래서 **플랫에서 실제로 보이는 색**을 따로 구한다: 작은 조각이
  // 위에 오도록 소유권을 칠한 뒤, 각 조각이 소유한 픽셀의 최빈색이다.
  // 완전히 가려진 조각(보이는 픽셀 없음)만 Qwen 색을 그대로 쓴다.
  const visColor: string[] = [];
  {
    const owner = new Int16Array(CANVAS).fill(-1);
    // deduped는 면적 내림차순 → 뒤(작은 것)가 위에 오도록 역순으로 먼저 칠한다
    for (let i = deduped.length - 1; i >= 0; i--) {
      const m = deduped[i].mask;
      for (let p = 0; p < CANVAS; p++) if (m[p] && owner[p] < 0) owner[p] = i;
    }
    const own = new Uint8Array(CANVAS);
    for (let i = 0; i < deduped.length; i++) {
      let n = 0;
      own.fill(0);
      for (let p = 0; p < CANVAS; p++) if (owner[p] === i && !flatBg[p]) { own[p] = 1; n++; }
      // 거의 다 가려진 조각은 보이는 몇 픽셀이 윤곽선일 수 있어 Qwen 색을 유지
      visColor.push(
        n >= Math.max(60, deduped[i].area * 0.1) ? meanColor(frgba, finfo.channels, own, flatBg) : deduped[i].color,
      );
    }
  }

  // ── 3) SAM 3 보정 (인식 가능한 개념만) ────────────────────
  // 명명보다 먼저 돈다 — 신발은 텅/끈 위치로 앞뒤 방향을 알아내야 힐/토 규칙을
  // 쓸 수 있다(측면뷰는 좌우 어느 쪽을 볼지 정해져 있지 않다).
  const vocab = SAM3_VOCAB[plan.category] ?? [];
  let sam3Count = 0;
  const sam3Masks = new Map<string, Uint8Array>();
  if (vocab.length) {
    try {
      const found = await sam3Concepts(alignedFlat, vocab);
      for (const m of found) {
        sam3Masks.set(m.concept, await alphaFromWhite(m.maskPng, wkW, wkH));
        sam3Count++;
      }
      onProgress?.(`SAM3 ${found.map((f) => f.concept).join(", ") || "none"}`);
    } catch (e) {
      onProgress?.(`SAM3 건너뜀: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  let heelSide: "left" | "right" | undefined;
  if (plan.category === "footwear") {
    // 1차 단서: 실루엣 양 끝의 높이. 뒤꿈치 쪽은 힐카운터·칼라가 서 있어 높고,
    // 앞코 쪽은 낮게 빠진다(운동화·구두·부츠 공통). 양 끝 12% 폭에서 전경의
    // 세로 범위를 재서 낮은 쪽을 앞코로 본다.
    let minX = wkW, maxX = -1;
    for (let p = 0; p < CANVAS; p++) if (!flatBg[p]) { const x = p % wkW; if (x < minX) minX = x; if (x > maxX) maxX = x; }
    const span = maxX - minX;
    const tipH = (x0: number, x1: number) => {
      let top = wkH, bot = -1;
      for (let y = 0; y < wkH; y++)
        for (let x = x0; x <= x1; x++) if (!flatBg[y * wkW + x]) { if (y < top) top = y; if (y > bot) bot = y; }
      return bot - top;
    };
    if (span > 32) {
      const w = Math.max(4, Math.round(span * 0.12));
      const hl = tipH(minX, minX + w), hr = tipH(maxX - w, maxX);
      if (hl > hr * 1.25) heelSide = "left";
      else if (hr > hl * 1.25) heelSide = "right";
      if (process.env.VF_DEBUG) onProgress?.(`  끝 높이 좌=${hl} 우=${hr}`);
    }
    // 2차 단서: 텅·끈은 발등(앞쪽)에 있다 — 1차가 애매할 때만
    const ref = sam3Masks.get("tongue") ?? sam3Masks.get("shoelace");
    if (!heelSide && ref) {
      let sx = 0, sn = 0, fx = 0, fn = 0;
      for (let p = 0; p < CANVAS; p++) {
        const x = p % wkW;
        if (ref[p]) { sx += x; sn++; }
        if (!flatBg[p]) { fx += x; fn++; }
      }
      if (sn > 50 && fn > 0) {
        const dx = sx / sn - fx / fn;
        if (Math.abs(dx) > wkW * 0.03) heelSide = dx > 0 ? "left" : "right";
        if (process.env.VF_DEBUG)
          onProgress?.(`  텅/끈 중심 x=${(sx / sn / wkW).toFixed(2)} 제품 중심 x=${(fx / fn / wkW).toFixed(2)} (${sn}px)`);
      }
    }
    onProgress?.(`앞뒤 판정: 뒤꿈치 ${heelSide ?? "미상"}`);
  }

  // ── 4) 조각에 파트 이름 배정 — GPT 비전 + 규칙 폴백 ────────
  //
  // GPT 명명은 실행마다 흔들리고 크레딧이 소진되면 전부 실패한다(실측:
  // named 0/44). 규칙 기반(위치·크기·색)을 항상 함께 돌려, GPT가 실패한
  // 조각을 채우고 GPT가 없어도 의미 있는 이름이 나오게 한다.
  const sheetPath = path.join(outDir, "_components.png");
  await buildContactSheet(deduped.map((c) => c.mask), wkW, wkH, sheetPath);
  // 리본 근사 폭(2·면적/둘레) — 체인·끈처럼 가는 조각을 규칙이 구분할 수 있게
  const thinLimitWk = Math.max(3, Math.min(wkW, wkH) * 0.016);
  const geoms = deduped.map((c, i) => ({
    index: i,
    areaPct: +((100 * c.area) / CANVAS).toFixed(1),
    cx: +c.cx.toFixed(2),
    cy: +c.cy.toFixed(2),
    color: visColor[i],
    thin: ribbonWidthOf(c.mask, wkW, wkH) < thinLimitWk,
  }));
  let assignments: { index: number; partId: string }[] = [];
  let gptOk = false;
  try {
    assignments = await nameComponents(sheetPath, plan, geoms);
    gptOk = true;
  } catch (e) {
    onProgress?.(`GPT 명명 실패 → 규칙 명명으로: ${(e as Error).message.slice(0, 60)}`);
  }
  const named = new Map<number, string>();
  for (const a of assignments) if (a.partId) named.set(a.index, a.partId);
  const gptCount = named.size;

  // 규칙 명명 — GPT가 못 채운 조각·못 쓴 파트에만 적용 (충돌 방지)
  const usedParts = new Set(named.values());
  const remainingPlan = { ...plan, parts: plan.parts.filter((p) => !usedParts.has(p.id)) };
  const remainingGeoms = geoms.filter((g) => !named.has(g.index));
  // SAM 3 개념과의 겹침 — 조각의 40% 이상이 개념 마스크 안에 있으면 그 개념
  const conceptsOfComp = new Map<number, Set<string>>();
  for (let i = 0; i < deduped.length; i++) {
    const set = new Set<string>();
    for (const [concept, sm] of sam3Masks) {
      let inside = 0;
      const m = deduped[i].mask;
      for (let p = 0; p < CANVAS; p++) if (m[p] && sm[p]) inside++;
      if (inside >= deduped[i].area * 0.4) set.add(concept);
    }
    if (set.size) conceptsOfComp.set(i, set);
  }
  const ruled = assignByRules(remainingPlan, remainingGeoms, {
    heelSide,
    concepts: { detected: new Set(sam3Masks.keys()), ofComp: conceptsOfComp },
  });
  for (const a of ruled) if (!named.has(a.index)) named.set(a.index, a.partId);
  onProgress?.(
    `named ${named.size}/${deduped.length} (GPT ${gptOk ? gptCount : "실패"} + 규칙 ${ruled.length})`,
  );
  // 진단: 조각별 기하·색·이름 (VF_DEBUG=1) — 명명·흡수 오류를 추적할 때 켠다
  if (process.env.VF_DEBUG) {
    for (const g of geoms)
      onProgress?.(
        `  comp#${g.index} area=${g.areaPct}% c=(${g.cx},${g.cy}) vis=${g.color} qwen=${deduped[g.index].color} q${deduped[g.index].qwenIndex} → ${named.get(g.index) ?? "-"}`,
      );
  }
  // 이후 단계(흡수·스냅)는 보이는 색으로 판단한다
  deduped.forEach((c, i) => { c.color = visColor[i]; });

  // ── 4-b) 미명명 조각을 이름 있는 이웃에 흡수 ────────────────
  // 색·연결요소 분해는 Layer Plan의 파트 수보다 조각을 많이 만든다. 남은
  // 조각을 그대로 두면 .ai에 "Region 11" 같은 레이어가 십수 개 생겨
  // 디자이너가 무엇인지 알 수 없다(실측: 최대 14개).
  // 맞닿은 길이와 색 유사도로 가장 그럴듯한 이름 있는 파트에 흡수시킨다.
  // 크고 색이 확연히 다른 조각만 독립 파트로 남긴다.
  {
    // 픽셀별 소속(페인팅 순서상 나중 것이 이김) — 인접 판정용
    const owner = new Int16Array(CANVAS).fill(-1);
    for (let i = deduped.length - 1; i >= 0; i--) {
      const m = deduped[i].mask;
      for (let p = 0; p < CANVAS; p++) if (m[p] && owner[p] < 0) owner[p] = i;
    }

    let absorbed = 0;
    for (let i = 0; i < deduped.length; i++) {
      if (named.has(i)) continue;
      const c = deduped[i];
      // 크고 색이 뚜렷하면 독립 파트로 인정
      const bigEnough = c.area > CANVAS * 0.03;

      const adj = new Map<number, number>();
      for (let p = 0; p < CANVAS; p++) {
        if (!c.mask[p]) continue;
        const x = p % wkW, y = (p / wkW) | 0;
        for (const q of [
          x > 0 ? p - 1 : -1,
          x < wkW - 1 ? p + 1 : -1,
          y > 0 ? p - wkW : -1,
          y < wkH - 1 ? p + wkW : -1,
        ]) {
          if (q < 0 || c.mask[q]) continue;
          const o = owner[q];
          if (o >= 0 && o !== i && named.has(o)) adj.set(o, (adj.get(o) ?? 0) + 1);
        }
      }
      if (!adj.size) continue;

      let best = -1, bestScore = -Infinity, bestTouch = 0;
      let totalTouch = 0;
      for (const n of adj.values()) totalTouch += n;
      for (const [j, touch] of adj) {
        const cd = colorDist(c.color, deduped[j].color);
        // 맞닿은 비율 60% + 색 근접도 40%
        const score = 0.6 * (touch / Math.max(1, totalTouch)) + 0.4 * Math.max(0, 1 - cd / 160);
        if (score > bestScore) { bestScore = score; best = j; bestTouch = touch; }
      }
      if (best < 0) continue;
      const cd = colorDist(c.color, deduped[best].color);
      // 색이 확연히 다르면 크기와 무관하게 독립 파트다. 크기 조건만 두었더니
      // 작지만 색이 다른 파트까지 흡수돼 색 충실도가 떨어졌다
      // (실측: shoe_1 색오차 56.7 → 81.6).
      if (cd > 110) continue;
      if (bigEnough && cd > 60) continue;
      // 거의 맞닿지 않으면(떨어져 있는 별개 조각) 흡수하지 않는다
      if (bestTouch < 8) continue;
      // 작은 조각이 훨씬 큰 조각을 삼키면 큰 쪽이 작은 쪽 이름·색을 물려받는다
      // (실측: 3% 흰 미드솔 조각이 35% 몸통을 흡수해 "Quarter"가 흰색으로).
      // 큰 조각은 이름이 없더라도 독립 파트로 남긴다.
      if (c.area > deduped[best].area * 2) continue;

      for (let p = 0; p < CANVAS; p++) if (c.mask[p]) deduped[best].mask[p] = 1;
      deduped[best].area += c.area;
      c.area = 0; // 흡수 표시
      absorbed++;
      if (process.env.VF_DEBUG)
        onProgress?.(`  흡수 comp#${i} ${c.color} → comp#${best} ${deduped[best].color} (${named.get(best)}) cd=${cd.toFixed(0)}`);
    }
    if (absorbed) {
      const keep = deduped.filter((c) => c.area > 0);
      const remap = new Map<number, string>();
      deduped.forEach((c, i) => {
        if (c.area > 0 && named.has(i)) remap.set(keep.indexOf(c), named.get(i)!);
      });
      deduped.length = 0;
      deduped.push(...keep);
      named.clear();
      for (const [k, v] of remap) named.set(k, v);
      onProgress?.(`미명명 조각 ${absorbed}개를 이름 있는 파트에 흡수`);
    }
  }

  // ── 5) 반복 디테일 병합 ───────────────────────────────────
  // 파베 스톤·아일릿처럼 같은 모양이 여러 개인 파트는 조각마다 레이어를 만들면
  // Illustrator에서 다루기 어렵다(실측: 스톤 11개가 각각 레이어).
  // 이름을 못 받았고, 색이 같고, 크기가 비슷한 작은 조각들을 한 그룹으로 묶는다.
  const mergedInto = new Map<number, number>(); // idx → 대표 idx
  {
    const smallUnnamed = deduped
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => !named.has(i) && c.area < CANVAS * 0.02);
    const buckets = new Map<string, number[]>();
    for (const { c, i } of smallUnnamed) {
      const key = `${c.color}|${Math.round(Math.log2(Math.max(1, c.area)) * 2)}`;
      buckets.set(key, [...(buckets.get(key) ?? []), i]);
    }
    for (const idxs of buckets.values()) {
      if (idxs.length < 3) continue;
      const head = idxs[0];
      for (const i of idxs.slice(1)) {
        mergedInto.set(i, head);
        for (let p = 0; p < deduped[head].mask.length; p++)
          if (deduped[i].mask[p]) deduped[head].mask[p] = 1;
        deduped[head].area += deduped[i].area;
      }
    }
    if (mergedInto.size) onProgress?.(`반복 디테일 ${mergedInto.size}개 병합`);
  }

  // ── 6) LayerPng 생성 ─────────────────────────────────────
  const partById = new Map(plan.parts.map((p) => [p.id, p]));
  const usedNames = new Map<string, number>();
  const layers: LayerPng[] = [];

  /** 전체 해상도 마스크를 모아 두었다가 경계 정합 후 한꺼번에 기록한다 */
  const pending: PendingLayer[] = [];

  // 베이스는 배열 맨 앞 = 페인팅 순서 맨 아래
  if (baseMask) {
    pending.push({
      mask: await upscaleMask(baseMask, wkW, wkH, W, H),
      color: baseColor,
      partId: "__base",
      name: "Base",
      parent: firstParent(plan),
      kind: "fill",
      area: CANVAS,
    });
  }

  const mergeCount = new Map<number, number>();
  for (const head of mergedInto.values())
    mergeCount.set(head, (mergeCount.get(head) ?? 1) + 1);

  for (let i = 0; i < deduped.length; i++) {
    if (mergedInto.has(i)) continue; // 대표 조각에 흡수됨
    const c = deduped[i];
    const partId = named.get(i);
    const part = partId ? partById.get(partId) : undefined;

    // SAM 3이 아는 개념과 강하게 겹치면 그 경계로 교체 (더 정밀)
    let mask = c.mask;
    if (part) {
      for (const [concept, sm] of sam3Masks) {
        if (!part.name.toLowerCase().includes(concept) && !part.id.includes(concept)) continue;
        if (iou(c.mask, sm) > 0.45) {
          mask = intersect(sm, c.mask);
          break;
        }
      }
    }

    // 이름이 없으면 위치 기반 임시 이름 (버리지 않는다 — 형상 손실 방지)
    const rep = mergeCount.get(i);
    const baseName = part?.name ?? (rep ? `Detail ×${rep}` : `Region ${i + 1}`);
    const n = (usedNames.get(baseName) ?? 0) + 1;
    usedNames.set(baseName, n);
    const displayName = n > 1 ? `${baseName} ${n}` : baseName;
    const id = (part?.id ?? `region_${i + 1}`) + (n > 1 ? `_${n}` : "");

    pending.push({
      mask: await upscaleMask(mask, wkW, wkH, W, H),
      color: c.color,
      partId: id,
      name: displayName,
      parent: part?.parent ?? guessParent(plan.category, c.cy),
      kind: kindFor(part?.kind, c.color),
      area: c.area,
    });
  }

  // ── 7) 경계 스냅 + 틈 메우기 ──────────────────────────────
  // 각 레이어는 저해상 마스크를 따로 업스케일하므로 인접 파트의 경계가
  // 정확히 맞닿지 않아 사이에 흰 틈이 남는다(실측: 검정 신발 미드솔의 흰 얼룩).
  // 플랫 전경 중 어떤 레이어도 덮지 않은 픽셀을 최근접 레이어로 흘려보내
  // 경계를 서로 붙인다.
  const areaBefore = process.env.VF_DEBUG
    ? pending.map((p) => { let n = 0; for (let i = 0; i < p.mask.length; i++) n += p.mask[i]; return n; })
    : null;
  // 선 픽셀 마스크 — 면 스냅에서 제외하고, 뒤에서 Linework 레이어로 쓴다
  const ink = await inkMask(flatBuf, W, H);
  await snapLabels(pending, flatBuf, W, H, onProgress, ink);
  if (areaBefore) {
    pending.forEach((p, i) => {
      let n = 0; for (let k = 0; k < p.mask.length; k++) n += p.mask[k];
      onProgress?.(`  스냅 ${p.name.padEnd(16)} ${p.color} ${areaBefore[i]} → ${n}px`);
    });
  }

  // 스냅에서 픽셀을 전부 잃은 레이어는 지금 버린다 — 이름을 돌려줘야 뒤의 잔차
  // 회수가 그 파트 이름을 쓸 수 있다(실측: Qwen이 노란색으로 칠한 amodal 프레임이
  // "Frame"을 차지한 채 비어 있고, 진짜 프레임 잔차는 "Region 6"이 됨).
  {
    const before = pending.length;
    const alive = pending.filter((p) => {
      if (p.kind === "line") return true;
      let n = 0; for (let i = 0; i < p.mask.length && n < 24; i++) n += p.mask[i];
      return n >= 24;
    });
    if (alive.length < before) {
      onProgress?.(`스냅 후 빈 레이어 ${before - alive.length}개 제거: ${pending.filter((p) => !alive.includes(p)).map((p) => p.name).join(", ")}`);
      pending.length = 0;
      pending.push(...alive);
    }
  }

  // 핀홀 제거 — 1~2px 구멍은 벡터화 후 검은 면 위의 흰 점으로 남아
  // 면적은 1~2%뿐이어도 시각적으로 매우 눈에 띈다(실측: 검정 신발 미드솔).
  for (const p of pending) if (p.kind !== "line") closeHoles(p.mask, W, H);

  const { data: fullRgb, info: fi } = await sharp(flatBuf)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const fullBg = backgroundMask(fullRgb, fi.channels, W, H);

  // ── 7-a) 미포함 전경 회수 ────────────────────────────────
  // 스냅의 거리 제한 밖에 남은 전경(공중의 체인·스트랩, 조각이 전혀 안 잡힌 파트)을
  // 자기 색의 레이어로 만든다. 같은 색의 면과 닿아 있으면 거기에 합친다.
  {
    const usedPartIds = new Set(pending.map((p) => p.partId.replace(/_\d+$/, "")));
    const remaining = { ...plan, parts: plan.parts.filter((p) => !usedPartIds.has(p.id)) };
    const added = await recoverColorResiduals(pending, fullRgb, fi.channels, fullBg, W, H, remaining, heelSide, ink, onProgress, "uncovered");
    for (const p of added) closeHoles(p.mask, W, H);
  }

  // ── 7-b) 색 잔차 회수 ─────────────────────────────────────
  //
  // 스냅은 "탐색 띠 안의 후보 중 색이 가장 가까운 레이어"를 고른다. 후보가
  // 하나뿐인 픽셀은 색이 아무리 달라도 그 레이어로 간다 — amodal 몸통의 띠는
  // 제품 전체를 덮으므로, 어떤 조각도 잡아내지 못한 색면(실측: shoe_1 핑크
  // 힐패널 2.4만px)이 검정 몸통에 묻혀 재합성 ΔE 244가 났다.
  //
  // 여기서는 재합성 QA를 파이프라인 안으로 끌어와 스스로 고친다: 각 레이어의
  // 픽셀 중 그 레이어 색과 확연히 다른 픽셀을 모아 연결요소로 묶고, 충분히
  // 크면 **새 레이어로 독립**시킨다. 이름은 남은 파트에 규칙으로 배정한다.
  {
    const usedPartIds = new Set(pending.map((p) => p.partId.replace(/_\d+$/, "")));
    const remaining = { ...plan, parts: plan.parts.filter((p) => !usedPartIds.has(p.id)) };
    const added = await recoverColorResiduals(pending, fullRgb, fi.channels, fullBg, W, H, remaining, heelSide, ink, onProgress);
    for (const p of added) closeHoles(p.mask, W, H);
    // 잔차 회수 뒤 남은 이름 없는 작은 조각(해칭 음영 등)을 비슷한 색의 큰 이웃에 정리
    absorbSmallUnnamed(pending, W, H, onProgress);
  }

  // ── 8) 얇은 파트 → 스트로크 전환 + 전해상도 색 재샘플 ──────
  //
  // 금속 프레임·체인·스트랩처럼 폭이 몇 px뿐인 파트는 "면"으로 다루는 순간
  // 진다: 업스케일에서 뭉개지고 벡터화에서 누더기가 된다(실측: bag_2 프레임
  // 소실, 체인이 노란 막대로). 폭이 좁으면 면 분해를 버리고 중심선+굵기
  // 스트로크로 표현한다 — VectorArk(2026)와 같은 문제의식이다.
  //
  // 색도 여기서 전해상도 플랫으로 다시 샘플링한다. 작업 해상도(1024)의
  // 색은 이웃 파트가 섞여 있을 수 있다.
  {
    const thinLimit = Math.max(5, Math.min(W, H) * 0.016);

    for (const p of pending) {
      if (p.kind === "line") continue;
      let area = 0, perim = 0;
      let minX = W, maxX = -1, minY = H, maxY = -1;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (!p.mask[i]) continue;
          area++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (!p.mask[i - 1] || !p.mask[i + 1] || !p.mask[i - W] || !p.mask[i + W]) perim++;
        }
      }
      if (!area) continue;
      // 리본 근사 폭 = 2·면적/둘레
      const width = (2 * area) / Math.max(1, perim);
      // 작은 뭉툭한 조각(스톤·버튼·아일릿)은 리본 폭이 작아도 "가는 파트"가 아니다 —
      // 스트로크로 바꾸면 점이 고리 모양 획으로 깨진다(실측: bag_3 터쿼이즈 스톤).
      // 반복 디테일(Detail ×N)과, 바운딩 박스를 빽빽이 채운 정방형 조각은 면으로 둔다.
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      const compact = area / (bw * bh) > 0.45 && Math.max(bw, bh) / Math.max(1, Math.min(bw, bh)) < 3;
      const repeated = !!p.repeated || /^Detail ×/.test(p.name);
      if (width < thinLimit && p.partId !== "__base" && !compact && !repeated) {
        p.kind = "stroke";
        onProgress?.(`얇은 파트 "${p.name}" → 스트로크 (폭 ~${width.toFixed(1)}px)`);
      }
      // 전해상도 색 재샘플 (최빈값 방식)
      p.color = meanColor(fullRgb, fi.channels, p.mask, fullBg);
    }
  }

  // ── 9) 페인팅 순서 확정 — Z-order ────────────────────────
  // 배열 순서 = 아래→위. 앞 단계(중복제거·흡수·스냅)를 거치면 면적 순서가
  // 흐트러져 큰 몸통이 작은 파트 **위에** 칠해질 수 있다(실측: Quarter가
  // 핑크 파트를 덮어 재합성 색차 ΔE 240 — .ai에서도 그대로 덮임).
  // 실제 스냅 후 면적으로 다시 정렬한다: 큰 것이 아래, 작은 오버레이가 위.
  // 베이스(`__base`)는 무조건 맨 아래.
  const areaOf = (m: Uint8Array) => { let n = 0; for (let i = 0; i < m.length; i++) n += m[i]; return n; };
  const withArea = pending.map((p) => ({ p, a: p.partId === "__base" ? Infinity : areaOf(p.mask) }));
  // 스냅·잔차 회수에서 픽셀을 전부 빼앗긴 레이어는 버린다 — 빈 레이어가 .ai에
  // "Region 12"로 남으면 디자이너에게 소음이다(실측: 한 잡에 빈 레이어 9개).
  // 면 레이어는 캔버스의 0.02% 미만이면 잔재, 스트로크 레이어는 원래 작으므로 24px만 넘으면 유지.
  const isEmpty = (w: { p: PendingLayer; a: number }) =>
    w.p.kind === "line" ? false : w.p.kind === "stroke" ? w.a < 24 : w.a < Math.max(24, W * H * 0.0002);
  const emptied = withArea.filter(isEmpty);
  if (emptied.length)
    onProgress?.(`빈 레이어 ${emptied.length}개 제거: ${emptied.map((w) => w.p.name).join(", ")}`);
  const kept = withArea.filter((w) => !isEmpty(w));
  kept.sort((x, y) => y.a - x.a);
  pending.length = 0;
  for (const w of kept) pending.push(w.p);

  for (const p of pending) {
    const pngPath = path.join(outDir, `layer_${p.partId}.png`);
    await writeMaskPng(p.mask, W, H, p.color, pngPath);
    layers.push({
      partId: p.partId,
      name: p.name,
      parent: p.parent,
      kind: p.kind,
      pngPath,
      dominantColor: p.color,
      area: p.area,
    });
  }

  // ── 6) Linework 레이어 — **컬러플랫 자체에서** 뽑는다 ──────
  //
  // 예전에는 라인아트 후보 이미지에서 뽑았는데, 면(컬러플랫)과 선(라인아트)이
  // 서로 다른 생성 결과라 내부 비율이 미세하게 달라 **선이 면과 몇 px 어긋났다**.
  // 겹쳐 보면 빨강/파랑 윤곽이 나란히 밀려 있고 일치 영역이 거의 없었다
  // (실측: bag_2 선F1 32.5%, recall·precision 모두 ~32%로 대칭 저하).
  //
  // 컬러플랫에는 이미 검은 윤곽선이 그려져 있으므로 거기서 뽑으면 면과 정확히
  // 같은 좌표계다. 단순 임계로는 검정 제품의 면까지 잡히므로, **black-hat**
  // (닫힘 - 원본)으로 "주변보다 눈에 띄게 어두운 가는 구조"만 남긴다.
  const linePath = path.join(outDir, "layer__linework.png");
  await writeLineworkFromFlat(flatBuf, W, H, linePath, ink);
  void lineBuf; // B/W 스타일 출력용으로만 보관
  layers.push({
    partId: "__linework",
    name: "Linework",
    parent: "CONSTRUCTION",
    kind: "line",
    pngPath: linePath,
    dominantColor: "#111111",
    area: W * H,
  });

  return {
    layers,
    width: W,
    height: H,
    engine:
      "Qwen amodal 분해 + 색클러스터/연결요소 + GPT 명명" +
      (sam3Count ? ` + SAM3(${sam3Count})` : "") +
      fallbackNote,
    stats: {
      qwenLayers: useful.length,
      components: deduped.length,
      named: named.size,
      sam3: sam3Count,
    },
  };
}

// ── 헬퍼 ────────────────────────────────────────────────────

/** Qwen 분해 결과를 디스크에 캐시 — 재빌드 시 재과금 방지 */
async function cachedQwen(
  cacheDir: string,
  imagePath: string,
  numLayers: number,
  caption: string,
): Promise<{ index: number; rgbaPng: Buffer; coverage: number }[]> {
  try {
    const files = (await fs.readdir(cacheDir)).filter((f) => f.endsWith(".png")).sort();
    if (files.length) {
      const out = [];
      for (let i = 0; i < files.length; i++) {
        const rgbaPng = await fs.readFile(path.join(cacheDir, files[i]));
        const { data, info } = await sharp(rgbaPng)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        let opaque = 0;
        for (let p = 3; p < data.length; p += info.channels) if (data[p] > 40) opaque++;
        out.push({ index: i, rgbaPng, coverage: opaque / (info.width * info.height) });
      }
      return out;
    }
  } catch {
    /* 캐시 없음 — 실제 호출 */
  }
  const layers = await qwenLayered(imagePath, numLayers, caption);
  await fs.mkdir(cacheDir, { recursive: true });
  await Promise.all(
    layers.map((l) =>
      fs.writeFile(path.join(cacheDir, `q${String(l.index).padStart(2, "0")}.png`), l.rgbaPng),
    ),
  );
  return layers;
}

/** RGBA PNG의 알파 → 이진 마스크 (size×size) */
async function alphaMask(png: Buffer, size: number): Promise<Uint8Array> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .resize(size, size, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) out[i] = data[i * info.channels + 3] > 100 ? 1 : 0;
  return out;
}

/** white-on-black 마스크 PNG → 이진 마스크 */
async function alphaFromWhite(png: Buffer, W: number, H: number): Promise<Uint8Array> {
  const { data, info } = await sharp(png)
    .flatten({ background: "#000000" })
    .resize(W, H, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = data[i * info.channels] > 127 ? 1 : 0;
  return out;
}

/** 4-이웃 연결요소 분리 (BFS). minArea 미만 조각은 버린다. */
function connectedComponents(
  mask: Uint8Array,
  W: number,
  H: number,
  minArea: number,
): { mask: Uint8Array; area: number; cx: number; cy: number }[] {
  // 폭이 이보다 얇은 조각은 크롭·정합 경계에서 생긴 퇴화 슬리버다.
  // 실측: 2x651px 조각이 최종 도면에 세로 줄로 찍혔다.
  const MIN_THICKNESS = 3;
  const seen = new Uint8Array(W * H);
  const out: { mask: Uint8Array; area: number; cx: number; cy: number }[] = [];
  const queue = new Int32Array(W * H);

  for (let start = 0; start < W * H; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0, tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    const comp = new Uint8Array(W * H);
    let area = 0, sx = 0, sy = 0;
    let minX = W, minY = H, maxX = 0, maxY = 0;

    while (head < tail) {
      const p = queue[head++];
      comp[p] = 1;
      area++;
      const x = p % W, y = (p / W) | 0;
      sx += x; sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; queue[tail++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; queue[tail++] = p + 1; }
      if (y > 0 && mask[p - W] && !seen[p - W]) { seen[p - W] = 1; queue[tail++] = p - W; }
      if (y < H - 1 && mask[p + W] && !seen[p + W]) { seen[p + W] = 1; queue[tail++] = p + W; }
    }
    // 면적만으로 거르면 **가늘고 긴 파트가 통째로 사라진다**.
    // 실측: 폭 4px·길이 400px 체인(1,600px)이 minArea 1,790px에 걸려 없어졌고
    // 그 결과 가방의 금속 체인이 도면에서 빠졌다.
    // 그래서 "면적이 크거나" 또는 "충분히 길쭉하면" 살린다.
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const diag = Math.hypot(bw, bh);
    const elongated =
      diag >= Math.min(W, H) * 0.12 && area >= minArea * 0.15;
    if (area < minArea && !elongated) continue;
    if (Math.min(bw, bh) < MIN_THICKNESS) continue;
    out.push({ mask: comp, area, cx: sx / area / W, cy: sy / area / H });
  }
  return out.sort((a, b) => b.area - a.area);
}

/**
 * Qwen 레이어를 지배색 클러스터로 나눈다.
 * 히스토그램 피크를 색 거리로 떨어뜨려 고른 뒤, 각 픽셀을 가장 가까운 피크에
 * 배정한다(임계 밖이면 버림). 플랫 이미지는 파트당 단색이라 이 단순한
 * 방식으로 재질 경계가 잘 나온다.
 */
function colorClusters(
  rgba: Buffer,
  channels: number,
  alpha: Uint8Array,
  maxClusters = 8,
  bg?: Uint8Array,
): { hex: string; mask: Uint8Array }[] {
  const BIN = 5; // 5비트 → 32단계
  const bins = new Map<number, number>();
  let total = 0;
  const isBg = (i: number, r: number, g: number, b: number) =>
    bg ? bg[i] === 1 : r > 245 && g > 245 && b > 245;
  for (let i = 0; i < alpha.length; i++) {
    if (!alpha[i]) continue;
    const p = i * channels;
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    if (isBg(i, r, g, b)) continue; // 배경
    if (r < 35 && g < 35 && b < 35) continue; // 윤곽선
    const key = ((r >> (8 - BIN)) << (BIN * 2)) | ((g >> (8 - BIN)) << BIN) | (b >> (8 - BIN));
    bins.set(key, (bins.get(key) ?? 0) + 1);
    total++;
  }
  if (!total) return [];

  const half = 1 << (7 - BIN);
  const decode = (k: number): [number, number, number] => [
    ((k >> (BIN * 2)) << (8 - BIN)) + half,
    (((k >> BIN) & 31) << (8 - BIN)) + half,
    ((k & 31) << (8 - BIN)) + half,
  ];
  const dist2 = (a: number[], b: number[]) =>
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

  // 빈도순으로 피크를 고르되, 이미 고른 중심과 가까우면 건너뛴다.
  // 분리 임계는 적응형이다 — 단색 제품(실버 주얼리 등)은 색 차이가 작아서
  // 고정 임계로는 클러스터가 1개만 나오고 파트가 전혀 갈리지 않는다.
  const sorted = [...bins.entries()].sort((a, b) => b[1] - a[1]);
  let centers: [number, number, number][] = [];
  for (const sep of [70, 45, 28, 18]) {
    const sep2 = sep * sep;
    centers = [];
    for (const [k] of sorted) {
      if (centers.length >= maxClusters) break;
      const c = decode(k);
      if (centers.some((e) => dist2(e, c) < sep2)) continue;
      centers.push(c);
    }
    if (centers.length >= 2) break;
  }
  if (!centers.length) return [];

  const ASSIGN2 = 85 * 85;
  const masks = centers.map(() => new Uint8Array(alpha.length));
  const counts = new Array(centers.length).fill(0);
  // 어느 중심에도 가깝지 않은 전경 픽셀 — 버리면 구멍이 난다.
  // (실측: 파베 채널의 중간톤 금속이 통째로 누락돼 coverage 71%)
  const residual = new Uint8Array(alpha.length);
  let residualN = 0;
  let rs = 0, gs = 0, bs = 0;

  for (let i = 0; i < alpha.length; i++) {
    if (!alpha[i]) continue;
    const p = i * channels;
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    if (isBg(i, r, g, b)) continue;
    if (r < 35 && g < 35 && b < 35) continue;
    let best = -1, bestD = ASSIGN2;
    for (let c = 0; c < centers.length; c++) {
      const d = dist2(centers[c], [r, g, b]);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best >= 0) { masks[best][i] = 1; counts[best]++; }
    else { residual[i] = 1; residualN++; rs += r; gs += g; bs += b; }
  }

  const hex2 = (v: number) => Math.max(0, Math.min(245, v)).toString(16).padStart(2, "0");
  const out = centers
    .map((c, i) => ({
      hex: `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`,
      mask: masks[i],
      n: counts[i],
    }))
    .filter((c) => c.n > total * 0.005);

  if (residualN > total * 0.005) {
    out.push({
      hex: `#${hex2(rs / residualN)}${hex2(gs / residualN)}${hex2(bs / residualN)}`,
      mask: residual,
      n: residualN,
    });
  }
  return out.map(({ hex, mask }) => ({ hex, mask }));
}

/**
 * 컬러플랫에서 선 레이어를 추출한다 (black-hat 형태학).
 *
 * 단순 밝기 임계는 검정 신발처럼 어두운 제품에서 면 전체를 선으로 오인한다.
 * black-hat = 닫힘(closing) − 원본 은 "주변보다 어두운 가는 구조"만 남기므로
 * 배경색과 무관하게 윤곽선·스티치만 뽑힌다.
 *
 * 최대/최소 필터는 정사각 구조요소에 대해 분리 가능하므로 1D 2패스로 처리한다
 * (2048² 이미지에서 2D로 돌리면 너무 느리다).
 */
async function writeLineworkFromFlat(
  flatBuf: Buffer,
  W: number,
  H: number,
  dest: string,
  ink?: Uint8Array,
): Promise<void> {
  const m = ink ?? (await inkMask(flatBuf, W, H));
  const out = Buffer.alloc(W * H, 255);
  for (let i = 0; i < W * H; i++) if (m[i]) out[i] = 0;
  await sharp(out, { raw: { width: W, height: H, channels: 1 } }).png().toFile(dest);
}

/**
 * 플랫의 "선 픽셀" — 주변보다 눈에 띄게 어두운 가는 구조(black-hat).
 * 윤곽선·스티치·해칭 줄무늬가 잡히고, 넓은 검정 면은 잡히지 않는다.
 * 면 분해(스냅)와 Linework 레이어가 같은 마스크를 공유한다.
 */
async function inkMask(flatBuf: Buffer, W: number, H: number): Promise<Uint8Array> {
  const N = W * H;
  const { data, info } = await sharp(flatBuf)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const g = new Uint8Array(N);
  const R = new Uint8Array(N), G = new Uint8Array(N), B = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const p = i * ch;
    R[i] = data[p]; G[i] = data[p + 1]; B[i] = data[p + 2];
    g[i] = Math.round(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
  }

  // 선 굵기보다 조금 큰 반경이면 선이 닫힘 연산에 메워진다
  const r = Math.max(2, Math.round(Math.min(W, H) * 0.006));
  const closed = erode(dilate(g, W, H, r), W, H, r);
  // 주변(둘러싼 면)의 색 — 채널별 닫힘으로 근사
  const cR = erode(dilate(R, W, H, r), W, H, r);
  const cG = erode(dilate(G, W, H, r), W, H, r);
  const cB = erode(dilate(B, W, H, r), W, H, r);

  // 가는 어두운 구조가 전부 "선"은 아니다. 크림 몸통 위의 갈색 프레임 띠, 흰 배경
  // 위의 금 체인은 가늘지만 **색이 다른 파트**다. 선으로 보는 것은
  //  (a) 어두운 무채색(윤곽선·스티치), 또는
  //  (b) 둘러싼 면과 같은 색상(hue)의 어두운 줄(해칭·음영선 — 같은 재질의 명암)
  // 뿐이다. 그 밖의 유채색 가는 구조는 면 파트로 남긴다.
  const hueOf = (r0: number, g0: number, b0: number): number => {
    const max = Math.max(r0, g0, b0), min = Math.min(r0, g0, b0), d = max - min;
    if (d === 0) return 0;
    let h = max === r0 ? ((g0 - b0) / d) % 6 : max === g0 ? (b0 - r0) / d + 2 : (r0 - g0) / d + 4;
    return ((h * 60) + 360) % 360;
  };
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (closed[i] - g[i] <= 22) continue; // 주변보다 눈에 띄게 어둡지 않다
    const chroma = Math.max(R[i], G[i], B[i]) - Math.min(R[i], G[i], B[i]);
    if (chroma < 50) { out[i] = 1; continue; } // (a) 무채색 선 (밝기는 이미 주변보다 어둡다)
    const sChroma = Math.max(cR[i], cG[i], cB[i]) - Math.min(cR[i], cG[i], cB[i]);
    if (sChroma < 40) continue; // 유채색 구조가 무채색 면 위에 → 파트
    let dh = Math.abs(hueOf(R[i], G[i], B[i]) - hueOf(cR[i], cG[i], cB[i]));
    if (dh > 180) dh = 360 - dh;
    if (dh < 30) out[i] = 1; // (b) 같은 색상의 어두운 줄 = 음영선
  }
  return out;
}

/** 분리형 최대 필터 (그레이스케일 팽창) */
function dilate(src: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const tmp = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let m = 0;
      const a = Math.max(0, x - r), b = Math.min(W - 1, x + r);
      for (let k = a; k <= b; k++) if (src[row + k] > m) m = src[row + k];
      tmp[row + x] = m;
    }
  }
  const out = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let m = 0;
      const a = Math.max(0, y - r), b = Math.min(H - 1, y + r);
      for (let k = a; k <= b; k++) if (tmp[k * W + x] > m) m = tmp[k * W + x];
      out[y * W + x] = m;
    }
  }
  return out;
}

/** 분리형 최소 필터 (그레이스케일 침식) */
function erode(src: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const tmp = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let m = 255;
      const a = Math.max(0, x - r), b = Math.min(W - 1, x + r);
      for (let k = a; k <= b; k++) if (src[row + k] < m) m = src[row + k];
      tmp[row + x] = m;
    }
  }
  const out = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let m = 255;
      const a = Math.max(0, y - r), b = Math.min(H - 1, y + r);
      for (let k = a; k <= b; k++) if (tmp[k * W + x] < m) m = tmp[k * W + x];
      out[y * W + x] = m;
    }
  }
  return out;
}

/** 저해상 마스크를 원본 해상도 이진 마스크로 업스케일 */
async function upscaleMask(
  mask: Uint8Array,
  mW: number,
  mH: number,
  W: number,
  H: number,
): Promise<Uint8Array> {
  const gray = Buffer.alloc(mW * mH);
  for (let i = 0; i < mask.length; i++) gray[i] = mask[i] ? 255 : 0;

  // 계단 현상을 blur로 완화하고 임계값으로 정리.
  // NOTE: sharp의 .threshold()는 3채널을 반환하므로 반드시 info.channels로
  // 인덱싱해야 한다. 1채널로 가정하면 상단 1/3 밖의 형상이 통째로 사라진다.
  const { data: up, info } = await sharp(gray, {
    raw: { width: mW, height: mH, channels: 1 },
  })
    .resize(W, H, { fit: "fill", kernel: "cubic" })
    .blur(Math.max(0.3, W / mW / 2))
    .threshold(128)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = up[i * info.channels] > 127 ? 1 : 0;
  return out;
}

/** 전체 해상도 이진 마스크를 솔리드 색 PNG로 기록 */
async function writeMaskPng(
  mask: Uint8Array,
  W: number,
  H: number,
  color: string,
  dest: string,
): Promise<void> {
  const rgb = Buffer.alloc(W * H * 3, 255);
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  for (let i = 0; i < W * H; i++) {
    if (mask[i]) { rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b; }
  }
  await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toFile(dest);
}

/**
 * 색 기반 경계 스냅 — 전체 해상도에서 레이어 경계를 플랫의 실제 색 경계에 맞춘다.
 *
 * 마스크 기하는 640px 작업 해상도에서 나오므로, 그대로 업스케일하면 작은
 * 파트(파베 스톤 등)가 뭉개지고 인접 파트 경계가 어긋난다.
 * 여기서는 각 레이어의 마스크를 조금 넓힌 "탐색 띠" 안에서, 플랫의 픽셀 색과
 * 가장 가까운 색을 가진 레이어가 그 픽셀을 가져가도록 경쟁시킨다.
 * 경계가 플랫의 진짜 색 경계로 스냅되고, 인접 레이어끼리 정확히 맞닿는다.
 */
async function snapLabels(
  pending: PendingLayer[],
  flatBuf: Buffer,
  W: number,
  H: number,
  onProgress?: (m: string) => void,
  ink?: Uint8Array,
): Promise<void> {
  const fills = pending.filter((p) => p.kind !== "line");
  if (fills.length < 2) return;

  const { data: rgb, info } = await sharp(flatBuf)
    .removeAlpha()
    .resize(W, H, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const N = W * H;

  // 탐색 띠 = 각 레이어 마스크를 팽창시킨 영역. sharp의 blur+threshold로
  // 네이티브 팽창을 대신한다(JS 루프보다 훨씬 빠르다).
  //
  // 띠 폭은 파트 크기에 비례시킨다. Qwen 알파는 640px 기준이라 작은 파트
  // (파베 스톤 ~20px)는 마스크 자체가 뭉툭하게 나온다. 고정 폭을 쓰면 진짜
  // 원형 경계가 띠 밖에 있어 스냅되지 못한다. 작은 파트일수록 상대적으로
  // 넓은 띠를 줘서 플랫의 실제 색 경계를 찾아가게 한다.
  const dilated: Uint8Array[] = [];
  for (const f of fills) {
    let area = 0;
    for (let i = 0; i < N; i++) area += f.mask[i];
    const r = Math.sqrt(Math.max(1, area));
    const band = Math.max(2, Math.min(24, Math.round(r * 0.45)));
    const g = Buffer.alloc(N);
    for (let i = 0; i < N; i++) g[i] = f.mask[i] ? 255 : 0;
    const { data: d, info: di } = await sharp(g, { raw: { width: W, height: H, channels: 1 } })
      .blur(band / 2)
      .threshold(12) // 낮은 임계 = 팽창
      .raw()
      .toBuffer({ resolveWithObject: true });
    const m = new Uint8Array(N);
    for (let i = 0; i < N; i++) m[i] = d[i * di.channels] > 127 ? 1 : 0;
    dilated.push(m);
  }

  const cols = fills.map((f) => [
    parseInt(f.color.slice(1, 3), 16),
    parseInt(f.color.slice(3, 5), 16),
    parseInt(f.color.slice(5, 7), 16),
  ]);
  // 작은 파트(끈·체인·파이핑·트림)는 자기 픽셀이 곧 "선"이므로 자기 마스크 안의
  // 선 픽셀은 가져갈 수 있어야 한다(실측: 금 체인이 선 픽셀뿐이라 통째로 비워짐).
  // 큰 몸통은 선 픽셀을 두고 경쟁하지 않는다 — 해칭·윤곽선을 삼키지 않게.
  const smallPart = fills.map((f) => {
    let area = 0;
    for (let i = 0; i < N; i++) area += f.mask[i];
    return area < N * 0.01;
  });
  const origMask = fills.map((f) => f.mask.slice());
  const isBase = fills.map((f) => f.partId === "__base");

  const label = new Int16Array(N).fill(-1);
  let snapped = 0;
  for (let i = 0; i < N; i++) {
    const p = i * ch;
    const r = rgb[p], g = rgb[p + 1], b = rgb[p + 2];
    if (r > 245 && g > 245 && b > 245) continue; // 배경
    // 선 픽셀(윤곽선·스티치·해칭)은 면 경쟁에서 뺀다 — 아래 틈 메우기에서
    // 이웃 면이 채운다. 안 그러면 핑크 면 위의 어두운 해칭 줄이 검정 몸통에
    // 붙어 면이 줄무늬로 갈라지고, 벡터화 후 줄 사이가 흰 틈으로 남는다
    // (실측: shoe_1 AIR MAX 바). 선은 Linework 레이어가 따로 그린다.
    const isInk = !!(ink && ink[i]);
    let best = -1, bestD = Infinity;
    for (let li = 0; li < fills.length; li++) {
      if (isInk ? !(smallPart[li] && origMask[li][i]) : !dilated[li][i]) continue;
      // 원래 자기 마스크 안의 픽셀은 색이 비슷한 이웃에게 뺏기지 않는다(색 거리
      // 30 이내면 기존 소유 우선). 단색 제품(은반지)은 파트 색이 거의 같아 순수
      // 색 경쟁으로는 한 레이어가 전부 삼킨다(실측: jewelry_1 섕크 3개 소실).
      // 베이스(안전망)는 아무도 안 가져가는 픽셀만 맡는다 — 실루엣 전체가 원래
      // 마스크라 소유 우선을 주면 같은 색의 진짜 파트를 전부 삼킨다.
      const d = dist2c(cols[li], r, g, b) - (origMask[li][i] ? 900 : 0) + (isBase[li] ? 1e7 : 0);
      if (d < bestD) { bestD = d; best = li; }
    }
    if (best >= 0) {
      label[i] = best;
      if (!fills[best].mask[i]) snapped++;
    }
  }

  // 탐색 띠 밖에 남은 전경은 최근접 레이어로 흘려보낸다 (틈 메우기).
  // 단, 거리 제한을 둔다 — 아무 면과도 붙어 있지 않은 가는 구조(공중에 뜬 체인)를
  // 끝에 닿은 몸통 색으로 칠하면 안 된다(실측: bag_2 체인이 크림색 스트로크로).
  // 제한 밖에 남은 전경은 뒤 단계(미포함 전경 회수)가 자기 색의 레이어로 만든다.
  const queue = new Int32Array(N);
  const depth = new Uint16Array(N);
  const maxDepth = Math.max(10, Math.round(Math.min(W, H) * 0.02));
  let head = 0, tail = 0;
  for (let i = 0; i < N; i++) if (label[i] >= 0) queue[tail++] = i;
  const target = new Uint8Array(N);
  let gaps = 0;
  for (let i = 0; i < N; i++) {
    if (label[i] >= 0) continue;
    const p = i * ch;
    if (rgb[p] > 245 && rgb[p + 1] > 245 && rgb[p + 2] > 245) continue;
    target[i] = 1;
    gaps++;
  }
  while (head < tail) {
    const cur = queue[head++];
    const li = label[cur];
    if (depth[cur] >= maxDepth) continue;
    const x = cur % W, y = (cur / W) | 0;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (!target[ni] || label[ni] >= 0) continue;
      label[ni] = li;
      depth[ni] = depth[cur] + 1;
      queue[tail++] = ni;
    }
  }

  // NOTE: 여기에 3×3 다수결 필터로 라벨 경계를 평활화해 봤지만 **되돌렸다**.
  // 고배율에서 본 톱니는 면 경계가 아니라 선(black-hat 중심선) 쪽이라
  // 시각적 이득이 없었고, 면 형상만 뭉개져 선F1이 떨어졌다
  // (실측: shoe_3 84.0→74.5, jewelry_2 99.7→84.9).
  for (const f of fills) f.mask.fill(0);
  for (let i = 0; i < N; i++) if (label[i] >= 0) fills[label[i]].mask[i] = 1;
  onProgress?.(`경계 스냅: ${snapped}px 재배정 · 틈 ${gaps}px 채움`);
}

/**
 * Layer Plan의 kind → 실제 레이어 kind. "line" 파트라도 색이 있으면(금 체인·주황 끈)
 * 검정 중심선이 아니라 색 있는 스트로크로 그린다. 검정에 가까울 때만 선(line).
 */
function kindFor(planKind: "fill" | "line" | "logo" | undefined, color: string): "fill" | "line" | "logo" | "stroke" {
  if (planKind !== "line") return planKind ?? "fill";
  const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.35 ? "line" : "stroke";
}

/** 리본 근사 폭 = 2·면적/둘레 (가늘고 긴 형상일수록 작다) */
function ribbonWidthOf(mask: Uint8Array, W: number, H: number): number {
  const N = W * H;
  let area = 0, perim = 0;
  for (let p = 0; p < N; p++) {
    if (!mask[p]) continue;
    area++;
    const x = p % W;
    if ((x > 0 && !mask[p - 1]) || (x < W - 1 && !mask[p + 1]) || (p >= W && !mask[p - W]) || (p + W < N && !mask[p + W])) perim++;
  }
  return (2 * area) / Math.max(1, perim);
}

/** 3×3 이진 열림(침식→팽창) — 1~2px 슬리버·점을 지운다. 결과는 원 마스크의 부분집합 */
function open3(src: Uint8Array, W: number, H: number): Uint8Array {
  const N = W * H;
  const er = new Uint8Array(N);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!src[i]) continue;
      if (src[i - 1] && src[i + 1] && src[i - W] && src[i + W] &&
          src[i - W - 1] && src[i - W + 1] && src[i + W - 1] && src[i + W + 1]) er[i] = 1;
    }
  }
  const op = new Uint8Array(N);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!er[i]) continue;
      op[i] = 1; op[i - 1] = 1; op[i + 1] = 1; op[i - W] = 1; op[i + W] = 1;
      op[i - W - 1] = 1; op[i - W + 1] = 1; op[i + W - 1] = 1; op[i + W + 1] = 1;
    }
  }
  for (let i = 0; i < N; i++) op[i] = op[i] && src[i] ? 1 : 0;
  return op;
}

/**
 * 이름 없는 작은 면 레이어를 색이 비슷하고 많이 맞닿은 이웃에 합친다.
 *
 * Qwen 색 클러스터는 해칭·명암 때문에 같은 파트를 "핑크"와 "어두운 핑크"로
 * 가른다. 앞 단계의 흡수는 작업 해상도·Qwen 색 기준이라 이런 조각(색차 70~85)을
 * 남긴다(실측: 힐패널·에어유닛 위의 어두운 핑크 줄무늬 조각). 스냅이 끝난
 * 전해상도 마스크와 실제 색으로 한 번 더 정리한다. 이름 있는 파트는 건드리지
 * 않는다 — Eyestay(#2e2e2e)가 Quarter(#171717)에 먹히면 안 된다.
 */
function absorbSmallUnnamed(
  pending: PendingLayer[],
  W: number,
  H: number,
  onProgress?: (m: string) => void,
): void {
  const N = W * H;
  const fills = pending.filter((p) => p.kind !== "line" && p.kind !== "stroke");
  const areas = fills.map((f) => { let n = 0; for (let i = 0; i < N; i++) n += f.mask[i]; return n; });
  const removed = new Set<PendingLayer>();
  for (let a = 0; a < fills.length; a++) {
    const f = fills[a];
    if (!/^(Region|Detail)\b/.test(f.name) || f.partId === "__base") continue;
    if (areas[a] > N * 0.005 || areas[a] === 0) continue;
    // 둘레와 이웃별 접촉 길이
    let perim = 0;
    const touch = new Map<number, number>();
    for (let p = 0; p < N; p++) {
      if (!f.mask[p]) continue;
      const x = p % W;
      const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p >= W ? p - W : -1, p + W < N ? p + W : -1];
      let edge = false;
      for (const q of nb) {
        if (q < 0 || f.mask[q]) continue;
        edge = true;
        for (let b = 0; b < fills.length; b++) {
          if (b === a || removed.has(fills[b]) || !fills[b].mask[q]) continue;
          touch.set(b, (touch.get(b) ?? 0) + 1);
        }
      }
      if (edge) perim++;
    }
    let best = -1, bestT = 0;
    for (const [b, t] of touch) {
      if (colorDist(f.color, fills[b].color) > 85) continue;
      if (areas[b] < areas[a] * 2) continue; // 훨씬 큰 이웃에만
      if (t > bestT) { bestT = t; best = b; }
    }
    if (best < 0 || bestT < perim * 0.3) continue;
    for (let p = 0; p < N; p++) if (f.mask[p]) fills[best].mask[p] = 1;
    areas[best] += areas[a];
    removed.add(f);
    onProgress?.(`작은 조각 "${f.name}" ${f.color} → "${fills[best].name}"에 합침 (접촉 ${Math.round((100 * bestT) / perim)}%)`);
  }
  if (removed.size) {
    const keep = pending.filter((p) => !removed.has(p));
    pending.length = 0;
    pending.push(...keep);
  }
}

/**
 * 픽셀이 레이어 색과 "다른 파트"라고 볼 만큼 다른가.
 * RGB 거리만 쓰면 탁한 터쿼이즈(#66b9b3)와 회베이지(#a29589)가 82로 같은 파트가
 * 된다(실측: bag_3 스톤 30개 소실). 색상(hue)·채도 차이를 함께 본다:
 *  · RGB 거리 > 90, 또는
 *  · 픽셀은 유채색(크로마 ≥ 60)인데 레이어는 무채색(< 30), 또는
 *  · 둘 다 유채색(≥ 50)인데 색상이 45° 넘게 다름
 */
function colorDiffers(layer: number[], r: number, g: number, b: number): boolean {
  if (dist2c(layer, r, g, b) > 90 * 90) return true;
  const chroma = (x: number, y: number, z: number) => Math.max(x, y, z) - Math.min(x, y, z);
  const hue = (x: number, y: number, z: number) => {
    const max = Math.max(x, y, z), min = Math.min(x, y, z), d = max - min;
    if (!d) return 0;
    const h = max === x ? ((y - z) / d) % 6 : max === y ? (z - x) / d + 2 : (x - y) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const cp = chroma(r, g, b), cl = chroma(layer[0], layer[1], layer[2]);
  if (cp >= 60 && cl < 30) return true;
  if (cp >= 50 && cl >= 50) {
    let dh = Math.abs(hue(r, g, b) - hue(layer[0], layer[1], layer[2]));
    if (dh > 180) dh = 360 - dh;
    if (dh > 45) return true;
  }
  return false;
}

/**
 * 색 잔차 회수 — 레이어 색과 확연히 다른 픽셀 덩어리를 새 레이어로 독립시킨다.
 *
 * 판정은 레이어별 최빈색 기준 colorDiffers(). 검은 윤곽선 픽셀(<60)은 어느
 * 레이어에 있든 잔차로 보지 않는다 — 선은 Linework 레이어가 따로 맡는다.
 * 경계의 안티에일리어싱 슬리버는 3×3 열림(opening)으로 지운다.
 * 새 레이어는 면적 큰 순으로 최대 12개, 같은 색끼리는 하나로 묶는다.
 */
async function recoverColorResiduals(
  pending: PendingLayer[],
  rgb: Buffer,
  ch: number,
  bg: Uint8Array,
  W: number,
  H: number,
  remainingPlan: LayerPlan,
  heelSide: "left" | "right" | undefined,
  ink: Uint8Array,
  onProgress?: (m: string) => void,
  mode: "residual" | "uncovered" = "residual",
): Promise<PendingLayer[]> {
  const N = W * H;
  const tag = mode === "uncovered" ? "미포함 전경 회수" : "색 잔차 회수";
  const fills = pending.filter((p) => p.kind !== "line");
  if (!fills.length) return [];

  // 레이어별 현재 색(전해상도 최빈값)과 소유 맵
  const owner = new Int16Array(N).fill(-1);
  const cols: number[][] = [];
  fills.forEach((f, li) => {
    f.color = meanColor(rgb, ch, f.mask, bg);
    cols.push([
      parseInt(f.color.slice(1, 3), 16),
      parseInt(f.color.slice(3, 5), 16),
      parseInt(f.color.slice(5, 7), 16),
    ]);
    for (let i = 0; i < N; i++) if (f.mask[i]) owner[i] = li;
  });

  const resid = new Uint8Array(N);
  let residN = 0;
  if (mode === "uncovered") {
    // 어떤 면 레이어도 덮지 않은 전경 — 스냅의 거리 제한 밖에 남은 픽셀
    // (공중에 뜬 체인·스트랩, 조각이 하나도 안 잡힌 파트)
    for (let i = 0; i < N; i++) if (owner[i] < 0 && !bg[i]) { resid[i] = 1; residN++; }
  } else {
    for (let i = 0; i < N; i++) {
      const li = owner[i];
      if (li < 0 || bg[i] || ink[i]) continue; // 선 픽셀은 면색과 다른 게 정상
      const p = i * ch;
      const r = rgb[p], g = rgb[p + 1], b = rgb[p + 2];
      if (r < 60 && g < 60 && b < 60) continue; // 윤곽선
      if (colorDiffers(cols[li], r, g, b)) { resid[i] = 1; residN++; }
    }
  }
  if (!residN) return [];

  // 해칭된 색면(핑크 바탕 + 어두운 줄무늬)은 잔차가 줄무늬 사이사이로만 잡힌다.
  // 닫힘(팽창→침식)으로 줄 사이를 잇되, 새로 들어오는 픽셀은 선 픽셀일 때만
  // 받는다 — 옆 파트의 정상 면색을 삼키지 않게. 반경은 선 검출 반경과 같다.
  if (mode === "residual") {
    const r = Math.max(2, Math.round(Math.min(W, H) * 0.006));
    const g = new Uint8Array(N);
    for (let i = 0; i < N; i++) g[i] = resid[i] ? 255 : 0;
    const closed = erode(dilate(g, W, H, r), W, H, r);
    let added = 0;
    for (let i = 0; i < N; i++) {
      if (!resid[i] && closed[i] > 127 && ink[i] && owner[i] >= 0 && !bg[i]) { resid[i] = 1; added++; }
    }
    residN += added;
  }

  // 3×3 열림 — 경계 슬리버 제거 (미포함 전경은 체인처럼 가는 구조라 열림을 걸지 않는다)
  const op = mode === "residual" ? open3(resid, W, H) : resid;

  // 라벨링 (조각마다 마스크를 미리 할당하지 않는다 — 전해상도에서 조각 수가 많다)
  const labels = new Int32Array(N).fill(-1);
  const stats: { area: number; sx: number; sy: number; minX: number; maxX: number; minY: number; maxY: number }[] = [];
  const queue = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (!op[s] || labels[s] >= 0) continue;
    const id = stats.length;
    const st = { area: 0, sx: 0, sy: 0, minX: W, maxX: 0, minY: H, maxY: 0 };
    let head = 0, tail = 0;
    queue[tail++] = s; labels[s] = id;
    while (head < tail) {
      const p = queue[head++];
      const x = p % W, y = (p / W) | 0;
      st.area++; st.sx += x; st.sy += y;
      if (x < st.minX) st.minX = x; if (x > st.maxX) st.maxX = x;
      if (y < st.minY) st.minY = y; if (y > st.maxY) st.maxY = y;
      if (x > 0 && op[p - 1] && labels[p - 1] < 0) { labels[p - 1] = id; queue[tail++] = p - 1; }
      if (x < W - 1 && op[p + 1] && labels[p + 1] < 0) { labels[p + 1] = id; queue[tail++] = p + 1; }
      if (y > 0 && op[p - W] && labels[p - W] < 0) { labels[p - W] = id; queue[tail++] = p - W; }
      if (y < H - 1 && op[p + W] && labels[p + W] < 0) { labels[p + W] = id; queue[tail++] = p + W; }
    }
    stats.push(st);
  }

  // 작은 조각도 일단 남긴다 — 파베 스톤·터쿼이즈 비즈처럼 하나하나는 minArea 미만
  // 이지만 같은 색이 여럿 반복되면 한 레이어로 묶여 살아남아야 한다(실측: bag_3
  // 터쿼이즈 스톤 30개, 각 170px). 묶은 뒤 그룹 단위로 크기를 판정한다.
  // 조각 마스크는 라벨 맵으로만 다룬다(조각마다 N바이트를 잡지 않는다).
  const minArea = Math.max(150, N * 0.0008);
  type RComp = { id: number; area: number; cx: number; cy: number; color: string };
  const scratch = new Uint8Array(N);
  const maskOf = (id: number): Uint8Array => {
    scratch.fill(0);
    for (let i = 0; i < N; i++) if (labels[i] === id) scratch[i] = 1;
    return scratch;
  };
  const comps: RComp[] = [];
  for (const [id, st] of stats.entries()) {
    // 20px: 스톤 하나(지름 ~13px, 윤곽·전이 픽셀 제외 후 심 ~25px)도 살아야 반복 디테일로 묶인다
    if (st.area < 20 || Math.min(st.maxX - st.minX, st.maxY - st.minY) < 3) continue;
    const color = meanColor(rgb, ch, maskOf(id), bg);
    // 거의 흰 잔차(하이라이트·메시 구멍)는 파트가 아니다
    const cr = parseInt(color.slice(1, 3), 16), cg = parseInt(color.slice(3, 5), 16), cb = parseInt(color.slice(5, 7), 16);
    if (cr > 235 && cg > 235 && cb > 235) continue;
    comps.push({ id, area: st.area, cx: st.sx / st.area / W, cy: st.sy / st.area / H, color });
  }
  comps.sort((a, b) => b.area - a.area);
  if (comps.length > 200) comps.length = 200;
  if (process.env.VF_DEBUG)
    onProgress?.(`  ${tag}: 잔차 ${residN}px, 라벨 ${stats.length}, 조각 ${comps.length} → ${comps.slice(0, 8).map((c) => `${c.color}:${c.area}`).join(" ")}`);
  if (!comps.length) return [];

  // 한 조각 안에 두 색이 있으면 나눈다 — 닫힘이 인접한 다른 색 잔차(핑크 바 위의
  // 주황 로고 글자)를 한 덩어리로 이어 버리기 때문이다. 대표색에서 먼 픽셀이
  // 충분히 모여 있으면 그 부분을 떼어 새 라벨의 조각으로 만든다(선 픽셀은 원 조각에 남김).
  {
    const extra: RComp[] = [];
    for (const c of comps) {
      if (c.area < minArea) continue; // 작은 조각은 나눌 것도 없다
      const c1 = [parseInt(c.color.slice(1, 3), 16), parseInt(c.color.slice(3, 5), 16), parseInt(c.color.slice(5, 7), 16)];
      const far = new Uint8Array(N);
      let farN = 0;
      for (let i = 0; i < N; i++) {
        if (labels[i] !== c.id || ink[i]) continue;
        const p = i * ch;
        if (dist2c(c1, rgb[p], rgb[p + 1], rgb[p + 2]) > 80 * 80) { far[i] = 1; farN++; }
      }
      if (farN < Math.max(200, c.area * 0.08)) continue;
      // 열림으로 자잘한 점을 지운 뒤 연결요소 (점마다 마스크를 할당하지 않게)
      for (const sub of connectedComponents(open3(far, W, H), W, H, Math.max(150, minArea * 0.5))) {
        const nid = stats.length;
        stats.push({ area: sub.area, sx: 0, sy: 0, minX: 0, maxX: 0, minY: 0, maxY: 0 });
        for (let i = 0; i < N; i++) if (sub.mask[i]) labels[i] = nid;
        c.area -= sub.area;
        extra.push({ id: nid, area: sub.area, cx: sub.cx, cy: sub.cy, color: meanColor(rgb, ch, sub.mask, bg) });
      }
    }
    comps.push(...extra);
  }

  // 같은 색끼리 묶기(색 거리 < 40) — 파베 스톤·반복 로고가 각각 레이어가 되지 않게.
  // 단, 같은 색이라도 멀리 떨어진 큰 조각(힐패널 vs 텅)은 별개 파트다 — 가까운
  // 것끼리만 잇는다(중심 거리 < 긴 변의 18%). 작은 조각(0.3% 미만)끼리는 반복
  // 디테일로 보고 거리와 무관하게 묶는다.
  const colorGroups = new Map<string, RComp[]>();
  {
    const reps: { color: string; key: string }[] = [];
    for (const c of comps) {
      let key = reps.find((r) => colorDist(r.color, c.color) < 40)?.key;
      if (!key) { key = String(reps.length); reps.push({ color: c.color, key }); }
      colorGroups.set(key, [...(colorGroups.get(key) ?? []), c]);
    }
  }
  const groups: RComp[][] = [];
  const near = Math.max(W, H) * 0.18;
  for (const g of colorGroups.values()) {
    const parent = g.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const small = g[i].area < N * 0.003 && g[j].area < N * 0.003;
        const d = Math.hypot((g[i].cx - g[j].cx) * W, (g[i].cy - g[j].cy) * H);
        if (small || d < near) parent[find(i)] = find(j);
      }
    }
    const byRoot = new Map<number, RComp[]>();
    for (let i = 0; i < g.length; i++) byRoot.set(find(i), [...(byRoot.get(find(i)) ?? []), g[i]]);
    groups.push(...byRoot.values());
  }

  // 그룹 단위 크기 판정: 큰 그룹이거나, 작은 조각이 3개 이상 반복되는 그룹만
  const sized = groups
    .map((g) => ({ g, area: g.reduce((a, c) => a + c.area, 0) }))
    .filter(({ g, area }) => area >= minArea || (g.length >= 3 && area >= 300))
    .sort((a, b) => b.area - a.area)
    .slice(0, 12)
    .map(({ g }) => g);
  groups.length = 0;
  groups.push(...sized);
  if (!groups.length) return [];

  const out: PendingLayer[] = [];
  const geoms = groups.map((g, i) => {
    const mask = new Uint8Array(N);
    const ids = new Set(g.map((c) => c.id));
    let area = 0, sx = 0, sy = 0;
    for (let p = 0; p < N; p++) if (labels[p] >= 0 && ids.has(labels[p])) { mask[p] = 1; area++; sx += p % W; sy += (p / W) | 0; }
    // 반복 디테일(작은 조각 여럿)은 윤곽선(선 픽셀)을 뺀 심만 남아 있다 — 2px 팽창해
    // 원래 크기로 되돌린다(배경으로는 안 나간다). 선은 Linework가 위에 그린다.
    if (g.length >= 3 && area < minArea * 3) {
      for (let k = 0; k < 2; k++) {
        const grow: number[] = [];
        for (let p = 0; p < N; p++) {
          if (mask[p] || bg[p]) continue;
          const x = p % W;
          if ((x > 0 && mask[p - 1]) || (x < W - 1 && mask[p + 1]) || (p >= W && mask[p - W]) || (p + W < N && mask[p + W])) grow.push(p);
        }
        for (const p of grow) { mask[p] = 1; area++; sx += p % W; sy += (p / W) | 0; }
      }
    }
    return { index: i, mask, area, count: g.length, color: g[0].color, cx: sx / area / W, cy: sy / area / H, areaPct: +((100 * area) / N).toFixed(2), thin: ribbonWidthOf(mask, W, H) < Math.max(5, Math.min(W, H) * 0.016) };
  });
  // 2차 명명은 엄격하게 — 위치·크기가 딱 맞을 때만(0.9). 잔차 조각은 파트의 일부
  // 인 경우가 많아 느슨하면 프레임 조각이 "Chain Handle"이 된다(실측).
  const ruled = assignByRules(remainingPlan, geoms, { heelSide, minScore: 0.9 });
  const partById = new Map(remainingPlan.parts.map((p) => [p.id, p]));
  const usedNames = new Set(pending.map((p) => p.name));
  let regionSeq = pending.length + 1;
  // 기존 레이어의 리본 폭 — 가는 조각을 몸통에 합치지 않기 위해
  const ribbonWidth = fills.map((f) => {
    let area = 0, perim = 0;
    for (let p = 0; p < N; p++) {
      if (!f.mask[p]) continue;
      area++;
      const x = p % W;
      if ((x > 0 && !f.mask[p - 1]) || (x < W - 1 && !f.mask[p + 1]) || (p >= W && !f.mask[p - W]) || (p + W < N && !f.mask[p + W])) perim++;
    }
    return (2 * area) / Math.max(1, perim);
  });
  for (const g of geoms) {
    // 같은 색의 기존 레이어와 맞닿아 있으면 새 레이어 대신 거기에 합친다 —
    // 스냅 띠가 못 미쳐 잘려 나간 같은 파트의 나머지 조각이다
    // (실측: AIR MAX 바의 왼쪽 절반이 "Region 20"으로 따로 생김).
    // 가늘고 긴 조각(체인·스트랩)은 끝이 몸통에 닿아 있어도 별개 파트다 — 리본
    // 근사 폭(2·면적/둘레)이 스트로크 한계 미만이면 합치지 않는다.
    let gPerim = 0;
    for (let p = 0; p < N; p++) {
      if (!g.mask[p]) continue;
      const x = p % W;
      if ((x > 0 && !g.mask[p - 1]) || (x < W - 1 && !g.mask[p + 1]) || (p >= W && !g.mask[p - W]) || (p + W < N && !g.mask[p + W])) gPerim++;
    }
    const thinLimit = Math.max(5, Math.min(W, H) * 0.016);
    const thin = (2 * g.area) / Math.max(1, gPerim) < thinLimit;
    let mergeInto = -1, mergeTouch = 0;
    for (let li = 0; li < fills.length; li++) {
      if (colorDist(fills[li].color, g.color) > 45) continue;
      // 가는 조각은 역시 가는 레이어(프레임·트림)에만 합친다 — 몸통에는 안 붙인다
      if (thin && ribbonWidth[li] > thinLimit * 2) continue;
      let touch = 0;
      const m = fills[li].mask;
      for (let p = 0; p < N; p++) {
        if (!g.mask[p]) continue;
        const x = p % W;
        if ((x > 0 && m[p - 1]) || (x < W - 1 && m[p + 1]) || (p >= W && m[p - W]) || (p + W < N && m[p + W])) touch++;
      }
      if (touch > mergeTouch) { mergeTouch = touch; mergeInto = li; }
    }
    if (mergeInto >= 0 && mergeTouch >= 20) {
      for (let p = 0; p < N; p++) if (g.mask[p]) { const li = owner[p]; if (li >= 0) fills[li].mask[p] = 0; fills[mergeInto].mask[p] = 1; }
      const target = fills[mergeInto];
      let note = "";
      // 합쳐진 레이어가 이름 없는 조각이었으면(작아서 규칙에 못 걸린 것) 커진
      // 기하로 다시 명명한다 (실측: 힐패널 조각 0.3% → 합쳐서 2.4% → Heel Counter)
      if (/^Region \d+$/.test(target.name)) {
        let area = 0, sx = 0, sy = 0;
        for (let p = 0; p < N; p++) if (target.mask[p]) { area++; sx += p % W; sy += (p / W) | 0; }
        const stillFree = { ...remainingPlan, parts: remainingPlan.parts.filter((p) => !pending.some((q) => q.partId.replace(/_\d+$/, "") === p.id)) };
        const r = assignByRules(stillFree, [{ index: 0, cx: sx / area / W, cy: sy / area / H, areaPct: (100 * area) / N, color: target.color }], { heelSide });
        const part = r[0] ? partById.get(r[0].partId) : undefined;
        if (part && !usedNames.has(part.name)) {
          note = ` → "${part.name}"로 명명`;
          usedNames.delete(target.name);
          usedNames.add(part.name);
          target.name = part.name; target.partId = part.id; target.parent = part.parent; target.kind = part.kind;
        }
      }
      onProgress?.(`${tag}: ${g.area}px → "${target.name}"에 합침${note}`);
      continue;
    }
    const partId = ruled.find((r) => r.index === g.index)?.partId;
    const part = partId ? partById.get(partId) : undefined;
    const seq = regionSeq++;
    let name = part?.name ?? (g.count > 1 ? `Detail ×${g.count}` : `Region ${seq}`);
    let n = 1;
    while (usedNames.has(name)) name = `${part?.name ?? "Region"} ${++n}`;
    usedNames.add(name);
    const id = (part?.id ?? `region_${seq}`) + (n > 1 ? `_${n}` : "");
    // 원래 소유 레이어에서 빼낸다
    for (let p = 0; p < N; p++) if (g.mask[p]) { const li = owner[p]; if (li >= 0) fills[li].mask[p] = 0; }
    const layer: PendingLayer = {
      mask: g.mask,
      color: g.color,
      partId: id,
      name,
      parent: part?.parent ?? guessParent(remainingPlan.category, g.cy),
      kind: kindFor(part?.kind, g.color),
      area: g.area,
      repeated: g.count >= 3,
    };
    pending.push(layer);
    out.push(layer);
    onProgress?.(`${tag}: "${name}" ${g.color} ${g.area}px${g.count > 1 ? ` (조각 ${g.count})` : ""}`);
  }
  return out;
}


/**
 * 이진 닫힘(팽창 후 침식) — 마스크의 작은 구멍을 메운다.
 * 경계는 팽창·침식이 상쇄되어 거의 그대로 유지된다.
 */
function closeHoles(m: Uint8Array, W: number, H: number, r = 2): void {
  const dil = new Uint8Array(W * H);
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= W || y >= H ? 0 : m[y * W + x];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let on = 0;
      for (let dy = -r; dy <= r && !on; dy++)
        for (let dx = -r; dx <= r && !on; dx++) if (at(x + dx, y + dy)) on = 1;
      dil[y * W + x] = on;
    }
  }
  const atD = (x: number, y: number) =>
    x < 0 || y < 0 || x >= W || y >= H ? 0 : dil[y * W + x];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let all = 1;
      for (let dy = -r; dy <= r && all; dy++)
        for (let dx = -r; dx <= r && all; dx++) if (!atD(x + dx, y + dy)) all = 0;
      m[y * W + x] = all;
    }
  }
}

/**
 * 배경 마스크 — **테두리에서 연결된 밝은 영역**만 배경으로 본다.
 *
 * "밝으면 배경"으로 판정하면 흰 운동화·은반지·아이보리 가방처럼 밝은 제품의
 * 파트가 색 계산에서 통째로 빠져, 남은 어두운 가장자리 색으로 칠해진다
 * (실측: 은반지가 #a1a1a1 회색으로 칠해지고 색오차 129).
 * 테두리 연결성으로 판정하면 제품 안의 흰 파트는 전경으로 남는다.
 */
function backgroundMask(
  rgba: Buffer,
  channels: number,
  W: number,
  H: number,
): Uint8Array {
  const N = W * H;
  const bg = new Uint8Array(N);
  const light = (i: number) => {
    const p = i * channels;
    return rgba[p] > 238 && rgba[p + 1] > 238 && rgba[p + 2] > 238;
  };
  const queue = new Int32Array(N);
  let head = 0, tail = 0;
  const push = (i: number) => {
    if (bg[i] || !light(i)) return;
    bg[i] = 1;
    queue[tail++] = i;
  };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (head < tail) {
    const cur = queue[head++];
    const x = cur % W, y = (cur / W) | 0;
    if (x > 0) push(cur - 1);
    if (x < W - 1) push(cur + 1);
    if (y > 0) push(cur - W);
    if (y < H - 1) push(cur + W);
  }
  return bg;
}

/**
 * 마스크 영역의 대표색 = **최빈값(mode)**, 그 안에서 다시 평균.
 *
 * 단순 평균을 쓰면 안 된다. 파트는 보통 "넓은 면색 + 어두운 윤곽선"의
 * 이봉 분포라, 평균이 둘 사이의 엉뚱한 중간값으로 떨어진다
 * (실측: 플랫의 75%가 #f0f0f0인 은반지가 #9a9a9a 회색으로 칠해짐).
 * 4비트로 양자화해 가장 많은 구간을 고르고, 그 구간 안에서만 평균을 낸다.
 */
function meanColor(
  rgba: Buffer,
  channels: number,
  mask: Uint8Array,
  bg?: Uint8Array,
): string {
  const bins = new Map<number, number>();
  let total = 0, dark = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    if (bg ? bg[i] : false) continue;
    const p = i * channels;
    const R = rgba[p], G = rgba[p + 1], B = rgba[p + 2];
    if (!bg && R > 245 && G > 245 && B > 245) continue;
    total++;
    if (R < 25 && G < 25 && B < 25) dark++;
    const k = ((R >> 4) << 8) | ((G >> 4) << 4) | (B >> 4);
    bins.set(k, (bins.get(k) ?? 0) + 1);
  }
  if (!bins.size) return "#cccccc";
  // 거의 검은 픽셀은 보통 윤곽선이라 대표색에서 뺀다 — 단, 파트 자체가 검정이면
  // (마스크의 과반이 검정) 그것이 면색이다. 예전엔 무조건 뺐더니 순검정 파트가
  // 빈 히스토그램 → #cccccc 회색으로 칠해질 수 있었다.
  // 큰 파트(캔버스 1% 초과)는 과반이 검정이면 검정 파트다. 작은 파트(체인·트림)는
  // 어두운 윤곽이 픽셀의 70%까지 차지해도 안쪽 재질색(금)을 대표색으로 쓴다 —
  // 큰 파트에 70%를 쓰면 검정 갑피(#171717, 60% "검정")가 핑크로 뒤집힌다(실측).
  const skipDark = dark < total * (total > mask.length * 0.01 ? 0.5 : 0.7);
  const isDarkBin = (k: number) => (k >> 8) <= 1 && ((k >> 4) & 15) <= 1 && (k & 15) <= 1;
  let best = -1, bestN = 0;
  for (const [k, n] of bins) {
    if (skipDark && isDarkBin(k)) continue;
    if (n > bestN) { bestN = n; best = k; }
  }
  if (best < 0) for (const [k, n] of bins) if (n > bestN) { bestN = n; best = k; }

  // 뽑힌 구간 안에서 정밀 평균
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    if (bg ? bg[i] : false) continue;
    const p = i * channels;
    const R = rgba[p], G = rgba[p + 1], B = rgba[p + 2];
    if (((R >> 4) << 8 | (G >> 4) << 4 | (B >> 4)) !== best) continue;
    r += R; g += G; b += B; n++;
  }
  if (!n) return "#cccccc";
  const hx = (v: number) =>
    Math.max(0, Math.min(252, Math.round(v / n))).toString(16).padStart(2, "0");
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

/** 두 hex 색 사이의 유클리드 거리 */
function colorDist(a: string, b: string): number {
  const p = (s: string) => [
    parseInt(s.slice(1, 3), 16),
    parseInt(s.slice(3, 5), 16),
    parseInt(s.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}

function dist2c(c: number[], r: number, g: number, b: number): number {
  return (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
}

/** 컴포넌트들을 번호가 매겨진 그리드 이미지로 (GPT 명명용) */
async function buildContactSheet(
  masks: Uint8Array[],
  mW: number,
  mH: number,
  dest: string,
): Promise<void> {
  const TILE = 200;
  const cols = Math.min(5, Math.max(1, masks.length));
  const rows = Math.ceil(masks.length / cols);
  const tiles = await Promise.all(
    masks.map(async (m, i) => {
      const gray = Buffer.alloc(mW * mH);
      // 도형은 검정, 배경은 흰색 (GPT가 보기 쉽게)
      for (let p = 0; p < m.length; p++) gray[p] = m[p] ? 30 : 245;
      const img = await sharp(gray, { raw: { width: mW, height: mH, channels: 1 } })
        .resize(TILE - 8, TILE - 8, { fit: "contain", background: "#ffffff" })
        .extend({ top: 4, bottom: 4, left: 4, right: 4, background: "#787878" })
        .png()
        .toBuffer();
      return { input: img, left: (i % cols) * TILE, top: Math.floor(i / cols) * TILE };
    }),
  );
  await sharp({
    create: { width: cols * TILE, height: rows * TILE, channels: 3, background: "#ffffff" },
  })
    .composite(tiles)
    .png()
    .toFile(dest);
}


function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter++;
    if (a[i] || b[i]) uni++;
  }
  return uni ? inter / uni : 0;
}

/** SAM 마스크 ∩ Qwen 조각. 교집합이 너무 작으면 SAM 쪽을 그대로 쓴다. */
function intersect(sam: Uint8Array, comp: Uint8Array): Uint8Array {
  const out = new Uint8Array(sam.length);
  let n = 0, compN = 0;
  for (let i = 0; i < sam.length; i++) {
    if (comp[i]) compN++;
    if (sam[i] && comp[i]) { out[i] = 1; n++; }
  }
  return n < compN * 0.5 ? sam : out;
}

/** Layer Plan에서 가장 먼저 등장하는 parent (베이스가 들어갈 그룹) */
function firstParent(plan: LayerPlan): string {
  const p = plan.parts.find((x) => x.parent && x.parent !== "CONSTRUCTION");
  return p?.parent ?? "BODY";
}

function guessParent(category: string, cy: number): string {
  if (category === "footwear") return cy > 0.62 ? "SOLE" : "UPPER";
  if (category === "bag") return cy < 0.3 ? "HANDLES" : "BODY";
  if (category === "jewelry") return "STRUCTURE";
  return "PARTS";
}
