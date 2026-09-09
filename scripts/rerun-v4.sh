#!/usr/bin/env bash
# 저장해 둔 도면(.schematic-cache)으로 V4 를 다시 굽는다 — 도면 생성 재과금 없음.
set -u
cd "$(dirname "$0")/.."
for n in "$@"; do
  case "$n" in
    shoe_*) cat=footwear ;;
    bag_*) cat=bag ;;
    jewelry_*) cat=jewelry ;;
    *) cat=generic ;;
  esac
  echo "=== $n ($cat) ==="
  npx tsx server/run-v4.ts "outputs/_samples/$n.png" "$n" \
    --category "$cat" --schematic-from ".schematic-cache/$n.png" 2>&1 \
    | grep -E "상태|FIDELITY|합계|오류|Error" | head -4
done
echo "=== 배치 완료 ==="
