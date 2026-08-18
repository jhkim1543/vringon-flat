import sharp from "sharp";
import type { VectorIR } from "../types.js";
import type { LayerPng } from "./layers.js";

/**
 * 원본 재합성 QA.
 *
 * 이전 파이프라인의 구멍: 후보 이미지만 원본과 대조하고 **레이어 분해 결과는
 * 아무도 검증하지 않았다.** 그 결과 Toe Cap과 Vamp가 IoU 0.63으로 사실상
 * 같은 도형인데도 "done"으로 보고됐다.
 *
 * 여기서는 레이어를 다시 쌓아 비교하고, 레이어끼리의 중복도 잡는다.
 *
 * 비교 대상은 원본 사진이 아니라 **정렬된 플랫 이미지**다. 레이어는 플랫에서
 * 파생되므로 플랫과 대조해야 "분해가 잘 됐는가"를 재는 것이 되고, 사진과
 * 대조하면 플랫 생성 단계의 실루엣 차이까지 섞여 지표가 흐려진다.
 * 플랫이 사진을 얼마나 잘 재현했는지는 3단계 candidate 평가가 이미 잰다.
 */

export interface QaReport {
  pass: boolean;
  coverage: number; // 원본 전경 중 레이어가 덮은 비율
  spill: number; // 원본 배경을 침범한 비율
  duplicates: { a: string; b: string; iou: number }[];
  emptyLayers: string[];
  /**
   * 색상 ΔE — 레이어를 실제 색으로 다시 칠해 플랫과 비교한 평균 색차(0~441).
   * 형태 지표(coverage/spill)만으로는 "모양은 맞는데 색이 틀린" 결함을 못 잡는다
   * (실측: 은반지가 회색으로, 미드솔이 남색으로 칠해져도 coverage 100%).
   */
  colorDeltaE: number;
  /** 색차가 큰 레이어 (디자이너가 확인해야 할 곳) */
  colorOutliers: { name: string; deltaE: number }[];
  notes: string[];
}

const SIZE = 384;

export async function compositeQa(
  layers: LayerPng[],
  originalPath: string,
): Promise<QaReport> {
  const notes: string[] = [];

  const orig = await binary(originalPath);
  const masks = new Map<string, Uint8Array>();
  const emptyLayers: string[] = [];

  for (const l of layers) {
    if (l.kind === "line") continue; // 선 레이어는 면적 기준 대상이 아님
    const m = await binary(l.pngPath);
    let n = 0;
    for (let i = 0; i < m.length; i++) n += m[i];
    // 스트로크 파트(체인·가는 트림)는 원래 면적이 작다 — 픽셀이 아예 없을 때만 빈 것
    // 0.02%: 분해 단계가 남기는 최소 면 레이어 크기와 맞춘다 (작은 아일릿·스톤은 정상)
    if (n < (l.kind === "stroke" ? 4 : SIZE * SIZE * 0.0002)) {
      emptyLayers.push(l.name);
      continue;
    }
    masks.set(l.name, m);
  }

  // 합성 = 모든 파트 레이어의 합집합
  const union = new Uint8Array(SIZE * SIZE);
  for (const m of masks.values()) for (let i = 0; i < m.length; i++) if (m[i]) union[i] = 1;

  let origN = 0, covered = 0, spilled = 0, bgN = 0;
  for (let i = 0; i < union.length; i++) {
    if (orig[i]) {
      origN++;
      if (union[i]) covered++;
    } else {
      bgN++;
      if (union[i]) spilled++;
    }
  }
  const coverage = origN ? covered / origN : 0;
  const spill = bgN ? spilled / bgN : 0;

  // 레이어 간 중복 = "같은 형상이 두 번" 인 경우만.
  // 포함 관계(베이스 몸통 ⊃ 오버레이 파트)는 레이어드 도면의 정상 구조이므로
  // 결함이 아니다. 따라서 IoU가 매우 높을 때만 중복으로 본다.
  const duplicates: QaReport["duplicates"] = [];
  const entries = [...masks.entries()];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const v = iou(entries[i][1], entries[j][1]);
      if (v > 0.8) duplicates.push({ a: entries[i][0], b: entries[j][0], iou: +v.toFixed(3) });
    }
  }
  duplicates.sort((a, b) => b.iou - a.iou);

  if (coverage < 0.8) notes.push(`원본 전경의 ${((1 - coverage) * 100).toFixed(0)}%가 어떤 레이어에도 없음`);
  if (spill > 0.08) notes.push(`배경 침범 ${(spill * 100).toFixed(1)}%`);
  if (duplicates.length) notes.push(`중복 레이어 ${duplicates.length}쌍 (최대 IoU ${duplicates[0].iou})`);
  if (emptyLayers.length) notes.push(`빈 레이어: ${emptyLayers.join(", ")}`);

  // ── 색상 ΔE — 레이어를 실제 색으로 재합성해 플랫과 비교 ──────
  // 페인팅 순서(배열 순)대로 칠하면 위 레이어가 아래를 덮는다.
  const { deltaE, outliers } = await colorDeltaE(layers, originalPath);
  if (deltaE > 60) notes.push(`색차 큼 (평균 ΔE ${deltaE.toFixed(0)})`);
  if (outliers.length)
    notes.push(`색 확인 필요: ${outliers.map((o) => `${o.name}(${o.deltaE.toFixed(0)})`).join(", ")}`);

  return {
    pass: coverage >= 0.8 && spill <= 0.08 && duplicates.length === 0 && deltaE <= 60,
    coverage: +coverage.toFixed(3),
    spill: +spill.toFixed(3),
    duplicates,
    emptyLayers,
    colorDeltaE: +deltaE.toFixed(1),
    colorOutliers: outliers,
    notes,
  };
}

/**
 * 레이어(솔리드 색면)를 순서대로 재합성해 플랫과 픽셀 색차를 잰다.
 * 레이어별로도 재서 유독 틀린 레이어를 골라낸다.
 */
async function colorDeltaE(
  layers: LayerPng[],
  flatPath: string,
): Promise<{ deltaE: number; outliers: { name: string; deltaE: number }[] }> {
  const { data: flat, info } = await sharp(flatPath)
    .flatten({ background: "#ffffff" })
    .resize(SIZE, SIZE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;

  // 재합성 캔버스 — 흰색에서 시작해 레이어 순서대로 덮어쓴다
  const comp = new Uint8Array(SIZE * SIZE * 3).fill(255);
  const owner = new Int16Array(SIZE * SIZE).fill(-1);
  const fills = layers.filter((l) => l.kind !== "line");
  for (let li = 0; li < fills.length; li++) {
    const l = fills[li];
    const m = await binary(l.pngPath);
    const r = parseInt(l.dominantColor.slice(1, 3), 16);
    const g = parseInt(l.dominantColor.slice(3, 5), 16);
    const b = parseInt(l.dominantColor.slice(5, 7), 16);
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (!m[i]) continue;
      comp[i * 3] = r; comp[i * 3 + 1] = g; comp[i * 3 + 2] = b;
      owner[i] = li;
    }
  }

  // 선 레이어(Linework)가 덮는 픽셀은 최종 도면에서 선이 위에 그려지므로 면색을
  // 따지지 않는다 — 메시·해칭·스티치가 촘촘한 제품은 선 픽셀이 전경의 20%를 넘어
  // 면 ΔE를 부풀린다(실측: 메시 백 ΔE 65, 스톤·몸통은 정확).
  const lineCover = new Uint8Array(SIZE * SIZE);
  for (const l of layers) {
    if (l.kind !== "line") continue;
    const m = await binary(l.pngPath);
    for (let i = 0; i < SIZE * SIZE; i++) if (m[i]) lineCover[i] = 1;
  }

  // 전경 픽셀(플랫이 흰색이 아닌 곳)에서만 색차
  let sum = 0, n = 0;
  const perLayer = new Map<number, { s: number; n: number }>();
  for (let i = 0; i < SIZE * SIZE; i++) {
    const p = i * ch;
    const fr = flat[p], fg = flat[p + 1], fb = flat[p + 2];
    if (fr > 245 && fg > 245 && fb > 245) continue;
    if (lineCover[i]) continue;
    const o = owner[i];
    // 플랫의 검은 윤곽선 픽셀은 제외 (레이어는 선을 안 칠하므로 항상 틀림) —
    // 단, 그 픽셀을 가진 레이어 자체가 검정이면 면색이므로 정상 집계한다.
    // 안 그러면 검정 파트는 "맞는 픽셀"이 전부 빠지고 가장자리만 남아
    // 평균 ΔE가 138로 부풀려진다(실측: shoe_1 Quarter).
    if (fr < 40 && fg < 40 && fb < 40) {
      const dark = o >= 0 && comp[i * 3] < 70 && comp[i * 3 + 1] < 70 && comp[i * 3 + 2] < 70;
      if (!dark) continue;
    }
    const d = Math.hypot(comp[i * 3] - fr, comp[i * 3 + 1] - fg, comp[i * 3 + 2] - fb);
    sum += d; n++;
    if (o >= 0) {
      const e = perLayer.get(o) ?? { s: 0, n: 0 };
      e.s += d; e.n++;
      perLayer.set(o, e);
    }
  }
  const deltaE = n ? sum / n : 0;
  const outliers: { name: string; deltaE: number }[] = [];
  for (const [li, e] of perLayer) {
    if (e.n < SIZE * SIZE * 0.002) continue; // 너무 작은 레이어는 노이즈
    const de = e.s / e.n;
    if (de > 90) outliers.push({ name: fills[li].name, deltaE: +de.toFixed(1) });
  }
  outliers.sort((a, b) => b.deltaE - a.deltaE);
  return { deltaE, outliers: outliers.slice(0, 5) };
}

/**
 * 벡터 IR의 편집성·유효성 점검.
 *
 * 앵커 과다·빈 그룹에 더해 **Illustrator에서 열었을 때 깨지는 패스**를 잡는다:
 * NaN/Infinity 좌표, 캔버스 밖으로 크게 벗어난 좌표, 퇴화 세그먼트(길이 0),
 * fill인데 닫히지 않은 서브패스. 이런 패스는 .ai를 열 때 경고가 뜨거나
 * 도형이 사라진다. QA 게이트에서 미리 잡아 산출물에 남지 않게 한다.
 */
export function editabilityCheck(ir: VectorIR): string[] {
  const notes: string[] = [];
  const W = ir.width, H = ir.height;
  const margin = Math.max(W, H) * 0.5;
  let invalidTotal = 0, degenerateTotal = 0, unclosedTotal = 0;

  for (const layer of ir.layers) {
    for (const g of layer.groups) {
      const anchors = g.paths.reduce(
        (n, p) => n + (p.d.match(/[LC]/g) ?? []).length,
        0,
      );
      if (anchors > 1200)
        notes.push(`${layer.name}/${g.name}: 앵커 ${anchors}개 — 편집이 무거움`);
      if (!g.paths.length) notes.push(`${layer.name}/${g.name}: 빈 그룹`);

      for (const p of g.paths) {
        // 좌표 유효성
        const nums = (p.d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
        if (nums.some((v) => !Number.isFinite(v))) { invalidTotal++; continue; }
        for (let i = 0; i + 1 < nums.length; i += 2) {
          if (nums[i] < -margin || nums[i] > W + margin || nums[i + 1] < -margin || nums[i + 1] > H + margin) {
            invalidTotal++;
            break;
          }
        }
        // 퇴화 — 세그먼트가 하나도 없거나 이동 명령뿐
        if (!/[LC]/.test(p.d)) degenerateTotal++;
        // fill인데 닫히지 않음 (서브패스 단위)
        if (p.fill && !p.stroke) {
          const subs = p.d.split(/(?=M)/).filter(Boolean);
          if (subs.some((s) => /[LC]/.test(s) && !/Z\s*$/i.test(s.trim()))) unclosedTotal++;
        }
      }
    }
  }
  if (invalidTotal) notes.push(`좌표 이상 패스 ${invalidTotal}개 (NaN/범위 밖)`);
  if (degenerateTotal) notes.push(`퇴화 패스 ${degenerateTotal}개 (세그먼트 없음)`);
  if (unclosedTotal) notes.push(`미닫힘 fill 패스 ${unclosedTotal}개`);
  return notes;
}

/**
 * IR에서 유효하지 않은 패스를 제거한다 (검사와 분리된 정화 단계).
 * 반환: 제거된 개수. Illustrator가 열지 못하는 산출물을 만들지 않기 위함.
 */
export function sanitizeIr(ir: VectorIR): number {
  const W = ir.width, H = ir.height;
  const margin = Math.max(W, H) * 0.5;
  let removed = 0;
  for (const layer of ir.layers) {
    for (const g of layer.groups) {
      g.paths = g.paths.filter((p) => {
        const nums = (p.d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
        if (!nums.length || nums.some((v) => !Number.isFinite(v))) { removed++; return false; }
        for (let i = 0; i + 1 < nums.length; i += 2) {
          if (nums[i] < -margin || nums[i] > W + margin || nums[i + 1] < -margin || nums[i + 1] > H + margin) {
            removed++;
            return false;
          }
        }
        if (!/[LC]/.test(p.d)) { removed++; return false; }
        // fill의 미닫힘 서브패스는 닫아 준다 (삭제보다 보존이 낫다)
        if (p.fill && !p.stroke) {
          p.d = p.d
            .split(/(?=M)/)
            .filter(Boolean)
            .map((s) => (/[LC]/.test(s) && !/Z\s*$/i.test(s.trim()) ? s.trim() + "Z" : s))
            .join("");
        }
        return true;
      });
    }
    layer.groups = layer.groups.filter((g) => g.paths.length);
  }
  ir.layers = ir.layers.filter((l) => l.groups.length);
  return removed;
}

async function binary(imagePath: string): Promise<Uint8Array> {
  const { data, info } = await sharp(imagePath)
    .flatten({ background: "#ffffff" })
    .resize(SIZE, SIZE, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) out[i] = data[i * info.channels] < 245 ? 1 : 0;
  return out;
}

function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter++;
    if (a[i] || b[i]) uni++;
  }
  return uni ? inter / uni : 0;
}
