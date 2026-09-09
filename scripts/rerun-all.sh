#!/usr/bin/env bash
# 캐시한 도면으로 전 샘플 재생성 — 도면 재과금 없음.
set -u
cd "$(dirname "$0")/.."
for f in .cache/sch/*.png; do
  name=$(basename "$f" .png)
  cat="${name%%_*}"
  src="inputs/test30/${name}.png"
  [ -f "$src" ] || src="inputs/${name}.png"
  [ -f "$src" ] || { echo "[$name] 원본 사진 없음 — 건너뜀"; continue; }
  out=$(SAM3_SSH_HOST=plushgpu timeout 1800 npx tsx server/run-v4.ts "$src" "t_${name}" \
        --category "$cat" --schematic-from "$f" 2>&1)
  st=$(echo "$out" | grep -oE "FIDELITY_[A-Z]+ / EDITABILITY_[A-Z]+ / SEMANTIC_[A-Z]+" | head -1)
  solid=$(echo "$out" | grep -oE "검게 채운 면 [0-9]+개" | head -1)
  echo "[$name] ${st:-실패} ${solid}"
done
echo "=== 전체 재생성 완료 ==="
