import type { VectorIR, IRPath } from "../types.js";
import { parsePath } from "../vector/pathdata.js";

/**
 * 네이티브 Illustrator API 없이 만드는 .ai 파일.
 *
 * .ai(PDF 호환)는 본질적으로 PDF이며, Illustrator는 PDF의 OCG(Optional
 * Content Group)를 열 때 레이어로 복원한다. 여기서는 레이어별 OCG를 가진
 * PDF 1.6을 바이트 단위로 직접 조립한다. Illustrator에서 열면
 * IR의 최상위 레이어 구조가 그대로 레이어 패널에 나타난다.
 * (완전한 네이티브 편집 메타데이터가 필요하면 함께 출력되는 .jsx를
 * Illustrator에서 실행해 저장하면 된다.)
 */
export function buildAiPdf(ir: VectorIR): Buffer {
  const W = ir.width;
  const H = ir.height;
  const flip = (y: number) => H - y;
  const f = (n: number) => {
    const r = Math.round(n * 100) / 100;
    return Object.is(r, -0) ? "0" : String(r);
  };

  // ── content stream ──────────────────────────────────────────
  const ocNames: string[] = [];
  let content = "";
  ir.layers.forEach((layer, li) => {
    const oc = `OC${li}`;
    ocNames.push(oc);
    content += `/OC /${oc} BDC\n`;
    for (const group of layer.groups) {
      for (const p of group.paths) content += pathOps(p, flip, f);
    }
    content += "EMC\n";
  });

  // ── objects ────────────────────────────────────────────────
  // 1 Catalog, 2 Pages, 3 Page, 4 Contents, 5.. OCGs
  const ocgFirst = 5;
  const ocgRefs = ir.layers.map((_, i) => `${ocgFirst + i} 0 R`).join(" ");
  // 패널 순서는 최상단(마지막에 그려진 레이어)부터
  const orderRefs = ir.layers.map((_, i) => `${ocgFirst + i} 0 R`).reverse().join(" ");

  const objects: string[] = [];
  objects[1] =
    `<< /Type /Catalog /Pages 2 0 R ` +
    `/OCProperties << /OCGs [${ocgRefs}] ` +
    `/D << /Order [${orderRefs}] /ON [${ocgRefs}] /BaseState /ON >> >> >>`;
  objects[2] = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  const props = ir.layers.map((_, i) => `/OC${i} ${ocgFirst + i} 0 R`).join(" ");
  objects[3] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(W)} ${f(H)}] ` +
    `/Contents 4 0 R /Resources << /Properties << ${props} >> >> >>`;
  const contentBytes = Buffer.from(content, "latin1");
  objects[4] = `<< /Length ${contentBytes.length} >>\nstream\n${content}endstream`;
  ir.layers.forEach((layer, i) => {
    objects[ocgFirst + i] = `<< /Type /OCG /Name (${pdfString(layer.name)}) >>`;
  });

  // ── serialize + xref ───────────────────────────────────────
  let pdf = "%PDF-1.6\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, "latin1");
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, "latin1");
  const count = objects.length;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${count} /Root 1 0 R >>\n` +
    `startxref\n${xrefPos}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

function pathOps(p: IRPath, flip: (y: number) => number, f: (n: number) => string): string {
  const subs = parsePath(p.d);
  if (!subs.length) return "";
  let ops = "";
  if (p.fill) {
    const [r, g, b] = hexRgb(p.fill);
    ops += `${f(r)} ${f(g)} ${f(b)} rg\n`;
  }
  if (p.stroke) {
    const [r, g, b] = hexRgb(p.stroke);
    ops += `${f(r)} ${f(g)} ${f(b)} RG\n${f(p.strokeWidth || 1)} w\n`;
  }
  for (const sp of subs) {
    ops += `${f(sp.start[0])} ${f(flip(sp.start[1]))} m\n`;
    for (const s of sp.segs) {
      if (s.type === "L") ops += `${f(s.end[0])} ${f(flip(s.end[1]))} l\n`;
      else
        ops += `${f(s.c1![0])} ${f(flip(s.c1![1]))} ${f(s.c2![0])} ${f(flip(s.c2![1]))} ${f(s.end[0])} ${f(flip(s.end[1]))} c\n`;
    }
    if (sp.closed) ops += "h\n";
  }
  // even-odd 채움: potrace/Vectorizer 출력의 구멍(홀) 서브패스 보존
  ops += p.fill && p.stroke ? "B*\n" : p.fill ? "f*\n" : "S\n";
  return ops;
}

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
