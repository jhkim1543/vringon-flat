import sharp from "sharp";
import { config } from "../config.js";
import { vectorizeAI } from "../clients/vectorizerClient.js";
import { vtraceLayer } from "../vector/vtracerEngine.js";
import { optimizePathData } from "../vector/optimize.js";
import { centerlineTrace } from "../vector/centerline.js";
import type { VectorIR, IRLayer, IRPath } from "../types.js";
import type { LayerPng } from "./layers.js";

/**
 * 레이어별 벡터화 + 자체 Vector Optimizer.
 * 전체 이미지를 한 번에 벡터화하지 않고 semantic 레이어 PNG를 개별 벡터화한다.
 * 엔진은 VTracer(기본, 로컬). Vectorizer.AI는 VECTORIZER_FORCE=1 일 때만.
 */
export async function vectorizeLayers(
  layers: LayerPng[],
  width: number,
  height: number,
  onProgress?: (msg: string) => void,
): Promise<{ ir: VectorIR; engine: string }> {
  // 기본은 VTracer (로컬·무과금·스플라인 적합 제어 가능).
  // Vectorizer.AI는 품질 문제로 기본에서 제외 — VECTORIZER_FORCE=1 일 때만 사용.
  const useVAI = config.hasVectorizerAI && config.forceVectorizerAI;
  const engine = useVAI ? "Vectorizer.AI (강제)" : "VTracer (로컬)";

  // IR 배열 = 페인팅 순서(아래→위). 선(CONSTRUCTION/Linework)은 맨 마지막에
  // 그려져 면 위에 올라온다. 라이터들이 패널 순서를 맞춰 뒤집는다.
  const parents = [...new Set(layers.map((l) => l.parent))].sort((a, b) =>
    a === "CONSTRUCTION" ? 1 : b === "CONSTRUCTION" ? -1 : 0,
  );

  const fillLayers = layers.filter((l) => l.kind !== "line");
  // 제품 영역 마스크 — 이 밖의 선은 그림자·반사 잔상이므로 버린다
  const fillArea = await buildFillAreaMask(fillLayers, width, height);

  // 면 경계 중복선 제거는 **더 이상 하지 않는다**.
  //
  // 이 규칙은 선을 라인아트(별개 생성 이미지)에서 뽑던 시절의 것이다. 그때는
  // 면과 선이 몇 px 어긋나 파트 경계마다 선이 이중으로 보였다. 지금은 선을
  // 컬러플랫 자체에서 뽑으므로 파트 경계선이 면 경계와 **정확히 일치**하는데,
  // 그러면 이 규칙이 정상 윤곽선을 전부 삭제해 버린다
  // (실측: recall 46~77%로 급락, precision은 100%였다 = 선을 빠뜨리기만 함).
  // 면에는 stroke가 없으므로 이 선들이 도면의 유일한 윤곽선이다.
  const fillEdges = undefined;

  const irLayers: IRLayer[] = [];
  for (const parent of parents) {
    const irLayer: IRLayer = { name: parent, groups: [] };
    for (const layer of layers.filter((l) => l.parent === parent)) {
      try {
        // 선 레이어는 중심선을 뽑아 열린 stroke 패스로 만든다.
        // 리본 외곽선을 그대로 stroke로 그리면 속 빈 이중선이 된다(실측).
        if (layer.kind === "line" && !useVAI) {
          const cl = await centerlineTrace(layer.pngPath, {
            color: "#111111",
            fillEdges,
            fillArea,
            onNote: (m) => onProgress?.(`${layer.name}: ${m}`),
          });
          if (cl.length) {
            irLayer.groups.push({ name: layer.name, paths: cl });
            onProgress?.(`${layer.name}: ${cl.length} centerline paths`);
            continue;
          }
          onProgress?.(`${layer.name}: 중심선 추출 실패 → 외곽선 추적으로 폴백`);
        }

        // 얇은 파트(프레임·체인·스트랩)는 면이 아니라 컬러 스트로크로.
        // 면으로 추적하면 뭉개져 소실된다(실측: bag_2 금색 프레임).
        if (layer.kind === "stroke" && !useVAI) {
          const cl = await centerlineTrace(layer.pngPath, {
            color: layer.dominantColor,
            inkThreshold: 250, // 흰 배경이 아닌 모든 픽셀이 잉크
            minLength: 4, // 파트 자체가 짧을 수 있으므로 질감 필터 완화
            onNote: (m) => onProgress?.(`${layer.name}: ${m}`),
          });
          if (cl.length) {
            irLayer.groups.push({ name: layer.name, paths: cl });
            onProgress?.(`${layer.name}: ${cl.length} stroke paths (얇은 파트)`);
            continue;
          }
          onProgress?.(`${layer.name}: 스트로크 추출 실패 → 면 추적으로 폴백`);
        }

        const rawPaths = useVAI
          ? await vectorizeWithVAI(layer)
          : await vtraceLayer(layer.pngPath, {
              kind: layer.kind === "line" ? "line" : "fill",
              color: layer.kind === "line" ? "#111111" : layer.dominantColor,
            });

        const paths: IRPath[] = [];
        for (const rp of rawPaths) {
          const { d } = optimizePathData(rp.d, { minArea: layer.kind === "line" ? 2 : 6 });
          if (!d) continue;
          paths.push({
            d,
            fill: rp.fill,
            stroke: rp.stroke,
            strokeWidth: rp.strokeWidth,
            vectorizer: rp.vectorizer,
          });
        }
        if (paths.length) irLayer.groups.push({ name: layer.name, paths });
        onProgress?.(`${layer.name}: ${paths.length} paths`);
      } catch (e) {
        onProgress?.(`${layer.name} 벡터화 실패: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    if (irLayer.groups.length) irLayers.push(irLayer);
  }

  return { ir: { width, height, layers: irLayers }, engine };
}

/**
 * **면끼리 맞닿는 경계**만 모은 마스크.
 *
 * 제품 외곽선(면↔배경 경계)은 테크팩에서 반드시 있어야 하므로 제외한다.
 * 모든 경계를 대상으로 삼았더니 외곽선까지 지워져 도면이 색면만 남았다(실측).
 * 여기서는 반경 안에 **서로 다른 두 면 레이어**가 함께 있는 픽셀만 잡는다.
 */
async function buildFillEdgeMask(
  fills: LayerPng[],
  W: number,
  H: number,
): Promise<{ mask: Uint8Array; width: number; height: number } | undefined> {
  if (fills.length < 2) return undefined;
  // 판정 해상도는 원본의 절반이면 충분하고 훨씬 빠르다
  const w = Math.max(64, Math.round(W / 2));
  const h = Math.max(64, Math.round(H / 2));

  // 픽셀별 소속 레이어 (겹치면 나중 것이 이김). -1 = 배경
  const label = new Int16Array(w * h).fill(-1);
  for (let li = 0; li < fills.length; li++) {
    const { data, info } = await sharp(fills[li].pngPath)
      .flatten({ background: "#ffffff" })
      .resize(w, h, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    for (let i = 0; i < w * h; i++) if (data[i * ch] < 245) label[i] = li;
  }

  // 라인아트와 컬러플랫은 서로 다른 후보 이미지라 경계가 몇 px 어긋난다.
  // R은 그 오차를 흡수할 만큼만 준다 (반 해상도 기준 2px = 원본 4px).
  const R = 2;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let first = -1;
      let mixed = false;
      for (let dy = -R; dy <= R && !mixed; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const l = label[ny * w + nx];
          if (l < 0) continue; // 배경은 무시 — 외곽선을 지우지 않기 위해
          if (first < 0) first = l;
          else if (l !== first) { mixed = true; break; }
        }
      }
      if (mixed) mask[y * w + x] = 1;
    }
  }
  return { mask, width: w, height: h };
}

/**
 * 면 레이어 합집합을 약간 넓힌 "제품 영역" 마스크.
 * 선 레이어에서 이 밖에 놓인 체인은 그림자·반사 잔상이므로 버리는 데 쓴다.
 */
async function buildFillAreaMask(
  fills: LayerPng[],
  W: number,
  H: number,
): Promise<{ mask: Uint8Array; width: number; height: number } | undefined> {
  if (!fills.length) return undefined;
  const w = Math.max(64, Math.round(W / 2));
  const h = Math.max(64, Math.round(H / 2));
  const uni = new Uint8Array(w * h);
  for (const f of fills) {
    const { data, info } = await sharp(f.pngPath)
      .flatten({ background: "#ffffff" })
      .resize(w, h, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    for (let i = 0; i < w * h; i++) if (data[i * ch] < 245) uni[i] = 1;
  }
  // 윤곽선은 면 바깥으로 살짝 나가므로 여유를 준다
  const g = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) g[i] = uni[i] ? 255 : 0;
  const { data: d, info: di } = await sharp(g, { raw: { width: w, height: h, channels: 1 } })
    .blur(3)
    .threshold(12)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = d[i * di.channels] > 127 ? 1 : 0;
  return { mask, width: w, height: h };
}

interface RawPath {
  d: string;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  vectorizer: IRPath["vectorizer"];
}

/** Vectorizer.AI: 컬러 레이어 PNG → SVG → path 추출 */
async function vectorizeWithVAI(layer: LayerPng): Promise<RawPath[]> {
  const svg = await vectorizeAI(layer.pngPath);
  const out: RawPath[] = [];
  const re = /<path\b[^>]*?\bd="([^"]+)"[^>]*?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const tag = m[0];
    const fill = /fill="([^"]+)"/.exec(tag)?.[1];
    if (fill === "#ffffff" || fill === "#FFFFFF" || fill === "white") continue; // 배경 제거
    out.push({
      d: m[1],
      fill: fill && fill !== "none" ? fill : layer.dominantColor,
      stroke: null,
      strokeWidth: 0,
      vectorizer: "vectorizer.ai",
    });
  }
  return out;
}
