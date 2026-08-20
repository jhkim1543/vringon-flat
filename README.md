# VRINGON FLAT

**제품 사진 한 장 → 플랫 스케치 → 파트별 레이어 분리 → Illustrator `.ai` 자동 생성**

디자이너가 테크팩을 그릴 때 하는 일 — 사진을 평면 도식으로 옮기고, 파트마다 레이어를
나누고, 벡터로 다시 그리는 일 — 을 파이프라인으로 만든 것입니다.
결과물은 Illustrator에서 바로 열려서 파트별로 색·형태를 수정할 수 있습니다.

**▶ 데모 · 결과 9종 · V2 레이어 SVG · API 문서: https://jhkim1543.github.io/vringon-flat/**

<sub>신발 · 가방 · 주얼리를 중심으로 검증했고, 의류·안경·시계·가구 등 11개 카테고리와
분류 밖의 물건도 처리합니다.</sub>

---

## 빠르게 써 보기

```bash
git clone https://github.com/jhkim1543/vringon-flat
cd vringon-flat
npm install
cp .env.example .env      # OPENAI_API_KEY / GEMINI_API_KEY / FAL_KEY 입력
npm run dev:api           # → http://localhost:5201
```

브라우저에서 `http://localhost:5201/demo/` — 데모 화면이 그대로 뜨고, **직접 실행** 탭에서
내 이미지를 넣어 볼 수 있습니다. 웹 UI가 따로 필요하면 `npm run dev`(Vite 포함).

```bash
# API로 바로 쓰기
curl -X POST http://localhost:5201/v1/jobs -F "image=@sneaker.jpg" -F "categoryHint=footwear"
# → {"id":"…","statusUrl":"…","pollAfterMs":5000}

curl http://localhost:5201/v1/jobs/<id>          # status: running → done
curl -o result.ai http://localhost:5201/v1/jobs/<id>/file/ai
```

한 건에 **2~5분**이 걸립니다(생성 모델 2종 + 분해 + 벡터화). 그래서 동기 응답이 아니라
잡을 만들고 폴링하는 방식입니다.

---

## API

전체 명세는 [`docs/openapi.yaml`](docs/openapi.yaml) (OpenAPI 3.1)이고,
읽기 좋은 문서는 [데모 페이지의 API 탭](https://jhkim1543.github.io/vringon-flat/#api)에 있습니다.

| 엔드포인트 | 하는 일 |
|---|---|
| `POST /v1/jobs` | 이미지 업로드 → `202 {id}` (백그라운드 실행) |
| `GET /v1/jobs/{id}` | 진행률·단계·QA 지표·결과 파일 URL |
| `GET /v1/jobs/{id}/file/{ai\|svg\|jsx\|ir}` | 산출물 다운로드 |
| `GET /v1/jobs` | 최근 잡 목록 |
| `GET /v1/health` | 엔진·키·한도 (인증 불필요) |

**인증** — `.env`의 `API_KEYS`를 채우면 `X-API-Key` 헤더가 필수가 됩니다.
비워 두면 인증 없이 열립니다(로컬 개발 기본값). **공개 배포 시 반드시 설정하세요.**

**산출물 4종**

| 종류 | 내용 |
|---|---|
| `.ai` | PDF 호환 + OCG 레이어. Illustrator에서 바로 열림 |
| `.jsx` | Illustrator 스크립트. 실행하면 **네이티브 `.ai`** 생성 (레이어 패널 완전 지원) |
| `.svg` | 웹 미리보기·타 툴 반입 |
| `.ir.json` | Vector IR — 레이어→그룹→패스 구조를 코드로 다룰 때 |

`.ai`를 두 가지로 내보내는 이유: PDF-OCG 방식은 어디서나 열리지만 Illustrator의
레이어 패널과 완전히 같지는 않습니다. 네이티브 레이어가 필요하면 `.jsx`를 실행하세요.

---

## 파이프라인

```
0  입력 정규화 · 배경 격리 · 복수 객체 분리
1  이미지 이해        → Layer Plan (카테고리 · 파트 목록 · 그룹 구조)
2  플랫 스케치 생성    → 2개 모델 × (라인아트 · 컬러플랫)
3  후보 자동 평가      → 실루엣 IoU · 엣지 · 색 순도
4  amodal 레이어 분해  → 가려진 부분까지 복원한 파트별 레이어
5  재합성 QA · 자가교정 → 어긋난 곳을 그 자리에서 고침
6  레이어별 벡터화     → 면은 윤곽 추적, 선은 중심선 추출
7  패스 정리·검증      → 깨진 패스 제거, 앵커 과다 경고
8  .ai / .jsx / .svg / IR 생성
```

### 왜 사진을 바로 벡터화하지 않는가

사진에는 그림자·반사·직물 질감이 있고, 벡터화기는 그걸 전부 형상으로 봅니다.
메시 운동화 한 켤레가 8,000개가 넘는 패스가 됩니다.
플랫 스케치로 한 번 옮기면 **평면 색면 + 윤곽선**만 남아, 이후 단계가 다뤄야 할 대상이
분명해집니다. 면과 선을 같은 이미지에서 뽑기 때문에 선이 면과 어긋나지도 않습니다.

### 레이어 분해 — 도구를 각자 잘하는 범위에서만

| 도구 | 하는 일 | 한계 (실측) |
|---|---|---|
| amodal 분해 | 가려진 부분까지 복원한 재질 단위 레이어 | 파트 **이름을 모름**, 레이어끼리 겹침 |
| 색 클러스터 + 연결요소 | 같은 재질이 떨어져 있으면 별개 파트 | 색만 보면 토캡/힐카운터가 뭉침 |
| SAM 3 | 일반 명사 경계 보정 | `sole` `shoelace` `tongue`은 되지만 `vamp` `quarter`는 마스크 0개 |
| 비전 모델 + 규칙 | 조각에 파트 이름 배정 | 모델이 죽으면 규칙(위치·크기·색 사전)이 대신함 |

### QA가 파이프라인 안에 있다

레이어를 실제 색으로 다시 쌓아 플랫과 대조하고, 어긋난 곳을 **그 자리에서 고칩니다**:
덮이지 않은 전경 회수 · 색이 다른 덩어리 분리 · 이름 없는 잔재 정리.
최종 지표는 API 응답의 `qa` 필드로 나옵니다.

| 지표 | 뜻 | 통과 기준 |
|---|---|---|
| `coverage` | 전경 중 레이어가 덮은 비율 | ≥ 0.8 |
| `spill` | 배경을 침범한 비율 | ≤ 0.08 |
| `colorDeltaE` | 재합성 평균 색차 (0~441) | ≤ 60 |

**샘플 9종 실측** (전부 통과)

| 샘플 | 커버리지 | 배경 침범 | 색차 ΔE | 레이어 | 패스 |
|---|---:|---:|---:|---:|---:|
| shoe_1 | 99.7% | 1.0% | 6.7 | 13 | 278 |
| shoe_2 | 99.8% | 0.1% | 9.5 | 24 | 943 |
| shoe_3 | 100% | 0.3% | 6.5 | 16 | 412 |
| bag_1 | 100% | 0.9% | 10.9 | 14 | 109 |
| bag_2 | 99.5% | 1.0% | 2.1 | 10 | 91 |
| bag_3 | 99.2% | 0.4% | 14.0 | 9 | 1,099 |
| jewelry_1 | 99.8% | 0.2% | 4.3 | 12 | 116 |
| jewelry_2 | 96.0% | 0.4% | 10.0 | 25 | 251 |
| jewelry_3 | 88.4% | 0.0% | 18.2 | 22 | 263 |

---

## 임의의 이미지를 넣어도 되는가

0단계가 어떤 입력이든 파이프라인의 전제("흰 배경을 꽉 채운 제품 한 점")로 맞춥니다.

- EXIF 회전 · 알파 채널 · CMYK/16bit → sRGB · 애니메이션 첫 프레임
- 배경이 있으면 제품만 오려내고, 제품이 작게 찍혔으면 크롭 (화면 14% 점유일 때 색이 전부 어긋났음)
- 한 화면에 신발 2개·반지 3개가 있으면 **인스턴스별로 따로 처리**해 하나의 `.ai`로 합침
- 종횡비 6:1을 넘거나 손상된 파일은 `400`으로 거절

어느 단계가 실패해도 산출물은 나옵니다. amodal 분해가 비면 플랫 색분해로, 이름 배정이
실패하면 `Region N`으로, 한쪽 이미지 모델이 죽으면 다른 쪽으로 진행합니다.

---

## 배포

```bash
docker build -t vringon-flat .
docker run -p 5201:5201 --env-file .env -v $PWD/outputs:/app/outputs vringon-flat
```

운영 시 확인할 것:

- `API_KEYS` 설정 (미설정 = 인증 없음)
- `MAX_CONCURRENT_JOBS` — 외부 모델 비용·레이트리밋 때문에 기본 2. 초과 요청은 `429`
- `outputs/`는 계속 쌓입니다. 볼륨으로 빼고 주기적으로 정리하세요
- 잡 목록은 **메모리에 있습니다**. 서버를 재시작하면 `GET /v1/jobs/{id}`는 404가 되지만
  산출물 파일은 디스크에 남습니다

---

## 필요한 키

| 키 | 쓰이는 곳 | 없으면 |
|---|---|---|
| `OPENAI_API_KEY` | 이미지 이해(Layer Plan) · 파트 명명 · 플랫 생성 1종 | 규칙 기반 명명으로 폴백, 이름이 거칠어짐 |
| `GEMINI_API_KEY` | 플랫 스케치 생성 1종 | 후보가 절반으로 줄어듦 |
| `FAL_KEY` | amodal 분해 + SAM 3 | **레이어 분해 불가** (필수) |
| `VECTORIZER_API_ID/SECRET` | 대체 벡터화 엔진 | 기본 엔진(로컬)이 씀 — 없어도 됨 |

기본 벡터화는 로컬 엔진(VTracer + 자체 중심선 추출)이라 과금이 없습니다.

---

## 개발

```bash
npm run dev          # API + 웹 UI
npm run typecheck
npm run smoke        # 과금 없는 스모크 테스트

npx tsx server/rebuild.ts <jobId>     # 생성 API 재호출 없이 분해~벡터화만 다시
npx tsx server/analyze.ts <jobId>     # 실루엣 IoU · 앵커 밀도 · 레이어 중복
npx tsx server/export-demo.ts         # docs/samples 갱신
```

`rebuild.ts`는 이미 만들어진 잡의 플랫 이미지와 amodal 캐시를 재사용하므로
**재과금 없이** 분해·벡터화 로직을 반복 검증할 수 있습니다. 파이프라인을 고칠 때 이걸 씁니다.

벡터 뷰어: `http://localhost:5201/viewer?job=<8자리>` — 레이어 토글, 채움/외곽선/앵커 3뷰.

---

## 알려진 제약

- 파트 **이름**은 비전 모델이 없으면 위치·색 규칙으로만 붙어 거칩니다 (`Region N`이 남을 수 있음).
- 메시·비즈처럼 반복 질감이 많은 제품은 선 패스가 많아져 Illustrator가 무거워집니다.
- 한 장의 사진에서 보이지 않는 면(바닥·안감)은 만들 수 없습니다.
- 잡 목록이 메모리에 있어 서버 재시작 시 상태 조회가 끊깁니다(파일은 남음).

---

## V2 — 레이어 분리 벡터 SVG (개발계획서 구현)

`server/v2/`는 별도 설계 문서(*단일 객체 디자인 이미지의 레이어 분리 벡터 SVG 변환 시스템*, v1.0)를
그대로 구현한 **두 번째 파이프라인**입니다. V1과 목표가 다릅니다.

| | V1 (기본) | V2 (`server/v2/`) |
|---|---|---|
| 목표 | 테크팩용 **클린 플랫 도면** | **원본 충실 재현** (사진 픽셀 보존) |
| 경로 | 사진 → 플랫 스케치 생성 → 분해 → 벡터 | 사진 → Layer Manifest → 가시 마스크 → amodal 복원 → 벡터 |
| 산출 | `.ai` / `.jsx` / `.svg` / IR | `layered.svg` / manifest / layers/{id}.{png,svg} / QA / bundle |
| 강점 | 패스·노드가 적어 편집이 가볍다 | 형상·색이 원본과 일치한다 |

```bash
npx tsx server/run-v2.ts <이미지> <이름> --preset draft|standard|high --category jewelry.ring
npx tsx server/compare-v1-v2.ts            # 같은 지표로 V1↔V2 비교표
```

### 16단계 (S00–S15)

| 단계 | 모듈 | 하는 일 |
|---|---|---|
| S00–S01 | `run2.ts` | 입력 수신·정규화·객체 격리·크롭 |
| S02 | `planner.ts` | GPT-5.6 Structured Outputs → **Layer Manifest** (단일 source of truth) |
| S03 | `graph.ts` | id 정규화 · occlusion DAG 검증 · 순환 제거 · z 재계산 |
| S04 | `masks.ts` | 레이어별 가시영역 마스크 (후보 생성·선택·커버리지 검증·bleed) |
| S05–S06 | `qwenWorker.ts` | 레이어별 프롬프트 구성 + K개 후보 생성 (seed/CFG/negative) |
| S07–S08 | `amodal.ts` | 가려진 영역 복원 + alpha matting · seam 색 조화 |
| S09 | `scorer.ts` | 후보 점수(mask·edge·color·shape·graph·hallucination) + beam search |
| S10–S12 | `profiles.ts`, `vectorizeV2.ts` | 재질 분기 · 프로파일 벡터화 · 기하/Bézier 정리 |
| S13 | `assemble.ts` | z-order대로 `<g>` 조립 · defs · metadata · strict 검사 |
| S14 | `qaV2.ts` | **SVG를 다시 래스터화해** 원본과 대조 (IoU·경계F·ΔE2000·SSIM) |
| S15 | `run2.ts` | 실패 레이어만 재생성 · 산출물 패키지 |

### 핵심 합성 규칙

생성 모델이 원본을 바꾸지 못하게, **보이는 픽셀은 원본에서 가져오고 가려진 부분만 생성**합니다.

```
M_hidden = clamp(M_amodal − dilate(M_visible, seam_margin), 0, 1)
RGB      = I_original × M_visible + G × M_hidden
Alpha    = union(M_visible, M_hidden)
```

### 실측 비교 (3종, 같은 기준 이미지·같은 지표)

| | 레이어 | 패스 | 노드 | KB | 실루엣 IoU | 경계 F | 색차 ΔE2000 |
|---|---:|---:|---:|---:|---:|---:|---:|
| **V2** | 6.0 | 563 | 15,861 | 546 | **0.974** | **0.894** | **7.6** |
| **V1** | 11.7 | 162 | 1,578 | 66 | 0.859 | 0.322 | 19.9 |

원본 충실도는 V2가, 편집 경량성은 V1이 앞섭니다 — 설계 문서가 예고한 트레이드오프 그대로입니다.
**테크팩 용도면 V1, 원본 재현 용도면 V2**를 쓰세요.

### 모델 가용성

`Qwen-Image-Layered-Control`은 공개 inference provider가 없어 **자체 호스팅(80GB GPU)이 전제**입니다.
그래서 생성 워커를 두 백엔드로 만들었습니다.

- `QWEN_LC_URL` 설정 시 → 레이어별 프롬프트 추출 (설계 문서의 1순위 경로)
- 미설정 시 → 같은 계약을 채우는 대체 백엔드 (전체 분해 후 가시 마스크와 매칭)

두 경로 모두 후보마다 model revision·seed·config hash를 남기므로 GPU가 준비되면 env만 바꾸면 됩니다.

---

## 라이선스

MIT. 데모 이미지는 위키미디어 공용(CC BY-SA / CC0)에서 가져왔고 각 샘플에 원본 링크가 있습니다.
