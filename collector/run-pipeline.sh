#!/bin/bash
# hotdeal-monitor 주기 수집 파이프라인:
#   collect (Python) → trends (Python) → ingest (TS) → thumbnails (og:image)
#   → deploy (git promote)
#
# 동작 원칙:
# - collect가 일부 커뮤니티 차단으로 exit 1을 내도 부분 수집분은 가치가
#   있으므로 ingest는 반드시 실행한다. collect가 완전히 깨져도(exit 2+)
#   이전 run의 미적재 스냅샷을 ingest가 따라잡을 수 있으므로 계속 진행한다.
# - 배포는 ingest가 성공한 경우에만 실행한다. 먼저 DB를 롤백 저널
#   모드로 고정하고(서버리스 읽기 전용 파일시스템에서 열리도록),
#   스냅샷을 커밋·푸시한 뒤 해당 커밋으로 빌드된 git 배포를
#   프로덕션으로 promote한다(수집 주기 = 배포 주기).
#   `vercel deploy` CLI 업로드 방식은 로컬 next dev/start가 freeze 직후
#   헤더를 WAL로 되돌리는 레이스에서 지면 WAL 파일이 그대로 배포돼
#   프로덕션 CANTOPEN이 나므로(2026-08-28 실측) 기본 경로로 쓰지 않는다.
#   git 통합이 없거나 git 배포 빌드가 실패하면 CLI 업로드로 폴백한다.
# - 스크립트 위치 기준으로 프로젝트 루트를 해석해서 어디서 실행해도 안전하다
#   (launchd는 CWD=/ 로 실행함).
# - mkdir 기반 잠금으로 중복 실행을 막는다. 이전 실행이 아직 살아 있으면
#   새 실행은 즉시 종료(exit 75, EX_TEMPFAIL).
#
# 사용법:
#   collector/run-pipeline.sh [collect.py 옵션 그대로 전달]
#   예) collector/run-pipeline.sh --pages 1 --max-details 40
#   collector/run-pipeline.sh deploy-only
#     — 수집 없이 4단계(동결→커밋·푸시→git 배포 promote)만 실행.
#       어드민 수정분을 주기 배포 전에 즉시 반영할 때 쓴다.
#
# 로그: data/logs/pipeline.log (append), 실행별 타임스탬프 헤더 포함.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

PYTHON="$ROOT/collector/.venv/bin/python"
LOG_DIR="$ROOT/data/logs"
LOG_FILE="$LOG_DIR/pipeline.log"
LOCK_DIR="$ROOT/data/.pipeline.lock"

# 키워드 트렌드 수집 요일 — 주 1회 수집 (2026-09-01 결정).
# 요일은 미정(수요일 유력)이라 확정은 사용자 지시 대기. 1=월 ... 7=일.
# 수동 수집은 이 값과 무관하게 trends.py 직접 실행으로 언제든 가능.
TRENDS_WEEKDAY=3

# .env.local에서 네이버 API 키 읽기 (파이프라인 조건부 실행용).
# 전체 source는 위험(다른 변수 오염)이라 필요한 키만 추출.
_env_val() {
  local key="$1"
  local val
  val="$(grep "^${key}=" "$ROOT/.env.local" 2>/dev/null | head -1 | cut -d= -f2-)"
  # 따옴표 제거
  val="${val#\"}" ; val="${val%\"}"
  val="${val#\'}" ; val="${val%\'}"
  echo "$val"
}
NAVER_CLIENT_ID="$(_env_val NAVER_CLIENT_ID)"
NAVER_CLIENT_SECRET="$(_env_val NAVER_CLIENT_SECRET)"
export NAVER_CLIENT_ID NAVER_CLIENT_SECRET

# D1 백엔드 전환 (2026-09-03 컷오버). 모든 ingest/후처리 스크립트가
# 로컬 SQLite 대신 Cloudflare D1에 직접 기록한다.
CF_ACCOUNT_ID="$(_env_val CF_ACCOUNT_ID)"
CF_API_TOKEN="$(_env_val CF_API_TOKEN)"
CF_D1_DATABASE_ID="$(_env_val CF_D1_DATABASE_ID)"
export CF_ACCOUNT_ID CF_API_TOKEN CF_D1_DATABASE_ID
export DB_BACKEND=d1

mkdir -p "$LOG_DIR"

# ---- 잠금 -----------------------------------------------
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(date '+%F %T') 다른 pipeline 실행이 아직 진행 중 — 종료합니다." >&2
  exit 75
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

ts() { date '+%F %T'; }
log() { echo "$(ts) $*" | tee -a "$LOG_FILE"; }

log "===== pipeline 시작 (pid $$) ====="
log "인자: $*"

MODE="full"
if [[ "${1:-}" == "deploy-only" ]]; then
  MODE="deploy-only"
  shift
  log "모드: deploy-only — 수집 생략, 배포 단계만 실행"
fi

# ---- 전제 조건 확인 --------------------------------------
if [[ "$MODE" == "full" && ! -x "$PYTHON" ]]; then
  log "오류: venv python이 없습니다 ($PYTHON). 'python3 -m venv collector/.venv && collector/.venv/bin/pip install -r collector/requirements.txt' 필요."
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  log "오류: npx를 찾을 수 없습니다 (Node.js 필요)."
  exit 1
fi

# ---- 1단계: collect -------------------------------------
# 하루 첫(08시)·마지막(22시) 크롤링에서는 종료된 딜 전체를 재검증하는
# 스윕(--sweep-ended)을 함께 돌린다 — 재개장된 딜을 되살리기 위함.
# (launchd 스케줄: 08~22시 2시간 주기)
if [[ "$MODE" == "full" ]]; then
SWEEP=""
HOUR="$(date +%H)"
if [[ "$HOUR" == "08" || "$HOUR" == "22" ]]; then
  SWEEP="--sweep-ended"
fi
log "[1/4] collect.py 실행${SWEEP:+ (종료 스윕 포함)}"
"$PYTHON" "$ROOT/collector/collect.py" $SWEEP "$@" >>"$LOG_FILE" 2>&1
collect_rc=$?
case "$collect_rc" in
  0) log "[1/4] collect 정상 종료 (exit 0)" ;;
  1) log "[1/4] collect 종료 — 일부 커뮤니티 차단 감지 (exit 1). 부분 수집분은 ingest로 진행" ;;
  *) log "[1/4] collect 비정상 종료 (exit $collect_rc). 그래도 ingest는 실행" ;;
esac

# ---- 2단계: 키워드 트렌드 수집 (주 1회, 베스트 에포트) ---------------
# snxbest.naver.com 주간 쇼핑 키워드 랭킹 + 기사수 등 보강.
# 주 1회 수집(2026-09-01 결정) — TRENDS_WEEKDAY 요일 실행에만 돌린다.
# 매니퍼스트는 3단계의 ingest-trends.ts가 적재한다.
# 실패해도 핫딜 파이프라인과는 무관하므로 계속 진행한다.
if [[ "$(date +%u)" == "$TRENDS_WEEKDAY" ]]; then
  log "[2/5] trends.py 실행 (주간 수집일)"
  if "$PYTHON" "$ROOT/collector/trends.py" >>"$LOG_FILE" 2>&1; then
    log "[2/5] 키워드 트렌드 수집 완료"
  else
    log "[2/5] 키워드 트렌드 수집 실패 — 계속 진행 (베스트 에포트)"
  fi
else
  log "[2/5] 키워드 트렌드 수집 생략 (주 1회 — 수집 요일 아님)"
fi

# ---- 3단계: ingest --------------------------------------
log "[3/5] ingest-crawls.ts 실행"
npx tsx scripts/ingest-crawls.ts >>"$LOG_FILE" 2>&1
ingest_rc=$?
if [[ "$ingest_rc" -eq 0 ]]; then
  log "[3/5] ingest 정상 종료"
else
  log "[3/5] ingest 실패 (exit $ingest_rc)"
fi

# 네이버 카페 검색 API 수집 — 키가 있을 때만 실행 (2026-09-02).
# HTML 스냅샷 없이 JSON API 응답을 직접 DB에 적재하므로
# collect.py/ingest-crawls.ts와 독립적이다. 실패해도 파이프라인 게이트 무관.
if [[ -n "${NAVER_CLIENT_ID:-}" && -n "${NAVER_CLIENT_SECRET:-}" ]]; then
  log "[3/5] fetch-naver-cafe.ts 실행 (네이버 카페 검색)"
  if npx tsx scripts/fetch-naver-cafe.ts >>"$LOG_FILE" 2>&1; then
    log "[3/5] 네이버 카페 수집 완료"
  else
    log "[3/5] 네이버 카페 수집 실패 — 계속 진행 (베스트 에포트)"
  fi
else
  log "[3/5] 네이버 카페 수집 생략 (API 키 미설정)"
fi

# 트렌드 매니퍼스트 적재 — 핫딜 적재와 독립적이라 실패해도
# 파이프라인 게이트(ingest_rc)에는 영향을 주지 않는다.
log "[3/5] ingest-trends.ts 실행"
if npx tsx scripts/ingest-trends.ts >>"$LOG_FILE" 2>&1; then
  log "[3/5] 트렌드 적재 완료"
else
  log "[3/5] 트렌드 적재 실패 — 계속 진행 (베스트 에포트)"
fi

# 트렌드 보관 주기 — 13주 롤링 (2026-08-28 결정). 옛 주차 삭제.
log "[3/5] purge-old-trends.ts 실행"
if npx tsx scripts/purge-old-trends.ts --keep-weeks 13 >>"$LOG_FILE" 2>&1; then
  log "[3/5] 트렌드 보관 주기 정리 완료"
else
  log "[3/5] 트렌드 정리 실패 — 계속 진행 (베스트 에포트)"
fi

# ---- 4단계: 링크 후처리 + 썸네일 수집 (베스트 에포트) ---------
# 4-1. 단축링크 해석 — 제휴 래퍼의 목적지를 캐시에 기록해 병합 키를 붙인다.
#      썸네일 수집이 해석 결과를 참조하므로 먼저 실행한다.
# 4-2. og:image/다나와 썸네일 수집 — 실패 시 스토어 로고 폴백.
# 4-3. 구매링크 사망 점검 — 08/22 스윕 시간대만 (종료 스윕과 같은 창).
# 모두 실패해도 표시 폴백이 있으므로 파이프라인을 멈추지 않는다.
if [[ "$ingest_rc" -eq 0 ]]; then
  log "[4/5] resolve-links.ts 실행"
  if npx tsx scripts/resolve-links.ts --limit 30 >>"$LOG_FILE" 2>&1; then
    log "[4/5] 단축링크 해석 완료"
  else
    log "[4/5] 단축링크 해석 실패 — 계속 진행 (베스트 에포트)"
  fi

  log "[4/5] fetch-thumbnails.ts 실행"
  if npx tsx scripts/fetch-thumbnails.ts --limit 40 >>"$LOG_FILE" 2>&1; then
    log "[4/5] 썸네일 수집 완료"
  else
    log "[4/5] 썸네일 수집 일부 실패 — 계속 진행"
  fi

  if [[ -n "$SWEEP" ]]; then
    log "[4/5] check-dead-links.ts 실행 (종료 스윕 시간대)"
    if npx tsx scripts/check-dead-links.ts --limit 40 >>"$LOG_FILE" 2>&1; then
      log "[4/5] 구매링크 사망 점검 완료"
    else
      log "[4/5] 구매링크 사망 점검 실패 — 계속 진행 (베스트 에포트)"
    fi
  fi
else
  log "[4/5] 링크 후처리·썸네일 수집 생략 (ingest 실패)"
fi
else
  collect_rc=0
  ingest_rc=0
fi

# ---- 5단계: deploy ----------------------------------------
# D1 컷오버 이후 데이터는 ingest 시점에 즉시 반영된다.
# 배포는 코드 변경이 있을 때만 필요 — 정상 수집 주기에서는 생략.
# deploy-only 모드는 코드 변경 즉시 반영용으로 유지.
deploy_rc=0
if [[ "$MODE" == "deploy-only" ]]; then
  log "[5/5] deploy-only: Vercel 프로덕션 배포"

  VERCEL="$(command -v vercel 2>/dev/null || true)"
  if [[ -z "$VERCEL" && -x /Users/beomjun/.nvm/versions/node/v22.22.2/bin/vercel ]]; then
    VERCEL=/Users/beomjun/.nvm/versions/node/v22.22.2/bin/vercel
  fi

  if [[ -n "$VERCEL" ]]; then
    if "$VERCEL" deploy --prod --yes >>"$LOG_FILE" 2>&1; then
      log "[5/5] Vercel 프로덕션 배포 완료"
    else
      deploy_rc=$?
      log "[5/5] Vercel 배포 실패 (exit $deploy_rc)"
    fi
  else
    log "[5/5] vercel CLI 없음 — 배포 생략"
  fi
elif [[ "$ingest_rc" -eq 0 ]]; then
  log "[5/5] D1 직적재 완료 — 별도 배포 불필요"
else
  log "[5/5] deploy 생략 (ingest 실패)"
fi

log "===== pipeline 종료 (collect=$collect_rc, ingest=$ingest_rc, deploy=$deploy_rc) ====="

# ingest 실패가 가장 심각하고, 그다음 배포 실패, 마지막으로 collect 완전 실패.
if [[ "$ingest_rc" -ne 0 ]]; then
  exit "$ingest_rc"
fi
if [[ "$deploy_rc" -ne 0 ]]; then
  exit "$deploy_rc"
fi
if [[ "$collect_rc" -gt 1 ]]; then
  exit "$collect_rc"
fi
exit 0
