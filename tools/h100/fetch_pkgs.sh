#!/usr/bin/env bash
# S3 패키지 → H100. 자격증명은 이 PC 에만 있고 H100 에는 서명 URL(1시간)만 간다.
# 사용: bash fetch_pkgs.sh vringon-shoes-260601 vringon-jewelry vringon-bag-260415
set -euo pipefail
BUCKET=vringon-ai-models
PREFIX=part_segmentation/sam3_1-worker-v1-20260820
DEST='~/.cache/vringon-ai-workers/models/part_segmentation/sam3_1-worker-v1-20260820'
for pkg in "$@"; do
  echo "== $pkg =="
  files=$(aws s3 ls "s3://$BUCKET/$PREFIX/$pkg/" | awk '{print $4}')
  ssh -o BatchMode=yes plushgpu "mkdir -p $DEST/$pkg"
  for f in $files; do
    url=$(aws s3 presign "s3://$BUCKET/$PREFIX/$pkg/$f" --expires-in 3600)
    # URL 은 서명이 들어 있으니 출력하지 않는다 — 파일명·크기만
    ssh -o BatchMode=yes plushgpu "cd $DEST/$pkg && if [ -s '$f' ]; then echo '  have $f'; else curl -sS -f -o '$f.part' '$url' && mv '$f.part' '$f' && echo \"  got $f \$(stat -c %s '$f') bytes\"; fi"
  done
done
ssh -o BatchMode=yes plushgpu "du -sh $DEST/*"
