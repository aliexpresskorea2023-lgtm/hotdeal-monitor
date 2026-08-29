#!/bin/bash
# 오늘(2026-08-28) 밤 1회용: 본 실행 종료 후 fmkorea 재시도.
#
# 경위: 22:35·23:28 두 차례 모두 fmkorea가 시작 즉시 WAF(HTTP 430)로
# 차단. 본 실행(backfill-nightly.sh, pid 56281)이 나머지 4개 사이트를
# 마치고 자체 인제스트까지 끝낸 뒤(메인 프로세스 종료 = 인제스트 완료),
# 30분 안정 대기를 두고 fmkorea를 예산만큼 재시도한다.
# 여전히 430이면 그대로 포기 — 다음 밤 정기 실행이 이어받는다.
# 05:30 이후에는 시작하지 않는다(08시 정기 파이프라인과 충돌 방지).

set -u
cd "$(dirname "$0")/.."
export PATH="/Users/beomjun/.nvm/versions/node/v22.22.2/bin:$PATH"
PY="$PWD/collector/.venv/bin/python"

ts() { date '+%F %T'; }
TARGET_PID=56281  # backfill-nightly.sh 메인 프로세스

echo "[$(ts)] fmkorea 재시도 대기 — 본 실행(pid $TARGET_PID) 종료 대기"
WAITED=0
while kill -0 "$TARGET_PID" 2>/dev/null; do
  if [ "$WAITED" -ge 28800 ]; then
    echo "[$(ts)] 8시간 초과 대기 — 중단"
    exit 75
  fi
  sleep 60
  WAITED=$((WAITED + 60))
done
echo "[$(ts)] 본 실행 종료 확인. 30분 안정 대기"
sleep 1800

HOUR=$(date +%H)
if [ "$HOUR" -ge 5 ] || [ "$HOUR" -lt 1 ]; then
  echo "[$(ts)] 시각이 05시 이후(또는 자정 이전) — 08시 파이프라인 충돌 방지, 재시도 생략"
  exit 0
fi

echo "[$(ts)] fmkorea 딥 크롤 재시도 시작"
"$PY" collector/collect.py --communities fmkorea --pages 75 --max-details 3500
rc=$?
echo "[$(ts)] fmkorea 완료 (exit $rc)"

if npx tsx scripts/ingest-crawls.ts; then
  echo "[$(ts)] 인제스트 완료"
else
  echo "[$(ts)] 인제스트 실패 (exit $?) — 익일 파이프라인이 재시도"
fi
echo "[$(ts)] fmkorea 재시도 종료. 배포는 익일 08시 정기 파이프라인이 수행."
