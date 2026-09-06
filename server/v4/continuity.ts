/**
 * 연속성 불변식 — **진한 선은 절대 끊긴 채 나가지 않는다.**
 *
 * 분류기 연쇄가 진한 선 토막을 먹는 사고가 실측으로 있었다: 헤일로 필터가 희미한
 * 연결부를 지우면 남은 진한 토막(그레이 40대!)이 고아가 되고, 고아는 잡티·해프톤
 * 분류기의 밥이 된다(bag_1: 끊김 67px · 필터를 끄면 13px — 전부 이 경로).
 *
 * 분류기를 조율해서 막으려는 시도는 두 번 실패했다 — 규칙 하나를 고치면 다른 샘플이
 * 되살찐다(브리지 규칙: bag_2 잉크 1.10 → 1.29). 그래서 방향을 뒤집는다: 어떤 분류기가
 * 먹었든, **장면 조립이 끝난 뒤** 필터를 전혀 거치지 않은 진한 잉크(inkStrict)의 골격과
 * 최종 렌더를 대조해서, 덮이지 않은 구간을 스트로크로 재주입한다.
 *
 * 의도적 제거(보석 반사·해프톤 질감)는 기준에서 빼고 본다 — 되살리면 안 되는 것들이다.
 */
import { renderStandalone } from "./export.js";
import { svgInkMask, distanceTransform } from "../v3/metrics.js";
import { skeletonize } from "../vector/centerline.js";
import { labelComponents } from "../v3/label.js";
import { fitAdaptive, segsToPathD } from "../vector/fitCurve.js";
import type { Pt } from "../vector/pathdata.js";
import type { PatternPrimitive, ScenePrimitive, StrokePrimitive } from "./types.js";

export interface RescueResult {
  added: StrokePrimitive[];
  /** 재주입한 구간 수 · 골격 픽셀 수 */
  runs: number;
  px: number;
}

export async function rescueContinuity(opts: {
  primitives: ScenePrimitive[];
  W: number;
  H: number;
  /** 필터 이전의 진한 잉크 */
  inkStrict: Uint8Array;
  /** 의도적으로 지운 영역들 — 기준에서 완전히 뺀다 (보석 반사) */
  exclude: (Uint8Array | undefined)[];
  /**
   * 해프톤으로 분류된 영역. 통째로 빼지 않는다 — 분류기가 **진짜 선을 질감으로 오인**해
   * 먹는 사고가 실측으로 있었다(bag_1: 그레이 12~46짜리 선 토막들이 질감 구역 안에서
   * 죽었다). 대신 이 구역의 구간은 더 길어야만(2×minRun) 살린다 — 해프톤 점 자체의
   * 골격은 짧아서(≤8px) 그 문턱을 못 넘는다.
   */
  texture?: Uint8Array;
  parts?: { id: string; mask: Uint8Array }[];
  nextId: (prefix: string) => string;
  /** 이보다 짧은 구간은 무시(px) — 잡티 재주입 방지 */
  minRunPx?: number;
}): Promise<RescueResult> {
  const { W, H, inkStrict } = opts;
  const N = W * H;
  const minRun = opts.minRunPx ?? 12;

  // 덮임 판정은 **실제 색(paint) 렌더의 잉크**로 한다. ink 모드는 모든 것을 검정으로
  // 칠해서, 밝은 회색 톤 면(TEXTURE_TONE)이 그 밑에서 죽은 진한 선을 "덮은 척" 한다 —
  // 실측 bag_1: 그레이 40짜리 72px 선이 톤 면 아래서 사라졌는데 ink 모드에선 안 잡혔다.
  // 점선(DASH_OR_STITCH)은 **이어진 선**으로 덮임을 판정한다. 대시가 어느 위상에
  // 찍히는지는 의도적 근사라, 도면의 대시와 몇 px 어긋나는 것이 정상이다 — 대시 틈을
  // 끊김으로 보면 스티치마다 스트로크가 복제된다(실측 bag_2: 1,019구간 재주입,
  // shoe_1: 283구간 — 편집성 게이트 붕괴). 굵기도 +4px — 옆으로 어긋난 대시까지 덮는다.
  const coverPrims = opts.primitives.map((p) =>
    p.cls === "DASH_OR_STITCH"
      ? { ...p, dashArray: undefined, width: (p as StrokePrimitive).width + 4 }
      : p,
  ) as ScenePrimitive[];
  const vec = await svgInkMask(renderStandalone(coverPrims, W, H, "paint"), W, H);
  const dVec = distanceTransform(vec);

  // **패턴 발자국은 구제하지 않는다.** 반복 패턴은 대표 모티프를 자리마다 찍는
  // 의도적 근사라 원본과 몇 px 어긋난다 — 그 어긋남을 "끊김"으로 보면 대시마다
  // 스트로크가 복제된다(실측 bag_2: 1,019구간 15,014px 재주입, 편집성 게이트 붕괴).
  const patternZone = new Uint8Array(N);
  const stamp = (x0f: number, y0f: number, x1f: number, y1f: number, pad: number) => {
    const x0 = Math.max(0, Math.floor(x0f) - pad), y0 = Math.max(0, Math.floor(y0f) - pad);
    const x1 = Math.min(W - 1, Math.ceil(x1f) + pad), y1 = Math.min(H - 1, Math.ceil(y1f) + pad);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) patternZone[y * W + x] = 1;
  };
  for (const p of opts.primitives) {
    if (p.cls === "REPEATING_PATTERN") {
      const t = p as PatternPrimitive;
      for (const inst of t.instances) {
        stamp(inst.x, inst.y, inst.x + t.motifSize[0] * inst.scale, inst.y + t.motifSize[1] * inst.scale, 3);
      }
    } else if (p.cls === "GEOMETRIC_PRIMITIVE" || p.cls === "DASH_OR_STITCH") {
      // 프리미티브는 적합 잔차만큼, 점선은 대시 위상만큼 원본과 어긋나는 것이 정상이다.
      // 그 어긋남을 끊김으로 보면 구슬 하나마다 호가 복제된다(실측 bag_2: 원 프리미티브
      // 522개 주변에서 1,019구간 재주입 — 편집성 게이트 붕괴).
      stamp(p.bbox[0], p.bbox[1], p.bbox[2], p.bbox[3], 3);
    }
  }

  const sk = skeletonize(inkStrict, W, H);
  const un = new Uint8Array(N);
  outer: for (let i = 0; i < N; i++) {
    if (!sk[i] || dVec[i] <= 3 || patternZone[i]) continue;
    for (const ex of opts.exclude) if (ex?.[i]) continue outer;
    un[i] = 1;
  }

  const added: StrokePrimitive[] = [];
  let runs = 0, px = 0;

  const DBG = process.env.V4_RESCUE_DEBUG === "1";
  if (DBG) {
    let unN = 0;
    for (let i = 0; i < N; i++) if (un[i]) unN++;
    console.log(`    [rescue] 미덮 골격 ${unN}px · 성분 ${labelComponents(un, W, H, 8, 1).components.length}개(문턱 전)`);
  }
  for (const c of labelComponents(un, W, H, 8, minRun).components) {
    // 골격 조각을 폴리라인으로 편다 — 끝점(이웃 1개)에서 출발해 탐욕적으로 잇는다
    const inComp = new Set<number>(c.pixels as unknown as number[]);
    const nbrs = (i: number): number[] => {
      const x = i % W, y = (i / W) | 0, out: number[] = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (inComp.has(j)) out.push(j);
      }
      return out;
    };
    let start = c.pixels[0];
    for (let k = 0; k < c.pixels.length; k++) {
      if (nbrs(c.pixels[k]).length <= 1) { start = c.pixels[k]; break; }
    }
    const visited = new Set<number>([start]);
    const pts: Pt[] = [[start % W, (start / W) | 0]];
    let cur = start;
    while (true) {
      const next = nbrs(cur).find((j) => !visited.has(j));
      if (next === undefined) break;
      visited.add(next);
      pts.push([next % W, (next / W) | 0]);
      cur = next;
    }
    // 분기가 있으면 가장 긴 팔만 편 셈이다 — 짧아졌으면 그대로 둔다(다음 조각이 잡는다)
    if (pts.length < minRun) continue;
    // **질감 구역에서는 틈만 잇는다.** 질감 밭의 고아 대시(실측 bag_2: 1,019개)는
    // 끊긴 선이 아니라 질감 밀도다 — 개별 복원하면 편집성 게이트가 무너진다. 끊긴
    // 선의 토막은 **양끝이 이미 그려진 선에 닿아** 있다(실측 shoe_2: 스티치 선의 빠진
    // 대시). 그래서 질감 구역에서는 끝점이 덮인 잉크 4px 이내인 구간만 살린다.
    if (opts.texture) {
      let tex = 0;
      for (const [x, y] of pts) if (opts.texture[y * W + x]) tex++;
      if (tex > pts.length * 0.5) {
        const [sx, sy] = pts[0], [ex, ey] = pts[pts.length - 1];
        const dEnd = Math.min(dVec[sy * W + sx], dVec[ey * W + ex]);
        if (dEnd > 4) { if (DBG) console.log(`    [rescue] 질감 고아 탈락 ${pts.length}px @${pts[0]}`); continue; }
      }
    }

    // 굵기 — 골격에서 배경까지 4방향 최단 ×2
    const widths: number[] = [];
    for (let k = 0; k < pts.length; k += 2) {
      const [x, y] = pts[k];
      let best = 6;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        for (let r = 1; r <= 6; r++) {
          const nx = x + dx * r, ny = y + dy * r;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || !inkStrict[ny * W + nx]) { best = Math.min(best, r); break; }
        }
      }
      widths.push(best * 2 - 1);
    }
    widths.sort((a, b) => a - b);
    const width = Math.max(1.5, widths[widths.length >> 1]);

    // **선만 구제한다.** 구슬·점 같은 방울의 골격도 10px 를 넘을 수 있어 길이만으로는
    // 못 거른다(실측 bag_2: 질감 구역 구슬 1,019개가 골격 14px 로 통과). 방울은
    // 세장비(길이/굵기)가 1 근처고 선 토막은 3 이상이다 — 그걸로 가른다.
    const elong = pts.length / Math.max(1, width);
    if (elong < 2) continue;

    // 파트 배정 — 구간 픽셀의 다수결
    let partId: string | undefined;
    if (opts.parts?.length) {
      let bestN = 0;
      for (const p of opts.parts) {
        let n = 0;
        for (const [x, y] of pts) if (p.mask[y * W + x]) n++;
        if (n > bestN) { bestN = n; partId = p.id; }
      }
      if (bestN < pts.length * 0.3) partId = undefined;
    }

    const { segs } = fitAdaptive(pts, { baseError: 1.2, cornerTurnDeg: 62 });
    if (!segs.length) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    added.push({
      id: opts.nextId("cr"), cls: "STRUCTURAL_STROKE",
      d: segsToPathD(segs, false), width, color: "#111111",
      partId, area: Math.round(pts.length * width),
      bbox: [x0, y0, x1, y1],
      route: {
        chosen: "STRUCTURAL_STROKE", confidence: 1,
        features: { rescued: true, runPx: pts.length },
        why: `연속성 재주입 — 진한 골격 ${pts.length}px 가 최종 렌더에 덮이지 않았다`,
      },
    });
    runs++;
    px += pts.length;
  }

  return { added, runs, px };
}
