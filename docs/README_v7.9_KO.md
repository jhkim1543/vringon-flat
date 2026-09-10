# VRINGON Flat v7.9

첨부 v7.7 소스의 실제 수정본입니다. 작은 접합 고리 복원, 잔가시 정리 순서, 글자·외곽선 간격, 접점 보존과 재현성 검증을 추가했습니다. 실서비스에는 배포하지 않았습니다.

- 먼저 `docs/v7.9-analysis.ko.md`에서 결과와 남은 검토 후보를 확인하세요.
- 비교: `comparison.png`.
- 새 결과: `results/v7.9/`의 각 폴더에 SVG·AI·PNG·보고서가 있습니다.
- 원본 대비 변경: `source-changes.patch`. v7.7 원본은 `baseline/v7.7-source.zip`입니다.
- 코드 설치·검증: `npm ci`, `npm run typecheck`, `npm run test:clean`, `npm run build`.
- 고정 샘플 재처리: `npm run validate:clean`.
- 기존 JSON 재처리: `node --import tsx server/v4/tools/reprocess-clean.ts input.json output-dir`.

57개 테스트와 기존 connector 10개가 통과했습니다. 실제 크롭 주얼리 앵커 20→12, 신발 93→45. 전체 샘플 4개에서 새 긴 선 자유 끝점은 0개였고, 일부 복잡한 연결은 검토 대상으로 남아 있습니다. 사진 생성·세그멘테이션 전체 실험이나 모든 제품의 무결점 보장을 의미하지 않습니다.
