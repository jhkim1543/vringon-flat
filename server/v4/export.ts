/**
 * VectorScene → SVG. **목적이 다르면 파일도 달라야 한다.**
 *
 * V3는 SVG 하나에 "원본과 똑같이 보일 것"과 "Illustrator에서 만지기 좋을 것"을 동시에
 * 요구했다. 둘은 반대 방향이라 어느 쪽도 만족스럽지 않았다 — 충실도를 올리면 패스가 늘고,
 * 패스를 줄이면 디테일이 깎인다.
 *
 * 같은 장면에서 세 가지를 굽는다.
 *   fidelity     도면과 최대한 같아 보이는 것. 앵커 예산 없음.
 *   editable     적은 패스·앵커. 단순화 허용오차를 키우고 자잘한 조각을 버린다.
 *   production   테크팩용. 기능 레이어(구조선/스티치/패턴/질감/공유경계)와 파트로 나눈다.
 */
import { optimizePathData } from "../vector/optimize.js";
import type {
  GeometricPrimitive, PatternPrimitive, ScenePrimitive, ShapePrimitive, StrokePrimitive, VectorScene,
} from "./types.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function head(scene: VectorScene, extra = ""): string {
  const { width: W, height: H } = scene.canvas;
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"\n` +
    `     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"\n` +
    `     viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${extra}\n`;
}

/** 패턴 모티프를 <defs> 에 심볼로 */
function defsFor(prims: ScenePrimitive[]): string {
  const pats = prims.filter((p) => p.cls === "REPEATING_PATTERN") as PatternPrimitive[];
  if (!pats.length) return "";
  const body = pats.map((p) =>
    `    <symbol id="motif-${p.id}" viewBox="0 0 ${p.motifSize[0]} ${p.motifSize[1]}" ` +
    `overflow="visible"><path d="${p.motif}" fill="${p.fill}" fill-rule="evenodd"/></symbol>`,
  ).join("\n");
  return `\n  <defs>\n${body}\n  </defs>`;
}

function tagOf(p: ScenePrimitive, sharedAttr = true): string {
  const shared = sharedAttr && p.shared?.length ? ` data-shared="${p.shared.join(" ")}"` : "";
  const cls = ` data-cls="${p.cls}"`;
  switch (p.cls) {
    case "STRUCTURAL_STROKE":
    case "DASH_OR_STITCH": {
      const s = p as StrokePrimitive;
      const dash = s.dashArray ? ` stroke-dasharray="${s.dashArray}"` : "";
      return `    <path d="${s.d}" fill="none" stroke="${s.color}" stroke-width="${s.width}" ` +
        `stroke-linecap="round" stroke-linejoin="round"${dash}${cls}${shared}/>`;
    }
    case "GEOMETRIC_PRIMITIVE": {
      const g = p as GeometricPrimitive;
      return `    <path d="${g.d}" fill="none" stroke="${g.stroke}" stroke-width="${g.width}" ` +
        `stroke-linecap="round" stroke-linejoin="round"${cls} data-kind="${g.kind}" ` +
        `data-params="${esc(JSON.stringify(g.params))}"${shared}/>`;
    }
    case "REPEATING_PATTERN": {
      const t = p as PatternPrimitive;
      const uses = t.instances.map((i) =>
        `      <use xlink:href="#motif-${t.id}" x="0" y="0" ` +
        `width="${t.motifSize[0]}" height="${t.motifSize[1]}" ` +
        `transform="translate(${i.x} ${i.y})${i.scale !== 1 ? ` scale(${i.scale})` : ""}"/>`,
      ).join("\n");
      return `    <g${cls} data-instances="${t.instances.length}"${shared}>\n${uses}\n    </g>`;
    }
    default: {
      const s = p as ShapePrimitive;
      return `    <path d="${s.d}" fill="${s.fill}" fill-rule="evenodd"${cls}${shared}/>`;
    }
  }
}

/** 그리는 순서 — 면이 먼저, 그 위에 선 */
const Z: Record<string, number> = {
  FACE_FILL: 0, TEXTURE_TONE: 1, REPEATING_PATTERN: 2,
  OUTLINE_SHAPE: 3, GEOMETRIC_PRIMITIVE: 4, DASH_OR_STITCH: 5, STRUCTURAL_STROKE: 6,
};
const drawOrder = (a: ScenePrimitive, b: ScenePrimitive) => (Z[a.cls] ?? 9) - (Z[b.cls] ?? 9);

// ── fidelity ────────────────────────────────────────────────
export function exportFidelity(scene: VectorScene): string {
  const prims = [...scene.primitives].sort(drawOrder);
  return head(scene, defsFor(prims)) +
    `  <metadata id="vector-scene">${esc(JSON.stringify({
      pipeline: scene.provenance.pipeline, mode: "fidelity",
      canvas: scene.canvas, counts: countByClass(scene),
    }))}</metadata>\n` +
    prims.map((p) => tagOf(p)).join("\n") +
    `\n</svg>\n`;
}

// ── editable ────────────────────────────────────────────────
export interface EditableOptions {
  /** 단순화 허용오차 배수 — fidelity 대비 */
  simplifyScale: number;
  /** 이 면적(캔버스 비율) 미만의 outline 조각은 버린다 */
  dropAreaShare: number;
  simplifyPx: number;
}

export const DEFAULT_EDITABLE: EditableOptions = {
  simplifyScale: 3,
  dropAreaShare: 0.00002,
  simplifyPx: 0.8,
};

export function exportEditable(scene: VectorScene, o: Partial<EditableOptions> = {}): string {
  const opt = { ...DEFAULT_EDITABLE, ...o };
  const { width: W, height: H } = scene.canvas;
  const minArea = W * H * opt.dropAreaShare;
  const eps = opt.simplifyPx * opt.simplifyScale;

  const kept: ScenePrimitive[] = [];
  for (const p of scene.primitives) {
    // 프리미티브·패턴·점선은 이미 최소 표현이다 — 건드리지 않는다
    if (p.cls === "GEOMETRIC_PRIMITIVE" || p.cls === "REPEATING_PATTERN" || p.cls === "DASH_OR_STITCH") {
      kept.push(p);
      continue;
    }
    const d = (p as { d?: string }).d;
    if (!d) { kept.push(p); continue; }
    const opt2 = optimizePathData(d, { minArea, epsilon: eps });
    if (!opt2.d || !new RegExp("[LCQS]").test(opt2.d)) continue;
    kept.push({ ...p, d: opt2.d } as ScenePrimitive);
  }

  const prims = kept.sort(drawOrder);
  return head(scene, defsFor(prims)) +
    `  <metadata id="vector-scene">${esc(JSON.stringify({
      pipeline: scene.provenance.pipeline, mode: "editable",
      canvas: scene.canvas, simplifyEpsilon: eps, counts: countByClass({ ...scene, primitives: prims }),
    }))}</metadata>\n` +
    prims.map((p) => tagOf(p)).join("\n") +
    `\n</svg>\n`;
}

// ── production ──────────────────────────────────────────────
/**
 * 기능 레이어를 먼저 나누고 그 안에서 파트로 나눈다.
 *
 * 파트만으로 나누면 **한 파트를 끄는 순간 이웃의 외곽선까지 사라진다** — 경계선은 두 파트가
 * 함께 쓰기 때문이다. 공유 경계를 별도 레이어로 빼면 그 일이 없다.
 */
export function exportProduction(scene: VectorScene): string {
  const byId = new Map(scene.parts.map((p) => [p.id, p]));
  const sharedIds = new Set(scene.sharedBoundaries.map((s) => s.primitiveId));

  const buckets: Record<string, ScenePrimitive[]> = {
    FILLS: [], TEXTURE: [], PATTERNS: [], SHARED_BOUNDARIES: [],
    OUTLINES: [], PRIMITIVES: [], STITCH: [], STRUCTURE: [],
  };
  for (const p of scene.primitives) {
    if (sharedIds.has(p.id)) { buckets.SHARED_BOUNDARIES.push(p); continue; }
    const b = p.cls === "FACE_FILL" ? "FILLS"
      : p.cls === "TEXTURE_TONE" ? "TEXTURE"
        : p.cls === "REPEATING_PATTERN" ? "PATTERNS"
          : p.cls === "OUTLINE_SHAPE" ? "OUTLINES"
            : p.cls === "GEOMETRIC_PRIMITIVE" ? "PRIMITIVES"
              : p.cls === "DASH_OR_STITCH" ? "STITCH" : "STRUCTURE";
    buckets[b].push(p);
  }

  const order = ["FILLS", "TEXTURE", "PATTERNS", "OUTLINES", "PRIMITIVES", "STITCH", "STRUCTURE", "SHARED_BOUNDARIES"];
  const body: string[] = [];
  for (const name of order) {
    const list = buckets[name];
    if (!list.length) continue;
    // 기능 레이어 안에서 파트별로 한 번 더 묶는다
    const byPart = new Map<string, ScenePrimitive[]>();
    for (const p of list) {
      const k = p.partId ?? "_unassigned";
      (byPart.get(k) ?? byPart.set(k, []).get(k)!).push(p);
    }
    const inner = [...byPart.entries()]
      .sort((a, b) => (byId.get(a[0])?.z ?? 99) - (byId.get(b[0])?.z ?? 99))
      .map(([pid, ps]) => {
        const node = byId.get(pid);
        return `    <g id="${name.toLowerCase()}-${pid}" inkscape:label="${esc(node?.label ?? pid)}" ` +
          `data-part="${pid}" data-z="${node?.z ?? -1}">\n` +
          ps.map((p) => "  " + tagOf(p)).join("\n") + `\n    </g>`;
      }).join("\n");
    body.push(`  <g id="${name}" inkscape:groupmode="layer" inkscape:label="${name}">\n${inner}\n  </g>`);
  }

  const prims = scene.primitives;
  return head(scene, defsFor(prims)) +
    `  <metadata id="vector-scene">${esc(JSON.stringify({
      pipeline: scene.provenance.pipeline, mode: "production",
      canvas: scene.canvas, parts: scene.parts.map((p) => ({ id: p.id, z: p.z, label: p.label })),
      sharedBoundaries: scene.sharedBoundaries, counts: countByClass(scene),
      correspondence: scene.correspondence,
    }))}</metadata>\n` +
    body.join("\n") +
    `\n</svg>\n`;
}

export function countByClass(scene: VectorScene): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of scene.primitives) out[p.cls] = (out[p.cls] ?? 0) + 1;
  return out;
}

/** SVG의 패스·앵커 수 — 편집성 지표용 */
export function complexity(svg: string): { paths: number; anchors: number; uses: number; kb: number } {
  const paths = (svg.match(new RegExp("<path\\b", "g")) ?? []).length;
  const uses = (svg.match(new RegExp("<use\\b", "g")) ?? []).length;
  let anchors = 0;
  for (const m of svg.matchAll(new RegExp('d="([^"]*)"', "g"))) {
    anchors += (m[1].match(new RegExp("[MLCQSTA]", "g")) ?? []).length;
  }
  return { paths, anchors, uses, kb: +(Buffer.byteLength(svg) / 1024).toFixed(1) };
}
