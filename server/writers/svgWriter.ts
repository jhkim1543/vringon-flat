import type { VectorIR } from "../types.js";

/** 레이어 그룹 구조를 유지한 SVG (Illustrator 외 편집기 호환용) */
export function buildSvg(ir: VectorIR): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ir.width}" height="${ir.height}" viewBox="0 0 ${ir.width} ${ir.height}">`,
  ];
  for (const layer of ir.layers) {
    lines.push(`  <g id="${esc(layer.name)}">`);
    for (const group of layer.groups) {
      lines.push(`    <g id="${esc(`${layer.name}/${group.name}`)}">`);
      for (const p of group.paths) {
        const fill = p.fill ?? "none";
        const stroke = p.stroke
          ? ` stroke="${p.stroke}" stroke-width="${p.strokeWidth}"`
          : "";
        lines.push(`      <path d="${p.d}" fill="${fill}" fill-rule="evenodd"${stroke}/>`);
      }
      lines.push(`    </g>`);
    }
    lines.push(`  </g>`);
  }
  lines.push(`</svg>`);
  return lines.join("\n");
}
