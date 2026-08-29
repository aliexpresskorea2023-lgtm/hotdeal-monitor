#!/bin/bash
# 핫딜 과거 백필 야간 딥 크롤 — 1년치 데이터가 모일 때까지 매일 밤 실행.
#
# 2026-08-28 시작. 매일 밤 사이트별 상세 예산(~2주치)으로 수집하고,
# 목록 탐색 깊이는 날짜 기반으로 매일 ~1일치씩 늘어난다(상태 파일 없이
# 시작일로부터 도출 — 중간에 며칠 빠져도 깊이는 자동으로 따라잡힘).
# 기수집 게시글은 DB 판정으로 0요청 스킵되므로 상세 예산은 그대로
# 더 오래된 글로 흘러간다. 목표: 2027-08 말까지 1년 깊이 도달.
#
# 예상 소요: 초기 ~3.5시간 → 1년 깊이 근접 시 ~7.5시간(목록 재주행 증가).
# 수집 종료 후 인제스트 수행, 배포는 익일 08시 정기 파이프라인이 담당.
#
# 실행(예약 작업이 이렇게 띄움):
#   cd /Users/beomjun/dev/hotdeal-monitor
#   nohup caffeinate -i bash collector/backfill-nightly.sh >> data/logs/backfill.log 2>&1 &

set -u
cd "$(dirname "$0")/.."
export PATH="/Users/beomjun/.nvm/versions/node/v22.22.2/bin:$PATH"
PY="$PWD/collector/.venv/bin/python"

ts() { date '+%F %T'; }

# ---- 깊이 계산: base + 경과일 × 일일 증가율 -------------------------
# 증가율 ≈ 실측 일게시량 ÷ 목록 페이지당 게시수 + 여유.
# 상한(370일) 이후에는 깊이 고정 — 1년치 도달 신호이자 목록 재주행 제한.
START_EPOCH=$(date -j -f '%Y-%m-%d' '2026-08-28' +%s)
NOW_EPOCH=$(date +%s)
DAYS=$(( (NOW_EPOCH - START_EPOCH) / 86400 ))
[ "$DAYS" -lt 0 ] && DAYS=0
[ "$DAYS" -gt 370 ] && DAYS=370

PAGES_FMKOREA=$(( 75 + DAYS * 5 ))
PAGES_PPOMPPU=$(( 50 + DAYS * 3 ))
PAGES_RULIWEB=$(( 34 + DAYS * 2 ))
PAGES_QUASARZONE=$(( 34 + DAYS * 2 ))
PAGES_ARCA=$(( 52 + DAYS * 3 ))

echo "[$(ts)] 야간 백필 시작 (경과 ${DAYS}일차) — 22시 정기 파이프라인 종료 대기"
WAITED=0
while [ -d data/.pipeline.lock ]; do
  if [ "$WAITED" -ge 5400 ]; then
    echo "[$(ts)] 90분 대기에도 잠금 미해제 — 중단"
    exit 75
  fi
  sleep 60
  WAITED=$((WAITED + 60))
done
echo "[$(ts)] 잠금 해제 확인. 사이트별 딥 크롤 시작"

# 상세 예산은 고정 상한 — 첫날 이후에는 미수집분(하루 ~560건)만 소모한다.
"$PY" collector/collect.py --communities fmkorea --pages "$PAGES_FMKOREA" --max-details 3500
rc=$?
echo "[$(ts)] fmkorea 완료 (pages=$PAGES_FMKOREA, exit $rc)"

"$PY" collector/collect.py --communities ppomppu --pages "$PAGES_PPOMPPU" --max-details 900
rc=$?
echo "[$(ts)] ppomppu 완료 (pages=$PAGES_PPOMPPU, exit $rc)"

"$PY" collector/collect.py --communities ruliweb --pages "$PAGES_RULIWEB" --max-details 1500
rc=$?
echo "[$(ts)] ruliweb 완료 (pages=$PAGES_RULIWEB, exit $rc)"

"$PY" collector/collect.py --communities quasarzone --pages "$PAGES_QUASARZONE" --max-details 1400
rc=$?
echo "[$(ts)] quasarzone 완료 (pages=$PAGES_QUASARZONE, exit $rc)"

"$PY" collector/collect.py --communities arca --pages "$PAGES_ARCA" --max-details 2400
rc=$?
echo "[$(ts)] arca 완료 (pages=$PAGES_ARCA, exit $rc)"

echo "[$(ts)] 수집 종료 — 인제스트 실행"
if npx tsx scripts/ingest-crawls.ts; then
  echo "[$(ts)] 인제스트 완료"
else
  echo "[$(ts)] 인제스트 실패 (exit $?) — 익일 파이프라인이 재시도"
fi
echo "[$(ts)] 야간 백필 종료. 배포는 익일 08시 정기 파이프라인이 수행."
