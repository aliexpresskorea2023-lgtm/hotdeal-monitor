#!/bin/bash
# hotdeal-monitor 주기 수집 파이프라인: collect (Python) → ingest (TS)
#
# 동작 원칙:
# - collect가 일부 커뮤니티 차단으로 exit 1을 내도 부분 수집분은 가치가
#   있으므로 ingest는 반드시 실행한다. collect가 완전히 깨져도(exit 2+)
#   이전 run의 미적재 스냅샷을 ingest가 따라잡을 수 있으므로 계속 진행한다.
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
log "[1/2] collect.py 실행"
"$PYTHON" "$ROOT/collector/collect.py" "$@" >>"$LOG_FILE" 2>&1
collect_rc=$?
case "$collect_rc" in
  0) log "[1/2] collect 정상 종료 (exit 0)" ;;
  1) log "[1/2] collect 종료 — 일부 커뮤니티 차단 감지 (exit 1). 부분 수집분은 ingest로 진행" ;;
  *) log "[1/2] collect 비정상 종료 (exit $collect_rc). 그래도 ingest는 실행" ;;
esac

# ---- 2단계: ingest --------------------------------------
log "[2/2] ingest-crawls.ts 실행"
npx tsx scripts/ingest-crawls.ts >>"$LOG_FILE" 2>&1
ingest_rc=$?
if [[ "$ingest_rc" -eq 0 ]]; then
  log "[2/2] ingest 정상 종료"
else
  log "[2/2] ingest 실패 (exit $ingest_rc)"
fi

log "===== pipeline 종료 (collect=$collect_rc, ingest=$ingest_rc) ====="

# collect가 완전히 깨진 경우(2+)보다 ingest 실패가 더 심각하지만,
# 스케줄러가 재시도할 수 있도록 둘 다 비0이면 실패 코드 전파.
if [[ "$ingest_rc" -ne 0 ]]; then
  exit "$ingest_rc"
fi
if [[ "$collect_rc" -gt 1 ]]; then
  exit "$collect_rc"
fi
exit 0
