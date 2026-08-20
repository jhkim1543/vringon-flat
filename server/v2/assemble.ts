/**
 * S13 최종 SVG 조립 — 개발계획서 §12.
 *
 * 예시 7의 DOM 계약을 그대로 지킨다:
 *   · viewBox = 원본 canvas, 레이어별 transform 없음
 *   · <metadata id="layer-manifest"> 에 manifest 요약(해시·provenance)
 *   · <defs> 에 gradient/clipPath, job 내 collision-free prefix
 *   · <g id="layer-{manifest.id}" inkscape:label="{한국어 이름}"
 *        data-z-index data-role data-material>
 *   · z_index 낮은 것부터, appearance sublayer는 parent 바로 위
 *   · strict_vector=true면 <image>·external href 금지
 */
import crypto from "node:crypto";
import type { LayerVector, GradientDef } from "./vectorizeV2.js";
import type { LayerManifest, ManifestLayer } from "./schema.js";

export interface AssembleResult {
  svg: string;
  /** SVG의 top-level group id → manifest layer id (1:1 대응 검증용) */
  groupMap: { groupId: string; layerId: string; zIndex: number }[];
  stats: { paths: number; nodes: number; bytes: number; gradients: number };
  violations: string[];
}

export function assembleSvg(
  manifest: LayerManifest,
  vectors: Map<string, LayerVector>,
  W: number,
  H: number,
  opts: { layerOpacity?: Map<string, number> } = {},
): AssembleResult {
  const violations: string[] = [];
  const groupMap: AssembleResult["groupMap"] = [];

  // §12.2 z-order: 낮은 z_index를 먼저 기록 (DOM 순서 = back→front)
  const ordered = [...manifest.layers].sort((a, b) => a.z_index - b.z_index);

  // defs — job 내 collision-free prefix (§12.2 stable ID)
  const jobPrefix = crypto
    .createHash("sha1")
    .update(manifest.provenance?.input_sha256 ?? manifest.object.category)
    .digest("hex")
    .slice(0, 6);

  const gradients: GradientDef[] = [];
  for (const L of ordered) {
    const v = vectors.get(L.id);
    if (v) gradients.push(...v.gradients);
  }

  const defs: string[] = [];
  for (const g of gradients) {
    const id = `${jobPrefix}-${g.id}`;
    if (g.type === "linear") {
      defs.push(
        `    <linearGradient id="${id}" gradientUnits="userSpaceOnUse" ` +
          `x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}">\n` +
          g.stops
            .map((s) => `      <stop offset="${s.offset.toFixed(3)}" stop-color="${s.color}"${s.opacity != null ? ` stop-opacity="${s.opacity}"` : ""}/>`)
            .join("\n") +
          `\n    </linearGradient>`,
      );
    } else {
      defs.push(
        `    <radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${g.cx}" cy="${g.cy}" r="${g.r}">\n` +
          g.stops.map((s) => `      <stop offset="${s.offset.toFixed(3)}" stop-color="${s.color}"/>`).join("\n") +
          `\n    </radialGradient>`,
      );
    }
  }

  // metadata — 전체 manifest 원문은 별도 JSON, SVG에는 해시·요약·provenance (§12.2)
  const manifestHash = crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const summary = {
    schema_version: manifest.schema_version,
    manifest_sha256: manifestHash,
    category: manifest.object.category,
    target_mode: manifest.policy.target_mode,
    layers: ordered.map((L) => ({ id: L.id, z: L.z_index, role: L.semantic_role, material: L.material })),
    provenance: manifest.provenance,
  };

  const body: string[] = [];
  let totalPaths = 0, totalNodes = 0;

  for (const L of ordered) {
    const v = vectors.get(L.id);
    if (!v || !v.paths.length) {
      violations.push(`레이어 ${L.id}에 path가 없습니다`);
      continue;
    }
    const gid = `layer-${L.id}`;
    groupMap.push({ groupId: gid, layerId: L.id, zIndex: L.z_index });

    const op = opts.layerOpacity?.get(L.id);
    const attrs = [
      `id="${gid}"`,
      `inkscape:label="${escapeAttr(L.label || L.id)}"`,
      `data-z-index="${L.z_index}"`,
      `data-role="${L.semantic_role}"`,
      `data-material="${L.material}"`,
      `data-profile="${v.profile}"`,
      L.requires_review ? `data-review="true"` : "",
      op != null && op < 0.995 ? `opacity="${op.toFixed(3)}"` : "",
    ].filter(Boolean);

    const paths = v.paths.map((p) => {
      totalPaths++;
      totalNodes += (p.d.match(/[LCQMZ]/gi) ?? []).length;
      const fill = p.gradientId
        ? `url(#${jobPrefix}-${p.gradientId})`
        : p.fill ?? "none";
      const bits = [`d="${p.d}"`, `fill="${fill}"`];
      if (p.fill || p.gradientId) bits.push(`fill-rule="${p.fillRule}"`);
      if (p.stroke) {
        bits.push(`stroke="${p.stroke}"`);
        bits.push(`stroke-width="${p.strokeWidth ?? 2}"`);
        bits.push(`stroke-linecap="round"`, `stroke-linejoin="round"`);
      }
      return `      <path ${bits.join(" ")}/>`;
    });

    body.push(`    <g ${attrs.join(" ")}>\n${paths.join("\n")}\n    </g>`);
  }

  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg"\n` +
    `     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"\n` +
    `     viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" data-schema-version="${manifest.schema_version}">\n` +
    `  <metadata id="layer-manifest">${escapeText(JSON.stringify(summary))}</metadata>\n` +
    (defs.length ? `  <defs>\n${defs.join("\n")}\n  </defs>\n` : "") +
    `${body.join("\n")}\n` +
    `</svg>\n`;

  // §12.2 strict check — <image>·external href 금지 (부록 A)
  if (manifest.policy.strict_vector) {
    if (/<image\b/i.test(svg)) violations.push("strict_vector인데 <image> 태그가 있습니다");
    if (/href\s*=\s*"(?!#)/i.test(svg)) violations.push("strict_vector인데 외부 href가 있습니다");
    if (/data:image\//i.test(svg)) violations.push("strict_vector인데 embedded bitmap이 있습니다");
  }
  // manifest layer와 SVG group의 1:1 대응 (§12.2 round trip, 부록 A)
  const manifestIds = new Set(ordered.map((L) => L.id));
  const groupIds = new Set(groupMap.map((g) => g.layerId));
  for (const id of manifestIds) if (!groupIds.has(id)) violations.push(`manifest 레이어 ${id}가 SVG에 없습니다`);
  for (const id of groupIds) if (!manifestIds.has(id)) violations.push(`SVG 그룹 ${id}가 manifest에 없습니다`);

  return {
    svg,
    groupMap,
    stats: { paths: totalPaths, nodes: totalNodes, bytes: Buffer.byteLength(svg), gradients: gradients.length },
    violations,
  };
}

/** 개별 레이어 SVG (layers/{id}.svg — 계획서 산출물) */
export function assembleLayerSvg(L: ManifestLayer, v: LayerVector, W: number, H: number): string {
  const paths = v.paths
    .map((p) => {
      const fill = p.gradientId ? `url(#${p.gradientId})` : p.fill ?? "none";
      const bits = [`d="${p.d}"`, `fill="${fill}"`];
      if (p.fill || p.gradientId) bits.push(`fill-rule="${p.fillRule}"`);
      if (p.stroke) bits.push(`stroke="${p.stroke}"`, `stroke-width="${p.strokeWidth ?? 2}"`, `stroke-linecap="round"`);
      return `    <path ${bits.join(" ")}/>`;
    })
    .join("\n");
  const defs = v.gradients.length
    ? `  <defs>\n` +
      v.gradients
        .map(
          (g) =>
            `    <linearGradient id="${g.id}" gradientUnits="userSpaceOnUse" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}">\n` +
            g.stops.map((s) => `      <stop offset="${s.offset.toFixed(3)}" stop-color="${s.color}"/>`).join("\n") +
            `\n    </linearGradient>`,
        )
        .join("\n") +
      `\n  </defs>\n`
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n` +
    defs +
    `  <g id="layer-${L.id}" data-role="${L.semantic_role}" data-material="${L.material}">\n${paths}\n  </g>\n` +
    `</svg>\n`
  );
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
