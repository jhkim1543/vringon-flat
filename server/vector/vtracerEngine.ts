import { vectorize, ColorMode, Hierarchical, PathSimplifyMode } from "@neplex/vectorizer";
import sharp from "sharp";
import { parsePath, serializePath } from "./pathdata.js";
import type { IRPath } from "../types.js";

/**
 * VTracer 벡터화 엔진 (로컬, 무과금).
 *
 * potrace 대비 이점은 스플라인 적합 제어권이다 — cornerThreshold로 코너를
 * 보존하고 spliceThreshold/lengthThreshold로 앵커 수를 직접 줄일 수 있어
 * Illustrator 편집성이 좋은 패스가 나온다.
 *
 * 레이어 PNG는 단색 솔리드 영역이므로 Binary 모드로 실루엣만 추적하고
 * 색은 레이어의 대표색을 입힌다 (컬러 클러스터링은 노이즈를 만든다).
 */

export interface VtraceOptions {
  /** 선 레이어는 얇은 획이라 speckle 필터를 낮춘다 */
  kind: "fill" | "line" | "logo";
  /** 결과 패스에 입힐 색 */
  color: string;
  /** Retry small glyph clearances when the usual spline overshoots the mask. */
  tight?: boolean;
}

export async function vtraceLayer(pngPath: string, opts: VtraceOptions): Promise<IRPath[]> {
  const isLine = opts.kind === "line";

  // 흰 배경 위 도형 → 흑백 실루엣. VTracer Binary는 어두운 픽셀을 도형으로 본다.
  const binary = await sharp(pngPath)
    .flatten({ background: "#ffffff" })
    .greyscale()
    .threshold(isLine ? 170 : 250)
    .png()
    .toBuffer();

  const svg = await vectorize(binary, {
    colorMode: ColorMode.Binary,
    hierarchical: Hierarchical.Stacked,
    mode: PathSimplifyMode.Spline,
    // 노이즈 조각 제거 — 선은 스티치가 작아서 보수적으로
    filterSpeckle: opts.tight ? 1 : isLine ? 3 : 5,
    colorPrecision: 6,
    layerDifference: 16,
    // 아래 면 레이어 값은 실측 튜닝 결과다: 기본값(45/6/60) 대비
    // 앵커 18% 감소하면서 충실도(IoU 95.6%)는 동일했다.
    cornerThreshold: isLine ? 60 : 60,
    lengthThreshold: opts.tight ? 2 : isLine ? 4 : 10,
    maxIterations: 10,
    spliceThreshold: opts.tight ? 45 : isLine ? 45 : 75,
    pathPrecision: opts.tight ? 3 : 2,
  });

  return extractPaths(svg, opts.color);
}

/**
 * VTracer SVG에서 path를 뽑는다.
 *
 * 중요: VTracer는 각 패스를 `transform="translate(tx,ty)"` 로 배치하고 d는 그
 * 원점 기준으로 쓴다(모든 패스가 "M0 0"으로 시작). transform을 무시하면 모든
 * 도형이 좌상단으로 뭉쳐버리므로 여기서 좌표에 흡수시킨다.
 */
function extractPaths(svg: string, color: string): IRPath[] {
  const out: IRPath[] = [];
  const re = /<path\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const attrs = m[1];
    const d = /\bd="([^"]+)"/.exec(attrs)?.[1];
    if (!d) continue;
    const fill = /\bfill="([^"]+)"/.exec(attrs)?.[1]?.toLowerCase();
    // Binary 모드에서 흰색 패스는 배경
    if (fill === "#ffffff" || fill === "#fff" || fill === "white") continue;

    const t = /\btransform="translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)"/.exec(attrs);
    const dAbs = t ? translatePath(d, Number(t[1]), Number(t[2])) : d;

    out.push({ d: dAbs, fill: color, stroke: null, strokeWidth: 0, vectorizer: "vtracer" });
  }
  return out;
}

/** path data의 모든 좌표를 (tx,ty)만큼 이동 */
function translatePath(d: string, tx: number, ty: number): string {
  const subs = parsePath(d);
  for (const sp of subs) {
    sp.start[0] += tx;
    sp.start[1] += ty;
    for (const s of sp.segs) {
      s.end[0] += tx;
      s.end[1] += ty;
      if (s.c1) { s.c1[0] += tx; s.c1[1] += ty; }
      if (s.c2) { s.c2[0] += tx; s.c2[1] += ty; }
    }
  }
  return serializePath(subs);
}
