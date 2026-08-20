/**
 * Layer Manifest v1.0 — 파이프라인 전체의 단일 source of truth.
 *
 * 개발계획서 §6. GPT-5.6이 이 스키마로만 출력하고(Structured Outputs), 이후 모든
 * 단계는 이 manifest를 소비하는 worker다. 생성 모델이 레이어 개수나 순서를
 * 임의로 바꾸지 못하게 하는 것이 핵심(P1: 계획과 생성의 분리).
 *
 * 스키마를 바꾸면 `SCHEMA_VERSION`을 올리고 planner_prompt_version도 함께 올린다
 * (§7.3 프롬프트 버전 관리).
 */

export const SCHEMA_VERSION = "1.0";
export const PLANNER_PROMPT_VERSION = "planner.v1.3.0";
export const EXTRACT_PROMPT_VERSION = "qwen.extract.v1.2.1";

/** §6.2 레이어 계층 모델 */
export type SemanticRole =
  | "structural" // 제품의 실제 부품 또는 독립 형상
  | "appearance" // 부품에 종속되지만 독립 편집 가능한 시각 효과
  | "cutout" // 상위 레이어에서 배내는 음의 형상
  | "shadow" // 다른 레이어에 의해 생기며 구조와 분리되는 효과
  | "background"; // 기본적으로 출력에서 제외

/** §9.1 재질 — vector profile 분기의 1차 입력 */
export type Material =
  | "flat_color"
  | "polished_metal"
  | "brushed_metal"
  | "gemstone"
  | "glass"
  | "translucent"
  | "leather"
  | "fabric"
  | "rubber"
  | "plastic"
  | "texture"
  | "line_work";

/** §10.2 VectorProfile — 재질별 벡터 표현 전략 */
export type VectorProfile =
  | "flat_color"
  | "flat_precise"
  | "line_mono"
  | "metal_base"
  | "metal_gradient"
  | "gem_facet"
  | "mask_only";

/** §1.3 출력 품질 모드 */
export type TargetMode =
  | "clean_flat"
  | "faithful_vector"
  | "line_art"
  | "strict_vector"
  | "hybrid_review";

export interface ManifestLayer {
  /** kebab/snake 정규화된 고유 id. SVG에서 `layer-{id}`가 된다 */
  id: string;
  /** 사용자에게 보일 이름 (한국어 허용) */
  label: string;
  semantic_role: SemanticRole;
  /** appearance sublayer가 종속되는 structural layer id */
  parent_id: string | null;
  /** 0이 가장 뒤(back). DOM 순서가 곧 z-order */
  z_index: number;
  material: Material;
  /** [x0, y0, x1, y1] 0~1 정규화 — visible mask seed */
  bbox_norm: [number, number, number, number];
  /** 영문 서술 — Qwen positive prompt에 들어간다 */
  visible_description: string;
  /** 가려진 부분을 어떻게 이어야 하는지 (§8.3 복원 규칙의 근거) */
  hidden_geometry_hint: string;
  /** 이 레이어가 가리는 레이어 id들 */
  occludes: string[];
  /** 이 레이어를 가리는 레이어 id들 */
  occluded_by: string[];
  vector_profile: VectorProfile;
  /** 예상 색 수 — quantization 판단의 사전값 */
  expected_color_count: number;
  /** 0~1. 낮으면 requires_review */
  confidence: number;
  /** 숨은 형상이 불확실해 사람이 확인해야 하는가 (§P7) */
  requires_review: boolean;
}

export interface ManifestRelation {
  back: string;
  front: string;
  type: "occlusion" | "containment" | "adjacency";
  confidence: number;
}

export interface LayerManifest {
  schema_version: string;
  object: {
    category: string;
    view: string;
    style: string;
    background: string;
    confidence: number;
  };
  policy: {
    target_mode: TargetMode;
    strict_vector: boolean;
    max_layers: number;
    layer_order: "back_to_front";
  };
  layers: ManifestLayer[];
  relations: ManifestRelation[];
  /** §7.3 재현성 — 이 manifest를 만든 조건 */
  provenance?: {
    planner_prompt_version: string;
    model: string;
    input_sha256: string;
    created_at: string;
    repaired?: string[];
  };
}

/**
 * OpenAI Structured Outputs용 JSON Schema.
 *
 * strict 모드는 모든 필드가 required이고 additionalProperties:false여야 한다.
 * nullable은 `type: [.., "null"]`로 표현한다.
 */
export const MANIFEST_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "object", "policy", "layers", "relations"],
  properties: {
    schema_version: { type: "string" },
    object: {
      type: "object",
      additionalProperties: false,
      required: ["category", "view", "style", "background", "confidence"],
      properties: {
        category: { type: "string" },
        view: { type: "string" },
        style: { type: "string" },
        background: { type: "string" },
        confidence: { type: "number" },
      },
    },
    policy: {
      type: "object",
      additionalProperties: false,
      required: ["target_mode", "strict_vector", "max_layers", "layer_order"],
      properties: {
        target_mode: {
          type: "string",
          enum: ["clean_flat", "faithful_vector", "line_art", "strict_vector", "hybrid_review"],
        },
        strict_vector: { type: "boolean" },
        max_layers: { type: "integer" },
        layer_order: { type: "string", enum: ["back_to_front"] },
      },
    },
    layers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id", "label", "semantic_role", "parent_id", "z_index", "material",
          "bbox_norm", "visible_description", "hidden_geometry_hint",
          "occludes", "occluded_by", "vector_profile", "expected_color_count",
          "confidence", "requires_review",
        ],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          semantic_role: {
            type: "string",
            enum: ["structural", "appearance", "cutout", "shadow", "background"],
          },
          parent_id: { type: ["string", "null"] },
          z_index: { type: "integer" },
          material: {
            type: "string",
            enum: [
              "flat_color", "polished_metal", "brushed_metal", "gemstone", "glass",
              "translucent", "leather", "fabric", "rubber", "plastic", "texture", "line_work",
            ],
          },
          bbox_norm: {
            type: "array",
            items: { type: "number" },
            minItems: 4,
            maxItems: 4,
          },
          visible_description: { type: "string" },
          hidden_geometry_hint: { type: "string" },
          occludes: { type: "array", items: { type: "string" } },
          occluded_by: { type: "array", items: { type: "string" } },
          vector_profile: {
            type: "string",
            enum: ["flat_color", "flat_precise", "line_mono", "metal_base", "metal_gradient", "gem_facet", "mask_only"],
          },
          expected_color_count: { type: "integer" },
          confidence: { type: "number" },
          requires_review: { type: "boolean" },
        },
      },
    },
    relations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["back", "front", "type", "confidence"],
        properties: {
          back: { type: "string" },
          front: { type: "string" },
          type: { type: "string", enum: ["occlusion", "containment", "adjacency"] },
          confidence: { type: "number" },
        },
      },
    },
  },
} as const;

// ── 검증 ────────────────────────────────────────────────────

export interface ValidationIssue {
  code: string;
  message: string;
  layerId?: string;
  severity: "error" | "warning";
}

/**
 * 스키마 형태 검증 — GPT 출력이 downstream 계약을 만족하는지.
 * 부록 A: "GPT output은 JSON Schema를 통과하지 않으면 downstream으로 전달하지 않는다."
 *
 * 여기서는 구조적 무결성만 본다. 그래프(DAG) 검증은 graph.ts가 맡는다.
 */
export function validateManifestShape(m: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const push = (code: string, message: string, layerId?: string, severity: "error" | "warning" = "error") =>
    out.push({ code, message, layerId, severity });

  if (!m || typeof m !== "object") {
    push("not_object", "manifest가 객체가 아닙니다");
    return out;
  }
  const man = m as Partial<LayerManifest>;
  if (typeof man.schema_version !== "string") push("no_version", "schema_version 없음");
  if (!man.object || typeof man.object !== "object") push("no_object", "object 블록 없음");
  if (!man.policy || typeof man.policy !== "object") push("no_policy", "policy 블록 없음");
  if (!Array.isArray(man.layers) || !man.layers.length) {
    push("no_layers", "layers가 비어 있음");
    return out;
  }
  if (!Array.isArray(man.relations)) push("no_relations", "relations 배열 없음");

  const seen = new Set<string>();
  for (const L of man.layers) {
    if (!L?.id) { push("layer_no_id", "id 없는 레이어"); continue; }
    if (seen.has(L.id)) push("dup_id", `중복 id: ${L.id}`, L.id);
    seen.add(L.id);
    if (!/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(L.id))
      push("bad_id_format", `id는 snake/kebab 소문자여야 함: ${L.id}`, L.id, "warning");
    if (!Array.isArray(L.bbox_norm) || L.bbox_norm.length !== 4)
      push("bad_bbox", "bbox_norm은 4개 원소여야 함", L.id);
    else {
      const [x0, y0, x1, y1] = L.bbox_norm;
      if (![x0, y0, x1, y1].every((v) => Number.isFinite(v) && v >= -0.05 && v <= 1.05))
        push("bbox_range", `bbox_norm이 0~1 밖: ${L.bbox_norm.join(",")}`, L.id, "warning");
      if (x1 <= x0 || y1 <= y0) push("bbox_degenerate", "bbox_norm이 퇴화(넓이 0)", L.id);
    }
    if (typeof L.z_index !== "number") push("no_z", "z_index 없음", L.id);
    if (typeof L.confidence !== "number" || L.confidence < 0 || L.confidence > 1)
      push("bad_confidence", "confidence는 0~1", L.id, "warning");
  }

  // parent_id는 존재하는 레이어를 가리켜야 한다
  for (const L of man.layers) {
    if (L?.parent_id && !seen.has(L.parent_id))
      push("orphan_parent", `parent_id가 없는 레이어를 가리킴: ${L.parent_id}`, L.id);
  }
  // relations의 양끝도 마찬가지
  for (const r of man.relations ?? []) {
    if (!seen.has(r.back)) push("rel_unknown", `relation.back 미상: ${r.back}`, r.back, "warning");
    if (!seen.has(r.front)) push("rel_unknown", `relation.front 미상: ${r.front}`, r.front, "warning");
  }
  return out;
}

/** id 정규화 — §6.4-1 "모든 layer.id를 영문 kebab/snake 규칙으로 정규화하고 중복을 제거한다" */
export function normalizeLayerId(raw: string, taken: Set<string>): string {
  let id = raw
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "") // 비ASCII 제거 (한국어 이름은 label에 남는다)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!id) id = "layer";
  let out = id, n = 2;
  while (taken.has(out)) out = `${id}_${n++}`;
  taken.add(out);
  return out;
}
