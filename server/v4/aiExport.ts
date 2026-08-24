/**
 * V4 → Illustrator (.ai) 내보내기.
 *
 * V4 는 지금까지 SVG 만 냈다. SVG 는 Illustrator 가 열긴 하지만 **레이어가 오지 않는다** —
 * 최상위 `<g>` 는 그냥 그룹이 되고, 레이어 패널에는 <Group> 하나만 뜬다. 테크팩을 쓰는
 * 사람은 레이어 패널에서 파트를 켜고 끄므로 그것이 사실상 못 쓰는 파일이다.
 *
 * .ai(PDF 호환)는 본질적으로 PDF 이고, Illustrator 는 PDF 의 OCG(Optional Content Group)를
 * 레이어로 복원한다. 중첩 OCG 는 하위 레이어가 된다. 여기서는
 *
 *     기능 레이어 (FILLS / OUTLINES / STITCH …)
 *       └ 파트 하위 레이어 (main_upper / laces …)
 *
 * 로 중첩 OCG 를 가진 PDF 1.6 을 바이트 단위로 조립한다.
 *
 * **레이어 순서는 기능이 먼저다.** 파트를 최상위로 두면 아래쪽 파트의 선 위로 위쪽 파트의
 * 흰 면이 덮인다 — FACE_FILL 은 불투명하다. 보이는 그림이 달라지면 레이어 구조가 아무리
 * 예뻐도 틀린 파일이다.
 */
import type {
  VectorScene, ScenePrimitive, StrokePrimitive, ShapePrimitive,
  GeometricPrimitive, PatternPrimitive,
} from "./types.js";
import { parsePath, type SubPath } from "../vector/pathdata.js";

// ── IR ──────────────────────────────────────────────────────
export interface AiPath {
  d: string;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  /** SVG stroke-dasharray 를 그대로 (PDF 의 d 연산자로 옮긴다) */
  dash?: string;
}
export interface AiGroup { name: string; paths: AiPath[] }
export interface AiLayer { name: string; groups: AiGroup[] }
export interface AiDoc { width: number; height: number; layers: AiLayer[] }

/** production.svg 와 같은 순서 — 면이 먼저, 그 위에 선 */
const BUCKET_ORDER = [
  "FILLS", "TEXTURE", "PATTERNS", "OUTLINES",
  "PRIMITIVES", "STITCH", "STRUCTURE", "SHARED_BOUNDARIES",
] as const;

/** 위로 올리면 아래 잉크를 덮는 표현 */
const OPAQUE_AREA = new Set(["FACE_FILL", "TEXTURE_TONE"]);

function bucketOf(p: ScenePrimitive): string {
  switch (p.cls) {
    case "FACE_FILL": return "FILLS";
    case "TEXTURE_TONE": return "TEXTURE";
    case "REPEATING_PATTERN": return "PATTERNS";
    case "OUTLINE_SHAPE": return "OUTLINES";
    case "GEOMETRIC_PRIMITIVE": return "PRIMITIVES";
    case "DASH_OR_STITCH": return "STITCH";
    default: return "STRUCTURE";
  }
}

// ── 패턴 펼치기 ─────────────────────────────────────────────
//
// PDF 에도 Form XObject 가 있지만, Illustrator 는 그것을 심볼이 아니라 그냥 그룹으로 푼다.
// 어차피 펼쳐질 것이면 여기서 펼치는 편이 좌표가 명확하다.
type Mat = [number, number, number, number, number, number]; // a b c d e f

const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Mat, x: number, y: number): [number, number] =>
  [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function instanceMatrix(i: { x: number; y: number; rotate?: number; scale?: number }): Mat {
  let m: Mat = [1, 0, 0, 1, i.x, i.y];
  if (i.rotate) {
    const r = (i.rotate * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    m = mul(m, [c, s, -s, c, 0, 0]);
  }
  if (i.scale !== undefined && i.scale !== 1) m = mul(m, [i.scale, 0, 0, i.scale, 0, 0]);
  return m;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** SubPath 들을 다시 d 문자열로 (선택적 변환 적용) */
function subsToD(subs: SubPath[], m?: Mat): string {
  const t = (x: number, y: number) => (m ? apply(m, x, y) : [x, y] as [number, number]);
  const out: string[] = [];
  for (const sp of subs) {
    const [sx, sy] = t(sp.start[0], sp.start[1]);
    out.push(`M${r3(sx)} ${r3(sy)}`);
    for (const s of sp.segs) {
      const [ex, ey] = t(s.end[0], s.end[1]);
      if (s.type === "L") out.push(`L${r3(ex)} ${r3(ey)}`);
      else {
        const [c1x, c1y] = t(s.c1![0], s.c1![1]);
        const [c2x, c2y] = t(s.c2![0], s.c2![1]);
        out.push(`C${r3(c1x)} ${r3(c1y)} ${r3(c2x)} ${r3(c2y)} ${r3(ex)} ${r3(ey)}`);
      }
    }
    if (sp.closed) out.push("Z");
  }
  return out.join("");
}

/** 한 프리미티브 → .ai 패스 목록 (패턴은 인스턴스마다 하나씩) */
function primToPaths(p: ScenePrimitive): { path: AiPath; partId?: string }[] {
  switch (p.cls) {
    case "STRUCTURAL_STROKE":
    case "DASH_OR_STITCH": {
      const st = p as StrokePrimitive;
      return [{ path: { d: st.d, fill: null, stroke: st.color, strokeWidth: st.width, dash: st.dashArray } }];
    }
    case "GEOMETRIC_PRIMITIVE": {
      const g = p as GeometricPrimitive;
      // 면에서 온 프리미티브를 stroke 로 내면 굵기가 없어 사라진다 — V4.1 에서 고친 그 버그다.
      if (g.paint === "fill") return [{ path: { d: g.d, fill: g.fill, stroke: null, strokeWidth: 0 } }];
      return [{ path: { d: g.d, fill: null, stroke: g.stroke, strokeWidth: g.width } }];
    }
    case "REPEATING_PATTERN": {
      const t = p as PatternPrimitive;
      const motif = parsePath(t.motif);
      return t.instances.map((i) => ({
        partId: i.partId ?? t.partId,
        path: { d: subsToD(motif, instanceMatrix(i)), fill: t.fill, stroke: null, strokeWidth: 0 },
      }));
    }
    default: {
      const sh = p as ShapePrimitive;
      return [{ path: { d: sh.d, fill: sh.fill, stroke: null, strokeWidth: 0 } }];
    }
  }
}

/** 레이어 이름은 PDF 문자열로 나가므로 ASCII 로 접는다 (Illustrator 레이어 패널 표기) */
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "").trim();

export function sceneToAiDoc(scene: VectorScene): AiDoc {
  const byId = new Map(scene.parts.map((p) => [p.id, p]));
  const sharedIds = new Set(scene.sharedBoundaries.map((s) => s.primitiveId));

  const buckets = new Map<string, { partId: string; path: AiPath }[]>();
  for (const p of scene.primitives) {
    // 불투명한 면을 맨 위 레이어로 올리면 그 아래 선이 지워진다 — export.ts 와 같은 규칙.
    const hoist = sharedIds.has(p.id) && !OPAQUE_AREA.has(p.cls);
    const b = hoist ? "SHARED_BOUNDARIES" : bucketOf(p);
    const list = buckets.get(b) ?? buckets.set(b, []).get(b)!;
    for (const { path, partId } of primToPaths(p)) {
      list.push({ partId: partId ?? p.partId ?? "_unassigned", path });
    }
  }

  const layers: AiLayer[] = [];
  for (const name of BUCKET_ORDER) {
    const list = buckets.get(name);
    if (!list?.length) continue;
    const byPart = new Map<string, AiPath[]>();
    for (const { partId, path } of list) {
      (byPart.get(partId) ?? byPart.set(partId, []).get(partId)!).push(path);
    }
    const groups = [...byPart.entries()]
      .sort((a, b) => (byId.get(a[0])?.z ?? 99) - (byId.get(b[0])?.z ?? 99))
      .map(([pid, paths]) => ({
        name: ascii(byId.get(pid)?.label ?? pid) || pid,
        paths,
      }));
    layers.push({ name, groups });
  }

  return { width: scene.canvas.width, height: scene.canvas.height, layers };
}

// ── PDF 조립 ────────────────────────────────────────────────
const f2 = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function pdfString(s: string): string {
  return s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, "_");
}

function pathOps(p: AiPath, flip: (y: number) => number): string {
  const subs = parsePath(p.d);
  if (!subs.length) return "";
  let ops = "";
  if (p.fill) {
    const [r, g, b] = hexRgb(p.fill);
    ops += `${f2(r)} ${f2(g)} ${f2(b)} rg\n`;
  }
  if (p.stroke) {
    const [r, g, b] = hexRgb(p.stroke);
    ops += `${f2(r)} ${f2(g)} ${f2(b)} RG\n${f2(p.strokeWidth || 1)} w\n`;
    // SVG 쪽이 stroke-linecap/linejoin="round" 이므로 맞춘다. 맞추지 않으면
    // 굵은 선의 끝과 꺾임에서 눈에 띄게 다른 그림이 된다.
    ops += "1 J\n1 j\n";
    const dash = (p.dash ?? "").trim();
    ops += dash ? `[${dash.split(/[\s,]+/).map(Number).map(f2).join(" ")}] 0 d\n` : "[] 0 d\n";
  }
  for (const sp of subs) {
    ops += `${f2(sp.start[0])} ${f2(flip(sp.start[1]))} m\n`;
    for (const s of sp.segs) {
      if (s.type === "L") ops += `${f2(s.end[0])} ${f2(flip(s.end[1]))} l\n`;
      else {
        ops += `${f2(s.c1![0])} ${f2(flip(s.c1![1]))} ${f2(s.c2![0])} ${f2(flip(s.c2![1]))} ` +
          `${f2(s.end[0])} ${f2(flip(s.end[1]))} c\n`;
      }
    }
    if (sp.closed) ops += "h\n";
  }
  ops += p.fill && p.stroke ? "B*\n" : p.fill ? "f*\n" : "S\n";
  return ops;
}

/**
 * 중첩 OCG 를 가진 .ai(PDF 1.6). Illustrator 에서 열면
 * 기능 레이어 아래에 파트 하위 레이어가 선다.
 */
export function buildAiV4(doc: AiDoc): Buffer {
  const H = doc.height;
  const flip = (y: number) => H - y;

  // OCG 번호 매기기 — 레이어 하나 + 그 안의 그룹마다 하나
  type Oc = { id: number; name: string; children: Oc[] };
  const ocs: Oc[] = [];
  let ocSeq = 0;
  const tree: Oc[] = doc.layers.map((l) => {
    const parent: Oc = { id: ocSeq++, name: l.name, children: [] };
    ocs.push(parent);
    for (const g of l.groups) {
      const child: Oc = { id: ocSeq++, name: g.name, children: [] };
      ocs.push(child);
      parent.children.push(child);
    }
    return parent;
  });

  let content = "";
  doc.layers.forEach((l, li) => {
    const parent = tree[li];
    content += `/OC /oc${parent.id} BDC\n`;
    l.groups.forEach((g, gi) => {
      content += `/OC /oc${parent.children[gi].id} BDC\nq\n`;
      for (const p of g.paths) content += pathOps(p, flip);
      content += "Q\nEMC\n";
    });
    content += "EMC\n";
  });

  // 1 Catalog · 2 Pages · 3 Page · 4 Contents · 5.. OCG
  const OC0 = 5;
  const ref = (o: Oc) => `${OC0 + o.id} 0 R`;
  const allRefs = ocs.map(ref).join(" ");
  // 패널은 마지막에 그려진 레이어가 맨 위 → 역순
  const order = [...tree].reverse()
    .map((p) => `${ref(p)} [${[...p.children].reverse().map(ref).join(" ")}]`)
    .join(" ");

  const objects: string[] = [];
  objects[1] =
    `<< /Type /Catalog /Pages 2 0 R ` +
    `/OCProperties << /OCGs [${allRefs}] ` +
    `/D << /Order [${order}] /ON [${allRefs}] /BaseState /ON >> >> >>`;
  objects[2] = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  const props = ocs.map((o) => `/oc${o.id} ${ref(o)}`).join(" ");
  objects[3] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f2(doc.width)} ${f2(doc.height)}] ` +
    `/Contents 4 0 R /Resources << /Properties << ${props} >> >> >>`;
  const bytes = Buffer.byteLength(content, "latin1");
  objects[4] = `<< /Length ${bytes} >>\nstream\n${content}endstream`;
  for (const o of ocs) objects[OC0 + o.id] = `<< /Type /OCG /Name (${pdfString(o.name)}) >>`;

  let pdf = "%PDF-1.6\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, "latin1");
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, "latin1");
  const count = objects.length;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

export function exportAi(scene: VectorScene): Buffer {
  return buildAiV4(sceneToAiDoc(scene));
}
