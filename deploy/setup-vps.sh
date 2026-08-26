#!/usr/bin/env bash
# hotdeal-monitor VPS 프로비저닝 스크립트 (Ubuntu 22.04 / 24.04)
#
# 하는 일:
#   1. 시스템 패키지 설치 (git, python3-venv 등)
#   2. Node.js 22 설치 (node:sqlite 내장 버전)
#   3. pnpm 활성화
#   4. 리포 clone (이미 있으면 pull)
#   5. Python venv + curl_cffi 설치
#   6. Node 의존성 설치 (pnpm --frozen-lockfile)
#   7. systemd 타이머 설치 (2시간 주기) + logrotate 설정
#
# 사용법:
#   sudo bash deploy/setup-vps.sh
#
# 환경변수 옵션:
#   APP_DIR        설치 경로 (기본 /opt/hotdeal-monitor)
#   APP_USER       서비스 실행 사용자 (기본: sudo 호출자)
#   REPO_URL       clone 주소 (비공개 리포면 SSH deploy key 설정 후
#                  git@github.com:... 형태로 지정)
#   SKIP_GIT_PULL  1이면 clone/pull 생략 (migrate-to-vps.sh가 rsync로
#                  코드를 이전한 경우용)

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "sudo로 실행해 주세요: sudo bash deploy/setup-vps.sh" >&2
  exit 1
fi

APP_USER="${APP_USER:-${SUDO_USER:-root}}"
APP_DIR="${APP_DIR:-/opt/hotdeal-monitor}"
REPO_URL="${REPO_URL:-https://github.com/aliexpresskorea2023-lgtm/hotdeal-monitor.git}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$APP_USER" == "root" ]]; then
  echo "경고: sudo 사용자 감지 실패 — 서비스를 root로 실행합니다." >&2
fi

echo "==> [1/7] 시스템 패키지"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates python3 python3-venv python3-pip logrotate

echo "==> [2/7] Node.js 22 (NodeSource)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh >/dev/null
  apt-get install -y -qq nodejs
  rm -f /tmp/nodesource_setup.sh
fi
echo "node $(node --version)"

echo "==> [3/7] pnpm"
corepack enable >/dev/null 2>&1 || true
if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g pnpm@11 >/dev/null
fi
echo "pnpm $(pnpm --version)"

echo "==> [4/7] 코드 clone/pull → $APP_DIR"
if [[ "${SKIP_GIT_PULL:-0}" == "1" ]]; then
  # migrate-to-vps.sh가 rsync로 코드를 이미 이전한 경우 — 원격 저장소 접근 불필요
  echo "    SKIP_GIT_PULL=1 — rsync 이전분 사용, git pull 생략"
elif [[ -d "$APP_DIR/.git" ]]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
else
  sudo -u "$APP_USER" git clone "$REPO_URL" "$APP_DIR"
fi

echo "==> [5/7] Python venv + curl_cffi"
sudo -u "$APP_USER" python3 -m venv "$APP_DIR/collector/.venv"
sudo -u "$APP_USER" "$APP_DIR/collector/.venv/bin/pip" install -q --upgrade pip
sudo -u "$APP_USER" "$APP_DIR/collector/.venv/bin/pip" install -q -r "$APP_DIR/collector/requirements.txt"

echo "==> [6/7] Node 의존성 (pnpm install)"
sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && pnpm install --frozen-lockfile"

echo "==> [7/7] systemd 타이머 + logrotate"
sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@APP_USER@|$APP_USER|g" \
  "$SCRIPT_DIR/hotdeal-pipeline.service" > /etc/systemd/system/hotdeal-pipeline.service
sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@APP_USER@|$APP_USER|g" \
  "$SCRIPT_DIR/hotdeal-pipeline.timer" > /etc/systemd/system/hotdeal-pipeline.timer

cat > /etc/logrotate.d/hotdeal-monitor <<EOF
$APP_DIR/data/logs/*.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    copytruncate
}
EOF

# 스냅샷 보관 디렉터리 준비
sudo -u "$APP_USER" mkdir -p "$APP_DIR/data/crawls" "$APP_DIR/data/logs"

systemctl daemon-reload
systemctl enable --now hotdeal-pipeline.timer

echo ""
echo "============================================"
echo "설치 완료."
echo "  타이머 상태:  systemctl status hotdeal-pipeline.timer"
echo "  수동 1회 실행: sudo systemctl start hotdeal-pipeline.service"
echo "  로그:         journalctl -u hotdeal-pipeline.service -f"
echo "                ($APP_DIR/data/logs/pipeline.log 에도 기록)"
echo "============================================"
