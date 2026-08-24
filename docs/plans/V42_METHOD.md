# V4.2 개발 방법론 — 외부 딥리서치 분석과 적용 계획

2026-08-24. 외부 딥리서치 감사(LayerD·LayerPeeler·AmodalSVG·SemLayer·SAM 3 계열 조사 포함)를
받아 코드 실태와 대조 검증한 결과와, 그에 따른 단계별 적용 계획.

## 감사 주장 검증 — 무엇이 맞고 무엇이 이미 있었나

| 감사 주장 | 검증 결과 |
|---|---|
| "GPT로 파트를 먼저 나누라" | **이미 있다.** `run4.ts` S2가 GPT 구성품 분해(파트·bbox·z-order·가림)를 수행한다. 문제는 GPT가 주는 것이 픽셀 마스크가 아니라 명칭·대략적 bbox라는 것 |
| "고정 SAM_NOUNS가 세부 파트를 못 잡는다" | **맞다.** `v2/masks.ts`의 고정 일반명사 목록에 `front_flap`·`gusset`·`trim_band` 등이 없어 bbox 색 성장이 fallback이 된다 |
| "사진 마스크를 도면으로 warp하는 것이 근본 한계" | **맞다.** bag_1은 사진↔도면 종횡비 불일치가 19.8% — 도면은 모델이 다시 그린 그림이라 전역 similarity로는 절대 안 맞는다 |
| "파트 crop을 각각 다시 그리게 하지 말라" | **동의.** 공유 경계 이중 생성·파트별 원근 불일치·가림 추정 충돌. 채택하지 않는다 |
| "subpath가 path 수를 숨긴다" | **맞았고 V4.1에서 이미 지표화됨.** 추가로 감사 후 검증에서 d= 정규식 버그로 수치가 부풀어 있던 것도 잡음 |
| "supersample 좌표 기준 허용오차라 과촘촘" | **맞다.** simplifyPx 0.8이 2배 확대 캔버스에 적용돼 원본 기준 0.4px였다 |
| "닫힌 면이 패턴 후보에 안 들어간다" | **맞다.** `findPatterns` 입력이 잉크 성분뿐이라 비즈 알·러그·보석 알(선이 감싼 면)은 영영 못 본다 |
| "질감 삭제 전에 의미 분류를 하라" | **맞다.** V4.1 검증에서 실측 — 해프톤 분류가 스티치·로고를 삼켰다(bag_1 누락 1,297곳) |

## 채택하는 구조 (감사 권고와 동일)

**Layer-first + Global-vector-once 하이브리드.**
한 장의 도면 좌표계에서 semantic mask를 먼저 만들고, 선은 전체를 한 번만 벡터화한 뒤,
면·선·패턴을 semantic layer에 배분한다. 파트 crop별 재생성은 하지 않는다.

## 단계별 계획

### Phase A — 모델 학습·신규 API 없이 (이번에 적용)

| # | 항목 | 구현 |
|---|---|---|
| A1 | **삭제 직전 디테일 구제** — 스티치 대시(신장률≥2.2 + 장축 방향 사슬 + 간격 CV≤0.45), 로고 문자(중앙값 8배 크기 또는 구멍 보유)를 해프톤 삭제에서 제외 | `v3/detailRescue.ts`, `v4/evidence.ts`·`v3/lineVector.ts` 양쪽 연결 |
| A2 | **원본 좌표 기준 단순화 허용오차** — `eps = min(1.6, simplifyPx × supersample)` | `lineVector.ts`·`scene.ts` |
| A3 | **닫힌 면도 패턴 후보로** — `findPatterns` 입력 일반화(`PatternCandidate`), 프리미티브 적합보다 먼저 면 군집을 검사, 인스턴스별 partId | `pattern.ts`·`scene.ts` |
| A4 | 살린 잉크는 질감 마스크에서도 제외 — QA가 손실을 눈감지 못하게 | A1에 포함 |

사슬 방향성 판별의 핵심: 메시 격자 점도 사슬을 이루지만 **이웃이 2축 이상**으로 퍼지고
점이 둥글다(신장률 ~1). 스티치 대시는 길쭉하고 이웃이 **자기 장축 방향 1축**에만 있다.
그래서 신장률 문턱이 격자를 원천 차단한다.

### Phase B — 외부 세그멘테이션 API 필요 (다음 단계)

핵심은 **최종 도면 자체를 직접 segment**하는 것. 사진 마스크는 prior로만 쓴다.

1. GPT 계층형 LayerGraph(물리 파트 / 하드웨어 / 마킹 / 스티치 / 재질 / 그림자) —
   파트별 positive·negative concept 생성. `OPENAI_API_KEY` 보유, 즉시 가능.
2. Gemini 2.5 Flash native segmentation으로 도면에서 polygon 제안 —
   `GEMINI_API_KEY` 보유, 즉시 가능. (Gemini 3에는 native segmentation이 없어 2.5 Flash 사용)
3. SAM 3 정교화 — `FAL_KEY` 발급 대기. 키가 들어오면 `falClient.sam3Concepts`가 자동 전환.
4. 마스크 경계를 도면 선에 snap → 전역 partition(모든 픽셀이 정확히 한 파트).
5. 가려진 부분만 amodal completion(가시 픽셀 lock). LayerPeeler·AmodalSVG 방식.

### Phase C — 도메인 특화 (측정 후 결정)

디자이너 수정 마스크 축적 → SAM 미세조정 → 재질 패턴 분류기. Phase B 성능 실측 후에만.

## 채택하지 않는 것과 이유

- **파트 crop별 이미지 재생성 후 합성** — 공유 경계가 파트마다 달리 그려져 이중선·틈 발생.
  같은 가림을 crop마다 다르게 복원. 감사도 동일 결론.
- **곡선 carrier + dasharray 강제 승격** — 이전 실측에서 주얼리 구멍 38→24 회귀.
  위상(phase) 어긋남이 F@2를 깎는다. 구제된 스티치는 당분간 outline/패턴으로 보존하고,
  곡선 carrier는 위상 검증(래스터 재검산)과 함께 별도 도입.

## 남은 P1 (변경 없음)

- 라우팅 단위가 connected component라 너무 크다 → junction 축약 graph edge 단위
- junction continuity 전역 미해결 · 가변 폭 없음 · 패턴 인스턴스 회전 0 고정
