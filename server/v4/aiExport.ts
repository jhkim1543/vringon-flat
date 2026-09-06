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
  /**
   * **반복 모티프의 인스턴스**. 있으면 `d` 를 쓰지 않고 Form XObject 를 참조한다.
   *
   * 예전에는 인스턴스마다 모티프를 펼쳐 그렸다 — SVG 는 `<use>` 로 간결한데 `.ai` 만
   * 1,360배로 부풀었다(실측 s_bag_04: 모티프 앵커 135 → 펼치면 4,962). 파일이 무겁고,
   * 모티프 하나를 고쳐 전체를 바꾸는 것도 불가능했다.
   */
  motifRef?: { key: string; matrix: [number, number, number, number, number, number] };
}
export interface AiGroup { name: string; paths: AiPath[] }
export interface AiLayer { name: string; groups: AiGroup[] }
export interface AiDoc {
  width: number; height: number; layers: AiLayer[];
  /** 반복 모티프 — 키마다 한 번만 정의하고 인스턴스가 참조한다 */
  motifs?: Map<string, { d: string; fill: string | null; stroke?: string | null; strokeWidth?: number }>;
}

/** production.svg 와 같은 순서 — 면이 먼저, 그 위에 선 */
const BUCKET_ORDER = [
  "FILLS", "TEXTURE", "PATTERNS", "OUTLINES",
  "PRIMITIVES", "STITCH", "STRUCTURE", "REVIEW_TEXT", "SHARED_BOUNDARIES",
] as const;

/** 위로 올리면 아래 잉크를 덮는 표현 */
const OPAQUE_AREA = new Set(["FACE_FILL", "TEXTURE_TONE"]);

function bucketOf(p: ScenePrimitive): string {
  // **각인·로고는 따로 뺀다.** 도면에서 온 글자는 윤곽을 그대로 뜬 것이라 자모가
  // 뭉개져 있고, 실무자는 그걸 고쳐 쓰지 않는다 — 폰트로 새로 친다(주얼리 디자이너·
  // 어패럴 그래픽 두 명이 같은 말을 했다). 그러려면 **어디가 글자인지 한눈에 보여야**
  // 한다. 레이어를 따로 두면 통째로 선택해 지우고 텍스트를 얹을 수 있다.
  if ((p.route?.features as Record<string, unknown> | undefined)?.glyph) return "REVIEW_TEXT";
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
      // **모티프는 한 번만 정의하고 인스턴스는 참조한다.** 행렬은 SVG 의 transform 과
      // 같은 뜻이지만 PDF 는 y 가 위로 가므로, 실제 뒤집기는 조립 단계에서 한다.
      // **되돌릴 수 있게 둔다.** poppler 로는 같은 그림이 나오는 것을 확인했지만
      // Illustrator 가 Form XObject 를 어떻게 푸는지는 여기서 검증할 수 없다.
      // 문제가 생기면 `V4_AI_EXPAND=1` 로 예전처럼 인스턴스마다 펼친다.
      if (process.env.V4_AI_EXPAND === "1") {
        const motif = parsePath(t.motif);
        return t.instances.map((i) => ({
          partId: i.partId ?? t.partId,
          path: { d: subsToD(motif, instanceMatrix(i)), fill: t.fill, stroke: null, strokeWidth: 0 },
        }));
      }
      return t.instances.map((i) => {
        const m = instanceMatrix(i);
        return {
          partId: i.partId ?? t.partId,
          path: {
            d: "", fill: t.fill, stroke: null, strokeWidth: 0,
            motifRef: { key: `${t.id}`, matrix: m as [number, number, number, number, number, number] },
          },
        };
      });
    }
    default: {
      const sh = p as ShapePrimitive;
      return [{ path: { d: sh.d, fill: sh.fill, stroke: null, strokeWidth: 0 } }];
    }
  }
}

/** 레이어 이름은 PDF 문자열로 나가므로 ASCII 로 접는다 (Illustrator 레이어 패널 표기) */
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "").trim();

/**
 * 레이어를 무엇 단위로 나눌지 — **한 답이 없다.**
 *
 * 실무 심사에서 세 직군이 서로 배타적인 것을 요구했다.
 *   `function` 기능 단위 (FILLS / OUTLINES / STITCH …)  — 기본. 표현별로 일괄 손보기 좋다
 *   `part`     부품 단위 (Vamp / Quarter / Heel …)      — 풋웨어·패키징. 부품째 소재를 바꾼다
 *   `color`    잉크 색 단위                              — 스크린프린트. 색 하나 = 판 하나
 *
 * 예전에는 "요구가 상충하니 못 정한다"고 미뤄 뒀다. 그건 답이 아니다 — **셋 다 낼 수
 * 있게** 하고 쓰는 쪽이 고르면 된다.
 */
export type LayerPreset = "function" | "part" | "color";

export function sceneToAiDoc(scene: VectorScene, preset: LayerPreset = "function"): AiDoc {
  if (preset === "part") return byPartDoc(scene);
  if (preset === "color") return byColorDoc(scene);
  const byId = new Map(scene.parts.map((p) => [p.id, p]));
  const sharedIds = new Set(scene.sharedBoundaries.map((s) => s.primitiveId));

  const motifs = new Map<string, { d: string; fill: string | null; stroke?: string | null; strokeWidth?: number }>();
  for (const p of scene.primitives) {
    if (p.cls !== "REPEATING_PATTERN") continue;
    const t = p as PatternPrimitive;
    if (t.paint === "stroke") motifs.set(String(t.id), { d: t.motif, fill: null, stroke: t.fill, strokeWidth: t.strokeWidth ?? 1 });
    else motifs.set(String(t.id), { d: t.motif, fill: t.fill });
  }

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

  return { width: scene.canvas.width, height: scene.canvas.height, layers, motifs };
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

function pathOps(p: AiPath, flip: (y: number) => number, H?: number): string {
  // **모티프 참조**는 패스를 그리지 않고 Form XObject 를 호출한다.
  //
  // 좌표계가 뒤집혀 있다는 점이 함정이다. 모티프는 **SVG 좌표(y 아래)** 로 정의되고,
  // XObject 안에서 뒤집힌 뒤 페이지 좌표로 놓인다. 그래서 인스턴스 행렬을 그대로 쓰면
  // 안 되고, "페이지 뒤집기 → 인스턴스 이동 → 다시 뒤집기" 를 합성해야 제자리에 앉는다.
  if (p.motifRef && H !== undefined) {
    const [a, b, c, d, e, f] = p.motifRef.matrix;
    // 모티프는 y 아래 좌표로 그려져 있고 페이지는 y 위다. 인스턴스 행렬 M 을 적용한 뒤
    // 페이지 뒤집기 F = [1,0,0,-1,0,H] 를 씌우면 되므로 CTM = F · M 이다.
    //   x'' = a·x + c·y + e
    //   y'' = -(b·x + d·y + f) + H
    // → [a, -b, c, -d, e, H-f]. (앞뒤로 두 번 씌우면 제자리로 돌아와 그림이 어긋난다 —
    //    실제로 그렇게 적었다가 IoU 0.87 에 2만 픽셀이 더 그려졌다.)
    const m: [number, number, number, number, number, number] = [
      a, -b, c, -d, e, H - f,
    ];
    return `q
${f2(m[0])} ${f2(m[1])} ${f2(m[2])} ${f2(m[3])} ${f2(m[4])} ${f2(m[5])} cm
` +
      `/M${p.motifRef.key} Do
Q
`;
  }
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
      for (const p of g.paths) content += pathOps(p, flip, H);
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

  // ── 반복 모티프를 Form XObject 로 ────────────────────────
  //
  // 인스턴스마다 펼치면 같은 모양이 수백~수천 벌 들어간다(실측 s_bag_04: 1,360 인스턴스).
  // 한 번만 정의하고 참조하면 파일이 그만큼 가벼워지고, 모티프 하나를 고쳐 전체를 바꿀
  // 여지도 생긴다.
  //
  // **모티프는 자기 좌표계(y 아래)로 그린다.** 페이지 뒤집기는 인스턴스 행렬이 맡는다 —
  // 여기서 또 뒤집으면 두 번 뒤집혀 제자리로 돌아온다.
  /** 모티프 로컬 좌표의 경계 — M/L/C 절대좌표만 나오므로 숫자 쌍 전수로 충분하다 */
  const motifBBox = (d: string, pad: number): [number, number, number, number] => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const nums = d.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = +nums[i], y = +nums[i + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!Number.isFinite(x0)) return [0, 0, 1, 1];
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  };
  const usedMotifs = new Set<string>();
  for (const l of doc.layers) for (const g of l.groups) for (const pp of g.paths) {
    if (pp.motifRef) usedMotifs.add(pp.motifRef.key);
  }
  const motifOrder = [...usedMotifs].filter((k) => doc.motifs?.has(k));
  const motifStreams = motifOrder.map((k) => {
    const mo = doc.motifs!.get(k)!;
    // 모티프 안에서는 뒤집지 않는다 (flip = 항등)
    return pathOps({ d: mo.d, fill: mo.fill, stroke: mo.stroke ?? null, strokeWidth: mo.strokeWidth ?? 0 }, (y) => y);
  });

  const objects: string[] = [];
  objects[1] =
    `<< /Type /Catalog /Pages 2 0 R ` +
    `/OCProperties << /OCGs [${allRefs}] ` +
    `/D << /Order [${order}] /ON [${allRefs}] /BaseState /ON >> >> >>`;
  objects[2] = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  const props = ocs.map((o) => `/oc${o.id} ${ref(o)}`).join(" ");
  const XO0 = OC0 + ocs.length;
  const xoRes = motifOrder.map((k, i) => `/M${k} ${XO0 + i} 0 R`).join(" ");
  objects[3] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f2(doc.width)} ${f2(doc.height)}] ` +
    `/Contents 4 0 R /Resources << /Properties << ${props} >>` +
    (xoRes ? ` /XObject << ${xoRes} >>` : "") + ` >> >>`;
  const bytes = Buffer.byteLength(content, "latin1");
  objects[4] = `<< /Length ${bytes} >>\nstream\n${content}endstream`;
  for (const o of ocs) objects[OC0 + o.id] = `<< /Type /OCG /Name (${pdfString(o.name)}) >>`;
  motifOrder.forEach((k, i) => {
    const body = motifStreams[i];
    // **BBox 는 모티프 자기 크기다.** 캔버스 전체로 두면 Illustrator 가 인스턴스마다
    // 캔버스만 한 선택 박스를 잡는다 — 실측: 메시 패턴 수백 인스턴스가 전부 페이지
    // 크기 바운딩으로 잡혀 편집이 불가능했다. 좌표 전수(컨트롤 포인트 포함)에
    // 선 굵기 절반을 더한 값이면 넉넉하고 정확하다.
    const mo = doc.motifs!.get(k)!;
    const bb = motifBBox(mo.d, (mo.strokeWidth ?? 0) / 2 + 0.5);
    objects[XO0 + i] =
      `<< /Type /XObject /Subtype /Form /FormType 1 ` +
      `/BBox [${f2(bb[0])} ${f2(bb[1])} ${f2(bb[2])} ${f2(bb[3])}] ` +
      `/Resources << >> /Length ${Buffer.byteLength(body, "latin1")} >>
stream
${body}endstream`;
  });

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

export function exportAi(scene: VectorScene, preset: LayerPreset = "function"): Buffer {
  return buildAiV4(sceneToAiDoc(scene, preset));
}

/** 색을 6비트로 접어 묶는다 — 미세한 차이로 판이 갈리면 인쇄에서 못 쓴다 */
function inkBucket(p: ScenePrimitive): string {
  const c = (p as { fill?: string; color?: string; stroke?: string });
  const hex = (c.fill ?? c.stroke ?? c.color ?? "#000000").replace("#", "");
  if (hex.length < 6) return "OTHER";
  const q = (i: number) => (parseInt(hex.slice(i, i + 2), 16) >> 5) << 5;
  const r = q(0), g = q(2), b = q(4);
  return `INK_${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** 부품 우선 — 레이어 = 부품, 하위 = 표현 */
function collectMotifs(scene: VectorScene): Map<string, { d: string; fill: string | null; stroke?: string | null; strokeWidth?: number }> {
  const m = new Map<string, { d: string; fill: string | null; stroke?: string | null; strokeWidth?: number }>();
  for (const p of scene.primitives) {
    if (p.cls !== "REPEATING_PATTERN") continue;
    const t = p as PatternPrimitive;
    if (t.paint === "stroke") m.set(String(t.id), { d: t.motif, fill: null, stroke: t.fill, strokeWidth: t.strokeWidth ?? 1 });
    else m.set(String(t.id), { d: t.motif, fill: t.fill });
  }
  return m;
}

function byPartDoc(scene: VectorScene): AiDoc {
  const byId = new Map(scene.parts.map((p) => [p.id, p]));
  const perPart = new Map<string, Map<string, AiPath[]>>();
  for (const p of scene.primitives) {
    const b = bucketOf(p);
    for (const { path, partId } of primToPaths(p)) {
      const pid = partId ?? p.partId ?? "_unassigned";
      const m = perPart.get(pid) ?? perPart.set(pid, new Map()).get(pid)!;
      (m.get(b) ?? m.set(b, []).get(b)!).push(path);
    }
  }
  // **부품 순서는 z 를 따른다** — 뒤에 있는 부품이 먼저 칠해져야 앞 부품이 덮는다
  const layers: AiLayer[] = [...perPart.entries()]
    .sort((a, b) => (byId.get(a[0])?.z ?? 99) - (byId.get(b[0])?.z ?? 99))
    .map(([pid, m]) => ({
      name: ascii(byId.get(pid)?.label ?? pid) || pid,
      // 부품 안에서는 면이 먼저, 그 위에 선 — 안 그러면 면이 자기 선을 덮는다
      groups: BUCKET_ORDER.filter((b) => m.has(b))
        .map((b) => ({ name: b, paths: m.get(b)! })),
    }));
  return { width: scene.canvas.width, height: scene.canvas.height, layers, motifs: collectMotifs(scene) };
}

/** 잉크 색 우선 — 레이어 = 색, 하위 = 부품. 스크린프린트 분판용 */
function byColorDoc(scene: VectorScene): AiDoc {
  const byId = new Map(scene.parts.map((p) => [p.id, p]));
  const perInk = new Map<string, Map<string, AiPath[]>>();
  for (const p of scene.primitives) {
    const ink = inkBucket(p);
    for (const { path, partId } of primToPaths(p)) {
      const pid = partId ?? p.partId ?? "_unassigned";
      const m = perInk.get(ink) ?? perInk.set(ink, new Map()).get(ink)!;
      (m.get(pid) ?? m.set(pid, []).get(pid)!).push(path);
    }
  }
  // 어두운 잉크가 마지막에 찍히도록 — 밝은 판부터
  const lum = (k: string) => (k.startsWith("INK_") ? parseInt(k.slice(4, 6), 16) : 0);
  const layers: AiLayer[] = [...perInk.entries()]
    .sort((a, b) => lum(b[0]) - lum(a[0]))
    .map(([ink, m]) => ({
      name: ink,
      groups: [...m.entries()].map(([pid, paths]) => ({
        name: ascii(byId.get(pid)?.label ?? pid) || pid,
        paths,
      })),
    }));
  return { width: scene.canvas.width, height: scene.canvas.height, layers, motifs: collectMotifs(scene) };
}
