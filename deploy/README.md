# VPS 배포 가이드

수집 워커(collect → ingest)를 2시간 주기로 돌릴 리눅스 서버 세팅 절차.
프론트엔드(Vercel)와 분리 — 크롤러는 서버리스에 올리지 않는다(타임아웃, 해외 DC IP).

## 권장 서버: 한국 IP VPS (회사 계정)

5개 커뮤니티 전부 수집하려면 **한국 IP가 필수**다(fmkorea/ruliweb이 해외 IP 차단 —
루트 AGENTS.md "Vercel 실측" 참고). 인계 시점 기준 절차:

1. 국내 클라우드(또는 Vultr/Hetzner 서울 리전 등)에서 **회사 계정·회사 카드**로
   Ubuntu 22.04/24.04 인스턴스 생성. 소규모(1 vCPU / 1~2GB)면 충분.
2. 담당자 SSH 공개 키를 인스턴스에 등록.
3. inbound는 SSH(22)만 열면 된다. 크롤은 전부 아웃바운드라 추가 포트 불필요.

> 오라클 Always Free는 배제 결정(2026-08-26): 등록 카드 삭제가 불가능하고,
> 홈리전(영구 고정)인 서울 리전은 무료 용량이 사실상 없어 해외 리전을 선택하게
> 되면 fmkorea/ruliweb 차단으로 3/5만 수집 가능. 개인 카드를 회사 프로젝트에
> 남기지 않는 방향.

## Mac → VPS 이사 (자동화: `deploy/migrate-to-vps.sh`)

Mac에서 launchd로 돌리던 환경을 서버로 원커맨드 이전:

```bash
bash deploy/migrate-to-vps.sh <user@host>     # 옵션: APP_DIR SSH_PORT STOP_LOCAL=1
```

코드(.git 포함) + SQLite DB(가격 관측 시계열) + 크롤 스냅샷을 rsync로 옮긴 뒤
원격에서 `setup-vps.sh`를 실행해 타이머까지 설치한다. 실행 중 파이프라인이 있으면
완료 대기하고, 이사 중 새 수집이 끼어들면 data/를 재동기화한다.
`STOP_LOCAL=1`을 주면 성공 시 Mac 쪽 launchd 에이전트도 정지(이중 수집 방지).

## 서버에서 하는 일 (자동화: `deploy/setup-vps.sh`)

- git, python3-venv, NodeSource Node 22(node:sqlite 필요), pnpm 설치
- 리포 clone → Python venv(curl_cffi) + `pnpm install --frozen-lockfile`
- systemd 타이머: 매 짝수 시 정각(±2분 지터) `collector/run-pipeline.sh --pages 1 --max-details 40`
  (`Persistent=true`라 서버가 꺼져 있다가 켜지면 밀린 1회 따라잡기)
- logrotate: `data/logs/*.log` 주간 로테이트, 8주 보관

비공개 리포 접근은 **GitHub deploy key**(읽기 전용 SSH 키) 사용 —
서버에서 키를 생성해 퍼블릭 키를 리포 Settings → Deploy keys에 등록.
토큰을 서버에 남기지 않는다.

## 운영 명령어

```bash
systemctl status hotdeal-pipeline.timer    # 스케줄 상태
sudo systemctl start hotdeal-pipeline.service   # 수동 1회 실행
journalctl -u hotdeal-pipeline -f          # 실행 로그
tail -f /opt/hotdeal-monitor/data/logs/pipeline.log
```

## 코드 수정 후 재배포

```bash
cd /opt/hotdeal-monitor && sudo -u <user> git pull --ff-only
# 의존성이変わった 경우:
sudo -u <user> bash -c 'cd /opt/hotdeal-monitor && pnpm install --frozen-lockfile'
sudo -u <user> /opt/hotdeal-monitor/collector/.venv/bin/pip install -r collector/requirements.txt
```

deploy key가 없으면(비공개 리포) Mac에서 `bash deploy/migrate-to-vps.sh <user@host>`
재실행으로 코드+데이터를 통째로 동기화해도 된다(멱등).

## 유의

- `data/crawls/` 스냅샷은 계속 쌓인다(steady-state ~2MB/회). 소형 인스턴스
  디스크가 작으면 가지치기 정책 필요(백로그). 20GB 이상이면 당분간 여유.
- 서버 시각이 UTC여도 무방 — 파이프라인은 전부 KST 명시 변환.
- 서버 IP가 바뀌거나 WAF 양상이 바뀌면 `data/logs/pipeline.log`의
  challenge/blocked 통계부터 확인할 것.
