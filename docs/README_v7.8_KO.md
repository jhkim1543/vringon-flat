# v7.8 수정본

실제 서버 선 추적·접합점 보존·잔가지 제거·곡선 피팅·얇은 마감을 수정했습니다.

- 상세 원인, 검증 범위, 남은 문제: [분석 보고서](docs/v7.8-analysis.ko.md)
- 확대본 비교: [comparison.png](comparison.png)
- 수정 코드: `server/`, `source-changes.patch`
- 실제 결과: `results/crops/`, `results/v7.8/`
- 원본 v7.7: `baseline/v7.7-source.zip`

```bash
npm ci
npm run typecheck
npm run test:clean
npm run validate:clean
```

주얼리의 합쳐진 글자/테두리는 자동 분리가 보류된 부분이 남습니다. 기존 데모의 저장된 결과는 코드 교체만으로 갱신되지 않습니다. 운영 배포는 수행하지 않았습니다.
