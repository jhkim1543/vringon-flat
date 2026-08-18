#!/usr/bin/env bash
# 샘플 배치 실행 — 카테고리별로 순차 제출하고 완료를 기다린다.
# 결과 잡 id는 outputs/_samples/JOBS.txt 에 기록한다.
set -u
cd "$(dirname "$0")/.."
API=http://localhost:5201
OUT=outputs/_samples
until curl -s "$API/api/health" >/dev/null 2>&1; do sleep 1; done

submit() {
  curl -s -X POST "$API/api/jobs" -F "image=@$1" -F "style=color" \
    -F "layerDetail=standard" -F "categoryHint=$2" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.id||('ERR:'+j.error))})"
}
waitfor() {
  for id in "$@"; do
    [ "${id:0:4}" = "ERR:" ] && continue
    while :; do
      s=$(curl -s "$API/api/jobs/$id" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
      [ "$s" != "running" ] && break
      sleep 8
    done
  done
}

: > "$OUT/JOBS.txt"
for grp in shoe:footwear bag:bag jewelry:jewelry; do
  key="${grp%%:*}"; cat="${grp##*:}"
  ids=()
  for n in 1 2 3; do
    f="$OUT/${key}_${n}.png"
    [ -f "$f" ] || continue
    id=$(submit "$f" "$cat")
    echo "${key}_${n} $id" | tee -a "$OUT/JOBS.txt"
    ids+=("$id")
  done
  waitfor "${ids[@]}"
done
echo "=== 배치 완료 ==="
