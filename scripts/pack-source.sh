#!/usr/bin/env bash
# 소스 묶음 — **git 추적 여부와 무관하게** 소스 트리를 통째로 담는다.
#
# 이름을 손으로 나열했다가 continuity.ts · lineMerge.ts · letterDetect.ts · segSam3.ts ·
# residualAssign.ts 등 25개가 통째로 빠졌다(외부 검토에서 지적). 최신 실행 경로가
# import 하는 파일이 빠지면 **받는 쪽이 빌드조차 못 한다.**
#
# 그래서 규칙을 뒤집었다: 소스 디렉터리를 전부 담고, **빼야 할 것만 이름으로 뺀다.**
set -eu
cd "$(dirname "$0")/.."

OUT="${1:-outputs/_deliver/1_소스코드.zip}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# 담는다 — 디렉터리 통째로
for d in server scripts web tools; do
  [ -d "$d" ] || continue
  mkdir -p "$STAGE/$d"
  # node_modules·빌드 산출물만 뺀다
  tar -cf - --exclude=node_modules --exclude=dist --exclude=.cache "$d" | tar -xf - -C "$STAGE"
done
# 루트 설정 파일
for f in package.json package-lock.json tsconfig.json vite.config.ts Dockerfile .dockerignore \
         .gitignore .gitattributes LICENSE README.md .env.example; do
  [ -f "$f" ] && cp "$f" "$STAGE/"
done
mkdir -p "$STAGE/docs/plans"
[ -f docs/V6.md ] && cp docs/V6.md "$STAGE/docs/"
[ -f docs/openapi.yaml ] && cp docs/openapi.yaml "$STAGE/docs/"
[ -f docs/plans/V50_METHOD.md ] && cp docs/plans/V50_METHOD.md "$STAGE/docs/plans/"
# 인수인계 — zip 을 처음 여는 사람이 읽을 것 (데모 상태 + 개발 방법론)
[ -f HANDOFF.md ] && cp HANDOFF.md "$STAGE/"

# **빼야 할 것** — 키가 든 파일과 대용량 산출물
rm -f "$STAGE/.env" "$STAGE/server/.env" 2>/dev/null || true
find "$STAGE" -name "*.key" -o -name "partseg.key" | xargs -r rm -f
find "$STAGE" -name "*.ai" -delete 2>/dev/null || true
find "$STAGE" -name "*.png" -size +200k -delete 2>/dev/null || true

# **키 유출 검사 — 하나라도 걸리면 묶지 않는다**
LEAK=$(grep -rIlE 'sk-[A-Za-z0-9]{20}|AIza[A-Za-z0-9_-]{30}|r8_[A-Za-z0-9]{20}|hf_[A-Za-z0-9]{30}' "$STAGE" 2>/dev/null || true)
if [ -n "$LEAK" ]; then
  echo "키로 보이는 문자열이 있다 — 묶지 않는다:"
  echo "$LEAK"
  exit 1
fi

# import 하는 모듈이 다 들어갔는지 확인 — 빌드 가능성의 최소 보증
MISSING=0
while IFS= read -r m; do
  [ -f "$STAGE/server/v4/$m.ts" ] || { echo "  ! server/v4/$m.ts 누락"; MISSING=1; }
done < <(grep -rhoE 'from "\./([a-zA-Z0-9_]+)\.js"' server/v4/*.ts | sed -E 's|from "\./||; s|\.js"||' | sort -u)
[ "$MISSING" -eq 0 ] || { echo "누락 모듈이 있다 — 묶지 않는다"; exit 1; }

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
# **경로 구분자는 슬래시여야 한다.** PowerShell 의 Compress-Archive 는 백슬래시로 넣어서
# 다른 OS 에서 풀면 폴더가 안 생기고 이름에 백슬래시가 박힌 파일이 된다(실측: 175개 전부).
# python zipfile 은 규격대로 슬래시를 쓰고 결과도 결정적이다.
python - "$STAGE" "$OUT" <<'PYZIP'
import os, sys, zipfile
stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(stage):
        dirs.sort(); files.sort()
        for f in files:
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, stage).replace(os.sep, "/"))
PYZIP

echo "$OUT"
echo "  파일 $(find "$STAGE" -type f | wc -l)개 · server/*.ts $(find "$STAGE/server" -name '*.ts' | wc -l)개 · 키 유출 없음"
