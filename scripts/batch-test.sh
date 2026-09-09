#!/usr/bin/env bash
# 크롤링 테스트셋 배치 실행 — 도면 생성부터 전 과정.
# 이미 결과가 있으면 건너뛴다(중단 후 재개 가능).
set -u
cd "$(dirname "$0")/.."
SET="${1:-inputs/test30}"
MODE="${2:-face}"   # face | line
SUFFIX=""
EXTRA=""
if [ "$MODE" = "line" ]; then SUFFIX="_line"; EXTRA="--line"; fi

for f in "$SET"/*.png; do
  base=$(basename "$f" .png)
  cat="${base%%_*}"
  name="t_${base}${SUFFIX}"
  if [ -f "outputs/v4/v4_${name}/qa_v4.json" ]; then
    echo "[$name] 건너뜀 (이미 있음)"
    continue
  fi
  echo "=== $name ($cat) ==="
  SAM3_SSH_HOST=plushgpu V4_LINE_WIDTH=2.5 \
    timeout 1500 npx tsx server/run-v4.ts "$f" "$name" --category "$cat" $EXTRA 2>&1 \
    | grep -E "상태|FIDELITY|오류|Error" | head -3
done
echo "=== 배치 완료 ($MODE) ==="
