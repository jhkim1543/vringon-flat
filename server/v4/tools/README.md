# 측정·감사 도구

파이프라인 결과를 **산출물에서 직접** 재는 도구들이다. 문서의 "고쳤다"를 믿지 않고
숫자로 확인할 때 쓴다. 전부 `npx tsx server/v4/tools/<이름>.ts <잡이름...>` 꼴.

| 도구 | 무엇을 재나 |
| --- | --- |
| `audit.ts` | **종합 감사** — 지적됐던 결함 9종을 항목별 측정 방법과 함께 판정 |
| `anchorhist.ts` | 정식 9종의 `.ai` 실앵커 (역대 판과 같은 대상·저장/펼침 두 기준) |
| `joinable.ts` | 이어 붙일 수 있는데 안 붙은 획 끝점 쌍 |
| `doubleline.ts` | 이중선(선을 윤곽으로 뜬 것 — 자동 트레이스의 지문) |
| `defect.ts` | 겹친 앵커 · 1pt 미만 뭉침 · 0길이 조각 |
| `overlap.ts` | 겹침 앵커의 정체 (같은 패스 안인가, 프리미티브끼리인가) |
| `aidiff.ts` | 두 `.ai` 를 poppler 로 굽고 IoU·앵커·크기 비교 (표현 변경 안전 검증) |
| `aidiffimg.ts` | 위의 시각판 — 빨강=A만 · 파랑=B만 |
| `cmp.ts` | 도면 \| 벡터 \| 겹침 3면 대조 이미지 |
| `paint.ts` | 사람이 보는 그대로(paint)의 도면 \| 벡터 대조 |
| `sheet.ts` | 여러 샘플의 (도면 \| 벡터) 격자 시트 |
| `zoomcmp.ts` | 같은 창을 확대해 도면 \| 벡터 나란히 |
| `layers.ts` | `.ai` 레이어 구조 (이름·하위·패스 수) |
| `preset.ts` | 레이어 프리셋 3종(기능/부품/색)의 구조 비교 |
| `deliver.ts` | 전달용 4장 세트(원본·도면·벡터·앵커) 일괄 생성 |
| `silcmp.ts` | 도면 \| 실루엣 대조 |

상위 진단·리포트는 `server/v4/` 본체에 있다: `batch-report.ts` · `requa.ts` ·
`verify-ai.ts` · `anchor-audit.ts` · `ai-anchor-render.ts` · `v6-compare.ts` ·
`package-ai.ts`.
