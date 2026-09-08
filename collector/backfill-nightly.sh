#!/bin/bash
# 핫딜 과거 백필 야간 딥 크롤 — 1년치 데이터가 모일 때까지 매일 밤 실행.
#
# 2026-08-28 시작. 매일 밤 사이트별 상세 예산으로 수집하고, 목록 탐색
# 깊이는 날짜 기반으로 매일 늘어난다(상태 파일 없이 시작일로부터 도출 —
# 중간에 며칠 빠져도 깊이는 자동으로 따라잡힘). 기수집 게시글은 DB 판정으로
# 0요청 스킵되므로 상세 예산은 그대로 더 오래된 글로 흘러간다.
#
# 2026-09-07 계획 변경 — 대상 quasarzone·arca 두 곳만 집중.
#   실측 깊이(2026-09-07): quasarzone 54p→126일, arca 82p→30일 도달.
#   1년(365일≈2025-09) 필요 페이지 ≈ quasarzone ~160p, arca ~1000p(게시량 많음).
#   제외(일시): fmkorea(매번 HTTP 430 차단→진행 0), ppomppu·ruliweb(자체 진행
#     양호, 백필 예산 집중 위해 제외). 2시간 주기 정기 파이프라인은 전 커뮤니티
#     최신글을 계속 수집하므로 "최신 데이터"는 모든 곳에서 유지된다.
#
# 2026-09-08 시정 — (a) 스케줄러 단일화, (b) 상세 예산 재조정.
#   (a) 이 백필은 launchd(com.beomjun.hotdeal-monitor.backfill.plist, 매일 23:00)
#       '하나만'으로 실행한다. 과거 QoderWork 크론(22:35)과 이중 예약되어 밤새
#       2개가 동시 실행 → 12시간+ 런어웨이·arca 이중 크롤 부하가 발생했고, 크론은 제거했다.
#   (b) 밤새 실측: 병목은 페이지 수가 아니라 quasarzone '상세' 지연(건당 ~16초,
#       84p·1400건이 6h10m 소모). arca는 건당 ~2.5초로 건강. 그래서 상세 예산을
#       quasarzone 1400→500, arca 3500→2400으로 내려 단일 실행이 밤(≈9h) 안에 끝나게 했다.
#   예상 1년 깊이 도달: quasarzone ~2026-10 중순, arca ~2027-01 (완만한 증가율로 조정).
#
# 예상 소요: quasarzone ≈2h + arca ≈1h40m + 목록 재주행 ≈ 합계 4~5h(단일 실행 기준).
# 수집 종료 후 인제스트(로컬 SQLite) 수행 — collect.py 스킵판정이 로컬 SQLite를
# 읽으므로 백필은 반드시 로컬에 적재. D1/prod 반영은 정기 파이프라인이 담당.
#
# 실행 주체: launchd가 아래 plist로 띄운다(수동 실행 시 동일 명령):
#   cd /Users/beomjun/dev/hotdeal-monitor
#   caffeinate -i bash collector/backfill-nightly.sh
#   (launchd 로그: data/logs/backfill-launchd-stdout.log / -stderr.log)

set -u
cd "$(dirname "$0")/.."
export PATH="/Users/beomjun/.nvm/versions/node/v22.22.2/bin:$PATH"
PY="$PWD/collector/.venv/bin/python"

ts() { date '+%F %T'; }

# ---- 깊이 계산: base + 경과일 × 일일 증가율 -------------------------
# 증가율 ≈ 실측 일게시량 ÷ 목록 페이지당 게시수 + 여유.
# quasarzone·arca만 집중. cap(): 목록 재주행 상한(≈1년 필요 페이지 + 여유) 이후 깊이 고정.
# 2026-09-08 조정: 밤새 실측 결과 병목은 페이지 수가 아니라 quasarzone '상세' 지연
#   (건당 ~16초, arca는 ~2.5초). 그래서 페이지 증가율은 완만하게(×5→×4, ×10→×6),
#   cap도 낮춰(175→165, 1050→700) '한 밤(≈9h) 안에 단일 실행이 끝나도록' 맞췄다.
#   실제 소요는 아래 상세 예산(--max-details)이 지배한다.
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
PAGES_QUASARZONE=$(cap $(( 34 + DAYS * 4 )) 165)
PAGES_ARCA=$(cap $(( 52 + DAYS * 6 )) 700)

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

# 상세 예산(--max-details)이 밤 소요를 지배한다. 기수집분은 0요청 스킵되므로
# 예산은 그대로 더 오래된 미수집 글로 흘러가 깊이가 꾸준히 늘어난다.
# 제외(일시): fmkorea·ppomppu·ruliweb은 야간 백필 대상에서 제외(정기 파이프라인이 최신글 유지).
# "$PY" collector/collect.py --communities fmkorea --pages "$PAGES_FMKOREA" --max-details 3500
# echo "[$(ts)] fmkorea 완료 (pages=$PAGES_FMKOREA, exit $?)"

# "$PY" collector/collect.py --communities ppomppu --pages "$PAGES_PPOMPPU" --max-details 900
# echo "[$(ts)] ppomppu 완료 (pages=$PAGES_PPOMPPU, exit $?)"

# "$PY" collector/collect.py --communities ruliweb --pages "$PAGES_RULIWEB" --max-details 1500
# echo "[$(ts)] ruliweb 완료 (pages=$PAGES_RULIWEB, exit $?)"

# quasarzone: 상세 건당 ~16초(서버 지연)라 500건 ≈ 2시간. 이전 1400건은 6시간을 잡아먹었다.
"$PY" collector/collect.py --communities quasarzone --pages "$PAGES_QUASARZONE" --max-details 500
rc=$?
echo "[$(ts)] quasarzone 완료 (pages=$PAGES_QUASARZONE, exit $rc)"

# arca: 상세 건당 ~2.5초(건강)라 2400건 ≈ 1시간 40분. 게시량 많아 상세 예산을 크게 둬도 밤 안에 끝난다.
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
