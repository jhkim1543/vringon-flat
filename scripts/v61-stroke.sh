#!/usr/bin/env bash
# V6.1 — 선을 라이브 스트로크로, 굵기 4등급. 면은 그대로 채울 수 있게 둔다.
set -u
cd "$(dirname "$0")/.."
echo "### 크롤링 26장 (stroke) ###"
for f in .cache/sch/*.png; do
  name=$(basename "$f" .png); cat="${name%%_*}"
  out=$(SAM3_SSH_HOST=plushgpu timeout --kill-after=30s --foreground 2400 npx tsx server/run-v4.ts "inputs/test30/${name}.png" "s_${name}" \
        --category "$cat" --stroke --schematic-from "$f" 2>&1)
  echo "[s_$name] $(echo "$out" | grep -oE 'FIDELITY_[A-Z]+ / EDITABILITY_[A-Z]+ / SEMANTIC_[A-Z]+' | head -1) $(echo "$out" | grep -oE '선 굵기 [0-9]등급' | head -1)"
done
echo "### 정식 9종 (stroke) ###"
for n in shoe_1 shoe_2 shoe_3 bag_1 bag_2 bag_3 jewelry_1 jewelry_2 jewelry_3; do
  case "$n" in shoe_*) cat=footwear ;; bag_*) cat=bag ;; *) cat=jewelry ;; esac
  out=$(timeout --kill-after=30s --foreground 2400 npx tsx server/run-v4.ts "outputs/_samples/$n.png" "s_$n" \
        --category "$cat" --stroke --schematic-from ".schematic-cache/$n.png" 2>&1)
  echo "[s_$n] $(echo "$out" | grep -oE 'FIDELITY_[A-Z]+ / EDITABILITY_[A-Z]+ / SEMANTIC_[A-Z]+' | head -1)"
done
echo "### .ai 출고 ###"
ALL=$(ls -d outputs/v4/v4_s_* 2>/dev/null | sed 's|outputs/v4/v4_||')
npx tsx server/v4/rebuild-exports.ts $ALL 2>&1 | tail -8
echo "### 리포트 ###"
npx tsx server/v4/batch-report.ts s_ 2>&1 | tail -20
echo "=== V6.1 stroke 완료 ==="
