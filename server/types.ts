// ── 파이프라인 공용 타입 ──────────────────────────────────────

export type Category =
  | "footwear"
  | "jewelry"
  | "bag"
  | "apparel"
  | "eyewear"
  | "watch"
  | "headwear"
  | "furniture"
  | "electronics"
  | "packaging"
  | "other";
export type Style = "bw" | "color" | "design";
export type LayerDetail = "simple" | "standard" | "detailed";

/** 1단계: GPT 비전이 만드는 레이어 계획 */
export interface LayerPlan {
  category: Category;
  /** 제품 전체를 가리키는 일반 영어 명사 — SAM 3 배경 격리/보정용 */
  objectNoun: string;
  view: string;
  parts: PartPlan[];
}
export interface PartPlan {
  id: string;
  name: string;
  parent: string; // UPPER / SOLE / BRANDING / BODY / HARDWARE ...
  kind: "fill" | "line" | "logo";
  segPrompt: string; // segmentation 모델에 줄 텍스트 프롬프트
}

/** 2단계: 파트별 픽셀 마스크 */
export interface PartMask {
  partId: string;
  maskPath: string; // white-on-black PNG (원본 크기)
  bbox: [number, number, number, number]; // x, y, w, h (px)
  area: number; // 마스크 픽셀 수
  source: "sam3" | "gemini";
}

/** 3단계: 플랫 이미지 candidate */
export interface FlatCandidate {
  id: string;
  model: "gemini" | "gpt-image";
  kind: "lineart" | "colorflat";
  imagePath: string;
  score?: CandidateScore;
}
export interface CandidateScore {
  total: number;
  silhouetteIoU: number;
  edgeQuality: number;
  bilevelPurity: number;
}

/** 5~6단계: Vector IR — .ai/.jsx/.svg의 마스터 데이터 */
export interface VectorIR {
  width: number;
  height: number;
  layers: IRLayer[];
}
export interface IRLayer {
  name: string;
  groups: IRGroup[];
}
export interface IRGroup {
  name: string;
  paths: IRPath[];
}
export interface IRPath {
  /** SVG path data (M/L/C/Z만 사용, 절대좌표) */
  d: string;
  fill: string | null; // "#rrggbb" | null
  stroke: string | null;
  strokeWidth: number;
  vectorizer: "vectorizer.ai" | "vtracer";
}

/** 잡 상태 */
export type StageId =
  | "prepare"
  | "understand"
  | "flatgen"
  | "rank"
  | "segment"
  | "qa"
  | "vectorize"
  | "optimize"
  | "build";

export interface StageState {
  id: StageId;
  label: string;
  status: "pending" | "running" | "done" | "error" | "skipped";
  detail?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface JobOptions {
  style: Style;
  layerDetail: LayerDetail;
  categoryHint?: Category;
  /** 기존 잡의 plan.json 재사용 (OpenAI 불가 시 E2E 재현용) */
  planFrom?: string;
}

export interface Job {
  id: string;
  createdAt: number;
  status: "running" | "done" | "error";
  error?: string;
  options: JobOptions;
  inputPath: string;
  /** 정규화만 된 원본 (배경 격리 전) */
  rawPath: string;
  inputNotes?: string[];
  stages: StageState[];
  plan?: LayerPlan;
  masks?: PartMask[];
  candidates?: FlatCandidate[];
  qa?: {
    pass: boolean;
    coverage: number;
    spill: number;
    duplicates: { a: string; b: string; iou: number }[];
    emptyLayers: string[];
    /** 재합성 색차(평균 RGB 거리). 형태 지표가 놓치는 "색이 틀린 레이어"를 잡는다 */
    colorDeltaE?: number;
    colorOutliers?: { name: string; deltaE: number }[];
    notes: string[];
  };
  winner?: { lineart?: string; colorflat?: string };
  outputs?: {
    ai?: string;
    jsx?: string;
    svg?: string;
    layerPngs?: string[];
  };
  engines: { segment: string; vectorize: string };
}
