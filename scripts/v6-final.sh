#!/usr/bin/env bash
# V6.0 최종 — 동결된 코드로 전 샘플을 한 판에 다시 굽고, .ai 까지 낸다.
# 캐시한 도면을 쓰므로 도면 생성 재과금은 없다.
set -u
cd "$(dirname "$0")/.."

echo "### 1/4 크롤링 26장 ###"
for f in .cache/sch/*.png; do
  name=$(basename "$f" .png); cat="${name%%_*}"
  out=$(SAM3_SSH_HOST=plushgpu timeout 1800 npx tsx server/run-v4.ts "inputs/test30/${name}.png" "t_${name}" \
        --category "$cat" --schematic-from "$f" 2>&1)
  echo "[t_$name] $(echo "$out" | grep -oE 'FIDELITY_[A-Z]+ / EDITABILITY_[A-Z]+ / SEMANTIC_[A-Z]+' | head -1) $(echo "$out" | grep -oE '검게 채운 면 [0-9]+개' | head -1)"
done

echo "### 2/4 정식 9종 ###"
for n in shoe_1 shoe_2 shoe_3 bag_1 bag_2 bag_3 jewelry_1 jewelry_2 jewelry_3; do
  case "$n" in shoe_*) cat=footwear ;; bag_*) cat=bag ;; *) cat=jewelry ;; esac
  out=$(timeout 1800 npx tsx server/run-v4.ts "outputs/_samples/$n.png" "$n" \
        --category "$cat" --schematic-from ".schematic-cache/$n.png" 2>&1)
  echo "[$n] $(echo "$out" | grep -oE 'FIDELITY_[A-Z]+ / EDITABILITY_[A-Z]+ / SEMANTIC_[A-Z]+' | head -1) $(echo "$out" | grep -oE '검게 채운 면 [0-9]+개' | head -1)"
done

echo "### 2b/4 라인 모드 5종 ###"
for n in shoe_1 bag_1 jewelry_1 jewelry_2 jewelry_3; do
  case "$n" in shoe_*) cat=footwear ;; bag_*) cat=bag ;; *) cat=jewelry ;; esac
  out=$(V4_LINE_WIDTH=2.5 timeout 1800 npx tsx server/run-v4.ts "outputs/_samples/$n.png" "${n}_line"         --category "$cat" --line --schematic-from ".schematic-cache/$n.png" 2>&1)
  echo "[${n}_line] $(echo "$out" | grep -oE 'FIDELITY_[A-Z]+ / EDITABILITY_[A-Z]+ / SEMANTIC_[A-Z]+' | head -1)"
done

echo "### 3/4 .ai 재출고 ###"
ALL=$(ls -d outputs/v4/v4_* | grep -v "outputs/v4/v4__" | sed 's|outputs/v4/v4_||')
npx tsx server/v4/rebuild-exports.ts $ALL 2>&1 | tail -40

echo "### 4/4 배치 리포트 ###"
npx tsx server/v4/batch-report.ts t_ 2>&1 | tail -30
echo "=== V6.0 최종 완료 ==="
