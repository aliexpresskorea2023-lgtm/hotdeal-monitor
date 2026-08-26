# VPS 배포 가이드

수집 워커(collect → ingest)를 2시간 주기로 돌릴 리눅스 서버 세팅 절차.
프론트엔드(Vercel)와 분리 — 크롤러는 서버리스에 올리지 않는다(타임아웃, 해외 DC IP).

## 권장 서버: Oracle Cloud Always Free

비용 0원, 스펙 여유(ARM Ampere 최대 4 OCPU / 24GB), 영구 무료.

1. <https://signup.oraclecloud.com/> 가입. 신용카드 본인인증 필요(결제 없음).
2. 인스턴스 생성: Compute → Instances → Create instance
   - 이미지: **Ubuntu 22.04** (Canonical)
   - 셰이프: **Ampere A1 Flex — 1 OCPU / 6GB RAM** (Always Free 범위 내)
   - SSH 키: 아래 공개 키를 붙여넣기
     ```
     ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDdn4d2kwwQCd47kKUeCjL+lqosmkONzHfVnAhaGvxDN hotdeal-monitor vps access
     ```
   - 네트워크: 기본 VCN 자동 생성 그대로
3. 생성 후 퍼블릭 IP 확인 → IP를 공유하면 이후 세팅은 원격으로 진행.

 inbound는 SSH(22)만 열면 된다. 크롤은 전부 아웃바운드라 추가 포트 불필요.
 Oracle Ubuntu 이미지는 iptables가 SSH만 허용하도록 기본 설정되어 있어 그대로 두면 됨.

대안(유료, 간단): Vultr/Hetzner/Lightsail Ubuntu 22.04 + 위 공개 키 등록. 절차 동일.

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

## 유의

- `data/crawls/` 스냅샷은 계속 쌓인다(steady-state ~2MB/회). 디스크가
  작으면 가지치기 정책 필요(백로그). Oracle Free는 블록 스토리지 100GB라 여유.
- 서버 시각이 UTC여도 무방 — 파이프라인은 전부 KST 명시 변환.
- 서버 IP가 바뀌거나 WAF 양상이 바뀌면 `data/logs/pipeline.log`의
  challenge/blocked 통계부터 확인할 것.
