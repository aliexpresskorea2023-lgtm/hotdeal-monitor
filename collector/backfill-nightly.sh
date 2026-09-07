#!/bin/bash
# 핫딜 과거 백필 야간 딥 크롤 — 1년치 데이터가 모일 때까지 매일 밤 실행.
#
# 2026-08-28 시작. 매일 밤 사이트별 상세 예산으로 수집하고, 목록 탐색
# 깊이는 날짜 기반으로 매일 늘어난다(상태 파일 없이 시작일로부터 도출 —
# 중간에 며칠 빠져도 깊이는 자동으로 따라잡힘). 기수집 게시글은 DB 판정으로
# 0요청 스킵되므로 상세 예산은 그대로 더 오래된 글로 흘러간다.
#
# 2026-09-07 계획 변경 — 대상 quasarzone·arca 두 곳만 집중, 증가율 상향.
#   실측 깊이(2026-09-07): quasarzone 54p→126일, arca 82p→30일 도달.
#   1년(365일≈2025-09) 필요 페이지 ≈ quasarzone ~160p, arca ~1000p(게시량 많음).
#   제외(일시): fmkorea(매번 HTTP 430 차단→진행 0), ppomppu·ruliweb(자체 진행
#     양호, 백필 예산 집중 위해 제외). 2시간 주기 정기 파이프라인은 전 커뮤니티
#     최신글을 계속 수집하므로 "최신 데이터"는 모든 곳에서 유지된다.
#   목표 도달: quasarzone ~2026-10 초, arca ~2026-12 초에 1년 깊이.
#
# 예상 소요: 2개 커뮤니티만이라 1년 근접해도 목록 재주행 ~1225p(≈40분)+상세.
# 수집 종료 후 인제스트(로컬 SQLite) 수행 — collect.py 스킵판정이 로컬 SQLite를
# 읽으므로 백필은 반드시 로컬에 적재. D1/prod 반영은 정기 파이프라인이 담당.
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
# 2026-09-07부터 quasarzone·arca만 집중 — 증가율을 상향해 1년 깊이에 더 빨리 도달.
# cap(): 목록 재주행 상한(≈1년 필요 페이지 + 여유) 이후 깊이 고정.
START_EPOCH=$(date -j -f '%Y-%m-%d' '2026-08-28' +%s)
NOW_EPOCH=$(date +%s)
DAYS=$(( (NOW_EPOCH - START_EPOCH) / 86400 ))
[ "$DAYS" -lt 0 ] && DAYS=0
[ "$DAYS" -gt 370 ] && DAYS=370

cap() { local v=$1 c=$2; [ "$v" -gt "$c" ] && echo "$c" || echo "$v"; }

# 제외(일시): fmkorea(차단 진행 0), ppomppu·ruliweb(자체 진행 양호, 예산 집중 위해 제외).
# PAGES_FMKOREA=$(( 75 + DAYS * 5 ))
# PAGES_PPOMPPU=$(( 50 + DAYS * 3 ))
# PAGES_RULIWEB=$(( 34 + DAYS * 2 ))
PAGES_QUASARZONE=$(cap $(( 34 + DAYS * 5 )) 175)
PAGES_ARCA=$(cap $(( 52 + DAYS * 10 )) 1050)

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

# 상세 예산은 고정 상한 — 첫날 이후에는 미수집분만 소모한다.
# 제외(일시): fmkorea·ppomppu·ruliweb은 야간 백필 대상에서 제외(정기 파이프라인이 최신글 유지).
# "$PY" collector/collect.py --communities fmkorea --pages "$PAGES_FMKOREA" --max-details 3500
# echo "[$(ts)] fmkorea 완료 (pages=$PAGES_FMKOREA, exit $?)"

# "$PY" collector/collect.py --communities ppomppu --pages "$PAGES_PPOMPPU" --max-details 900
# echo "[$(ts)] ppomppu 완료 (pages=$PAGES_PPOMPPU, exit $?)"

# "$PY" collector/collect.py --communities ruliweb --pages "$PAGES_RULIWEB" --max-details 1500
# echo "[$(ts)] ruliweb 완료 (pages=$PAGES_RULIWEB, exit $?)"

"$PY" collector/collect.py --communities quasarzone --pages "$PAGES_QUASARZONE" --max-details 1400
rc=$?
echo "[$(ts)] quasarzone 완료 (pages=$PAGES_QUASARZONE, exit $rc)"

# arca: 증가율 상향에 따른 하룻밤 캐치업 점프를 흡수하려 상세 예산을 2400→3500으로 상향.
"$PY" collector/collect.py --communities arca --pages "$PAGES_ARCA" --max-details 3500
rc=$?
echo "[$(ts)] arca 완료 (pages=$PAGES_ARCA, exit $rc)"

echo "[$(ts)] 수집 종료 — 인제스트 실행"
if npx tsx scripts/ingest-crawls.ts; then
  echo "[$(ts)] 인제스트 완료"
else
  echo "[$(ts)] 인제스트 실패 (exit $?) — 익일 파이프라인이 재시도"
fi
echo "[$(ts)] 야간 백필 종료. 배포는 익일 08시 정기 파이프라인이 수행."
