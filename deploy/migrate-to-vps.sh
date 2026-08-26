#!/usr/bin/env bash
# hotdeal-monitor 이사 스크립트: 로컬 Mac → VPS (인계 시점용)
#
# Mac에서 launchd로 돌리던 수집 환경을 대상 서버로 통째로 옮긴다:
#   코드(.git 포함) + SQLite DB(가격 관측 시계열) + 크롤 스냅샷
#   → rsync 이전 → 원격 setup-vps.sh 프로비저닝(systemd 타이머 설치)
#
# 사용법 (Mac에서 실행):
#   bash deploy/migrate-to-vps.sh <user@host>
#
# 환경변수 옵션:
#   APP_DIR     대상 설치 경로 (기본 /opt/hotdeal-monitor)
#   SSH_PORT    SSH 포트 (기본 22)
#   STOP_LOCAL  1이면 이사 성공 후 Mac 쪽 launchd 에이전트를 정지한다
#               (이중 수집 방지 — Mac 수집을 완전히 끝낼 때만 사용)
#
# 전제:
#   - 대상 서버: Ubuntu 22.04/24.04 + sudo 권한 + SSH 공개키 인증 완료
#   - 대상 서버가 한국 IP여야 5개 커뮤니티 전부 수집 가능
#     (fmkorea/ruliweb은 해외 IP 차단 — AGENTS.md "Vercel 실측" 참고)
#   - 로컬: data/hotdeal.db가 존재하는 수집 중인 Mac
#
# 이사 후 남는 일(수동):
#   - 서버에서 git pull로 코드 갱신을 계속하려면 deploy key 등록
#     (deploy/README.md 참고). 등록 전까지는 이 스크립트 재실행으로 동기화.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "사용법: bash deploy/migrate-to-vps.sh <user@host>" >&2
  echo "옵션(환경변수): APP_DIR SSH_PORT STOP_LOCAL" >&2
  exit 1
fi

HOST="$1"
APP_DIR="${APP_DIR:-/opt/hotdeal-monitor}"
SSH_PORT="${SSH_PORT:-22}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_OPTS=(-p "$SSH_PORT" -o BatchMode=yes -o ConnectTimeout=10)
RSYNC_SSH="ssh ${SSH_OPTS[*]}"

RSYNC_EXCLUDES=(
  --exclude '/node_modules/'
  --exclude '/.next/'
  --exclude '/collector/.venv/'
  --exclude '/data/.pipeline.lock'
  --exclude '__pycache__'
  --exclude '.DS_Store'
)

wait_for_lock() {
  while [[ -d "$ROOT/data/.pipeline.lock" ]]; do
    echo "    파이프라인 실행 중 — 완료 대기 (10초)"
    sleep 10
  done
}

checkpoint_db() {
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$ROOT/data/hotdeal.db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
  fi
}

sync_all() {
  rsync -az --delete "${RSYNC_EXCLUDES[@]}" -e "$RSYNC_SSH" \
    "$ROOT/" "$HOST:$APP_DIR/"
}

sync_data_only() {
  rsync -az --delete \
    --exclude '/.pipeline.lock' \
    -e "$RSYNC_SSH" \
    "$ROOT/data/" "$HOST:$APP_DIR/data/"
}

echo "==> [1/6] 전제 확인"
command -v rsync >/dev/null 2>&1 || { echo "rsync가 필요합니다." >&2; exit 1; }
[[ -f "$ROOT/data/hotdeal.db" ]] || {
  echo "data/hotdeal.db가 없습니다 — 수집 이력이 없어 이사할 데이터가 없습니다." >&2
  exit 1
}
ssh "${SSH_OPTS[@]}" "$HOST" true || {
  echo "SSH 접속 실패: $HOST (포트 $SSH_PORT)." >&2
  echo "비밀번호 인증은 지원하지 않습니다 — 공개키를 서버에 먼저 등록하세요." >&2
  exit 1
}
echo "    로컬: $ROOT"
echo "    대상: $HOST:$APP_DIR"

echo "==> [2/6] 파이프라인 잠금 대기 + DB 일관성 확보"
wait_for_lock
checkpoint_db
echo "    WAL 체크포인트 완료 (hotdeal.db 단일 파일 일관 상태)"

echo "==> [3/6] 대상 디렉터리 준비"
REMOTE_USER="${HOST%%@*}"
ssh "${SSH_OPTS[@]}" "$HOST" \
  "sudo mkdir -p '$APP_DIR' && sudo chown '$REMOTE_USER' '$APP_DIR'"

echo "==> [4/6] rsync 이전 (코드 + DB + 스냅샷)"
sync_all
# rsync 중 새 수집이 시작됐으면(잠금 재출현) 완료 후 data/만 재동기화
if [[ -d "$ROOT/data/.pipeline.lock" ]]; then
  echo "    이사 중 새 수집 실행됨 — 완료 후 data/ 재동기화"
  wait_for_lock
  checkpoint_db
  sync_data_only
fi
echo "    이전 완료"

echo "==> [5/6] 원격 프로비저닝 (setup-vps.sh)"
ssh "${SSH_OPTS[@]}" "$HOST" \
  "sudo APP_DIR='$APP_DIR' SKIP_GIT_PULL=1 bash '$APP_DIR/deploy/setup-vps.sh'"

echo "==> [6/6] 상태 확인"
ssh "${SSH_OPTS[@]}" "$HOST" \
  "systemctl is-enabled hotdeal-pipeline.timer && systemctl status hotdeal-pipeline.timer --no-pager | head -6" \
  || echo "    (타이머 상태 확인 실패 — 서버에서 systemctl status로 직접 확인)"

if [[ "${STOP_LOCAL:-0}" == "1" ]]; then
  echo "==> Mac 쪽 launchd 에이전트 정지 (STOP_LOCAL=1)"
  launchctl bootout "gui/$(id -u)/com.beomjun.hotdeal-monitor.pipeline" 2>/dev/null \
    && echo "    정지 완료 — 이제 서버만 수집합니다." \
    || echo "    이미 정지되어 있거나 등록되지 않은 에이전트입니다."
fi

echo ""
echo "============================================"
echo "이사 완료. 서버가 2시간 주기로 수집을 이어갑니다."
echo ""
echo "  수동 1회 실행:  ssh $HOST 'sudo systemctl start hotdeal-pipeline.service'"
echo "  로그:           ssh $HOST 'tail -f $APP_DIR/data/logs/pipeline.log'"
echo ""
echo "  ※ Mac 수집을 유지하면 양쪽이 같은 사이트를 중복 크롤합니다."
echo "    Mac 쪽 정지: launchctl bootout gui/\$(id -u)/com.beomjun.hotdeal-monitor.pipeline"
echo "============================================"
