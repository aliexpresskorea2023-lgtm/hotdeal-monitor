#!/bin/bash
# hotdeal-monitor 주기 수집 파이프라인:
#   collect (Python) → ingest (TS) → thumbnails (og:image) → deploy (git + Vercel)
#
# 동작 원칙:
# - collect가 일부 커뮤니티 차단으로 exit 1을 내도 부분 수집분은 가치가
#   있으므로 ingest는 반드시 실행한다. collect가 완전히 깨져도(exit 2+)
#   이전 run의 미적재 스냅샷을 ingest가 따라잡을 수 있으므로 계속 진행한다.
# - 배포는 ingest가 성공한 경우에만 실행한다. DB 스냅샷을 커밋·푸시하고
#   `vercel deploy --prod`로 프로덕션에 반영한다(수집 주기 = 배포 주기).
#   배포 실패는 수집 자체의 실패와 분리해 기록하되 종료코드로 전파한다.
# - 스크립트 위치 기준으로 프로젝트 루트를 해석해서 어디서 실행해도 안전하다
#   (launchd는 CWD=/ 로 실행함).
# - mkdir 기반 잠금으로 중복 실행을 막는다. 이전 실행이 아직 살아 있으면
#   새 실행은 즉시 종료(exit 75, EX_TEMPFAIL).
#
# 사용법:
#   collector/run-pipeline.sh [collect.py 옵션 그대로 전달]
#   예) collector/run-pipeline.sh --pages 1 --max-details 40
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

# ---- 전제 조건 확인 --------------------------------------
if [[ ! -x "$PYTHON" ]]; then
  log "오류: venv python이 없습니다 ($PYTHON). 'python3 -m venv collector/.venv && collector/.venv/bin/pip install -r collector/requirements.txt' 필요."
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  log "오류: npx를 찾을 수 없습니다 (Node.js 필요)."
  exit 1
fi

# ---- 1단계: collect -------------------------------------
log "[1/4] collect.py 실행"
"$PYTHON" "$ROOT/collector/collect.py" "$@" >>"$LOG_FILE" 2>&1
collect_rc=$?
case "$collect_rc" in
  0) log "[1/4] collect 정상 종료 (exit 0)" ;;
  1) log "[1/4] collect 종료 — 일부 커뮤니티 차단 감지 (exit 1). 부분 수집분은 ingest로 진행" ;;
  *) log "[1/4] collect 비정상 종료 (exit $collect_rc). 그래도 ingest는 실행" ;;
esac

# ---- 2단계: ingest --------------------------------------
log "[2/4] ingest-crawls.ts 실행"
npx tsx scripts/ingest-crawls.ts >>"$LOG_FILE" 2>&1
ingest_rc=$?
if [[ "$ingest_rc" -eq 0 ]]; then
  log "[2/4] ingest 정상 종료"
else
  log "[2/4] ingest 실패 (exit $ingest_rc)"
fi

# ---- 3단계: 썸네일 수집 (베스트 에포트) --------------------
# 신규 상품 페이지에서 og:image 추출 — 캐시되어 실패는 3회까지만 재시도.
# 실패해도 표시는 스토어 로고로 폴백되므로 파이프라인을 멈추지 않는다.
if [[ "$ingest_rc" -eq 0 ]]; then
  log "[3/4] fetch-thumbnails.ts 실행"
  if npx tsx scripts/fetch-thumbnails.ts --limit 40 >>"$LOG_FILE" 2>&1; then
    log "[3/4] 썸네일 수집 완료"
  else
    log "[3/4] 썸네일 수집 일부 실패 — 계속 진행"
  fi
else
  log "[3/4] 썸네일 수집 생략 (ingest 실패)"
fi

# ---- 4단계: deploy (ingest 성공 시에만) ------------------
# 4a. DB 스냅샷 커밋·푸시 — 리포가 배포 데이터의 백업 역할도 한다.
# 4b. vercel deploy --prod — 커밋 여부와 무관하게 현재 작업 트리를
#     업로드하므로 데이터 갱신이 바로 반영된다.
deploy_rc=0
if [[ "$ingest_rc" -eq 0 ]]; then
  log "[4/4] deploy 단계 시작"

  if command -v git >/dev/null 2>&1; then
    git add data/hotdeal.db 2>/dev/null
    if ! git diff --cached --quiet -- data/hotdeal.db 2>/dev/null; then
      if git commit -m "데이터 스냅샷: $(ts) (auto)" -- data/hotdeal.db >>"$LOG_FILE" 2>&1 \
         && git push origin HEAD >>"$LOG_FILE" 2>&1; then
        log "[4/4] DB 스냅샷 커밋·푸시 완료"
      else
        log "[4/4] DB 커밋·푸시 실패 — 배포는 계속 진행"
      fi
    else
      log "[4/4] DB 변경 없음 — 커밋 생략"
    fi
  else
    log "[4/4] git 없음 — 커밋 생략"
  fi

  VERCEL="$(command -v vercel 2>/dev/null || true)"
  if [[ -z "$VERCEL" && -x /Users/beomjun/.nvm/versions/node/v22.22.2/bin/vercel ]]; then
    VERCEL=/Users/beomjun/.nvm/versions/node/v22.22.2/bin/vercel
  fi

  if [[ -n "$VERCEL" ]]; then
    if "$VERCEL" deploy --prod --yes >>"$LOG_FILE" 2>&1; then
      log "[4/4] Vercel 프로덕션 배포 완료"
    else
      deploy_rc=$?
      log "[4/4] Vercel 배포 실패 (exit $deploy_rc)"
    fi
  else
    log "[4/4] vercel CLI 없음 — 배포 생략"
  fi
else
  log "[4/4] deploy 생략 (ingest 실패)"
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
