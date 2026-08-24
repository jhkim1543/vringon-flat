/**
 * VectorScene — V4의 정본 중간 표현.
 *
 * V3는 SVG를 바로 만들었다. 그래서 "원본과 똑같이 보이는 결과"와 "Illustrator에서 만지기 좋은
 * 결과"를 **하나의 파일에 동시에** 요구하게 됐고, 둘은 서로 반대 방향이다 — 충실도를 올리면
 * 패스가 늘고, 패스를 줄이면 디테일이 깎인다.
 *
 * V4는 그 둘을 파일이 아니라 **표현 단계**에서 가른다. 파이프라인은 VectorScene 하나를 만들고,
 * 목적별 export가 같은 장면에서 서로 다른 SVG를 굽는다.
 *
 *   fidelity.svg     도면과 최대한 같아 보이는 것 — outline 위주, 디테일 보존 우선
 *   editable.svg     적은 패스·앵커 — centerline·프리미티브·패턴 위주
 *   production.svg   테크팩용 — 파트 레이어 · 공유 경계 · 기능 레이어 분리
 *
 * 그리고 **한 성분에는 한 표현만** 쓴다. V3의 hybrid는 centerline을 만든 뒤 남은 잉크를
 * outline으로 덮는 단방향이라, 어떤 성분이 어느 표현에 속하는지가 결과에만 있고 결정에는
 * 없었다. 여기서는 성분마다 먼저 분류하고 그 하나만 만든다.
 */

export interface Pt { x: number; y: number }

export interface SceneCanvas {
  /** 벡터가 사는 좌표계 — 도면 해상도 × supersample */
  width: number;
  height: number;
  /** 도면 원본 크기 (viewBox 환산용) */
  sourceWidth: number;
  sourceHeight: number;
  supersample: number;
}

/**
 * 성분 분류. **배타적**이다 — 한 성분은 정확히 하나를 받는다.
 *
 * 분류가 곧 표현이고, 표현이 곧 편집성이다. 굵기를 만지고 싶으면 STRUCTURAL_STROKE 여야 하고,
 * 원의 반지름을 바꾸고 싶으면 GEOMETRIC_PRIMITIVE 여야 한다.
 */
export type PrimitiveClass =
  /** 굵기가 안정적인 긴 구조선 — centerline + stroke-width */
  | "STRUCTURAL_STROKE"
  /** 원·타원·호·직선·둥근사각 — 파라미터로 표현 */
  | "GEOMETRIC_PRIMITIVE"
  /** 반복 모티프 — <symbol> 하나 + <use> 여럿 */
  | "REPEATING_PATTERN"
  /** 점선 스티치 — carrier 곡선 + stroke-dasharray */
  | "DASH_OR_STITCH"
  /** 로고·문자·하드웨어처럼 형상이 복잡한 것 — 채워진 컴파운드 패스 */
  | "OUTLINE_SHAPE"
  /** 해프톤 질감 — 톤 면 */
  | "TEXTURE_TONE"
  /** 선이 감싼 닫힌 면 */
  | "FACE_FILL";

/** 왜 그 표현이 선택됐는가 — 사람이 결과를 이해할 수 있어야 한다 */
export interface RouteReason {
  chosen: PrimitiveClass;
  /** 분류 근거 수치 */
  features: Record<string, number | boolean>;
  /** 한 줄 설명 */
  why: string;
  /** 0~1. 낮으면 QA가 검토 대상으로 올린다 */
  confidence: number;
}

export interface BasePrimitive {
  id: string;
  cls: PrimitiveClass;
  /** 이 도형이 속한 파트. 미배정이면 undefined */
  partId?: string;
  /** 이 도형을 함께 쓰는 다른 파트들 (파트 경계선) */
  shared?: string[];
  /** 잉크 픽셀 면적 — z 정렬·통계용 */
  area: number;
  bbox: [number, number, number, number];
  route: RouteReason;
}

export interface StrokePrimitive extends BasePrimitive {
  cls: "STRUCTURAL_STROKE" | "DASH_OR_STITCH";
  d: string;
  /** 선 굵기. 지금은 상수 하나 — 가변 폭은 미구현(README의 남은 과제) */
  width: number;
  color: string;
  /** DASH_OR_STITCH 일 때만 */
  dashArray?: string;
}

export interface ShapePrimitive extends BasePrimitive {
  cls: "OUTLINE_SHAPE" | "FACE_FILL" | "TEXTURE_TONE";
  d: string;
  fill: string;
}

export type GeometryKind = "circle" | "ellipse" | "line" | "roundedRect";

/**
 * 기하 프리미티브. **칠하는 방식이 두 가지다.**
 *
 * 선 성분에서 온 것은 stroke 로, **닫힌 면에서 온 것은 fill** 로 그려야 한다.
 * 이걸 하나로 뭉쳐 두면 면에서 온 프리미티브가 `stroke-width` 를 못 정해
 * 0 으로 나가고 **화면에서 사라진다** — 실측: bag_3 70/70, shoe_3 208/208,
 * jewelry_1 1/1, bag_1 3/3 이 stroke-width="0" 으로 출고돼 보이지 않았다.
 * 구멍 수가 줄고 파트 recall 이 떨어지는 원인이었다.
 */
export type GeometricPrimitive = BasePrimitive & {
  cls: "GEOMETRIC_PRIMITIVE";
  kind: GeometryKind;
  /** 파라미터 — kind 에 따라 다르다 */
  params: Record<string, number>;
  /** 렌더용 패스 (파라미터에서 생성) */
  d: string;
  /** 자유형 베지어 대비 앵커 절감분 */
  anchorsSaved: number;
  /** 적합 잔차 (px) */
  residual: { rms: number; max: number };
} & (
  | { paint: "stroke"; stroke: string; width: number }
  | { paint: "fill"; fill: string }
);

export interface PatternPrimitive extends BasePrimitive {
  cls: "REPEATING_PATTERN";
  /**
   * 모티프의 출처. "ink"는 잉크 성분(비즈 윤곽·대시)이라 선 충실도 QA에 포함되고,
   * "fill"은 선이 감싼 닫힌 면(돌 내부·러그 내부)이라 FACE_FILL 과 같은 규칙으로
   * 잉크 QA에서 제외된다 — 이걸 구분하지 않으면 흰 면이 QA에서 검정 잉크가 되어
   * bag_3 F@2 가 1.000 → 0.867 로 무너진다(실측).
   */
  paint?: "ink" | "fill";
  /** 모티프 하나의 패스 (모티프 로컬 좌표) */
  motif: string;
  motifSize: [number, number];
  /**
   * 인스턴스 배치. **파트는 인스턴스마다 다르다** — 하나의 메시·체인이 여러 파트 경계를
   * 넘나들면 군집 전체를 한 파트에 몰아넣을 수 없다. export 가 파트별로 나눠 낸다.
   */
  instances: { x: number; y: number; scale: number; rotate: number; partId?: string }[];
  fill: string;
  /** 개별 패스로 뒀을 때 대비 절감분 */
  pathsSaved: number;
}

export type ScenePrimitive = StrokePrimitive | ShapePrimitive | GeometricPrimitive | PatternPrimitive;

export interface PartNode {
  id: string;
  label: string;
  z: number;
  kind: string;
  confidence: number;
  occludedBy: string[];
}

/** 두 파트가 함께 쓰는 경계 — 한쪽에 강제 귀속시키지 않는다 */
export interface SharedBoundary {
  primitiveId: string;
  between: string[];
}

export interface VectorScene {
  canvas: SceneCanvas;
  parts: PartNode[];
  primitives: ScenePrimitive[];
  sharedBoundaries: SharedBoundary[];
  /** 사진↔도면 대응의 품질 — global similarity 만 쓰므로 근사다 */
  correspondence: {
    method: "global-similarity" | "schematic-direct-seg" | "dense" | "none";
    aspectRatio: number;
    confident: boolean;
    note: string;
  };
  provenance: {
    pipeline: string;
    schematic: { backend: string; prompt: string; seed: number | null };
    createdAt: string;
    /** 라우터가 못 정한 성분 수 */
    lowConfidence: number;
  };
}

/** 클래스별 개수·면적 요약 — 라우팅이 실제로 어떻게 갈렸는지 */
export function routeSummary(scene: VectorScene): Record<string, { n: number; area: number }> {
  const out: Record<string, { n: number; area: number }> = {};
  for (const p of scene.primitives) {
    (out[p.cls] ??= { n: 0, area: 0 });
    out[p.cls].n++;
    out[p.cls].area += p.area;
  }
  return out;
}
