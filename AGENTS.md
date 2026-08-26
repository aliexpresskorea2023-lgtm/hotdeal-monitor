<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Hotdeal Monitor 프로젝트 범위/결정 기록

## 수집 대상 커뮤니티

수집 대상 확정(2026-08-26): fmkorea, ppomppu, ruliweb, quasarzone, arca — 5곳 전부. quasarzone/arca는 파서 완료 + Chrome 지문 HTTP 크롤링으로 수집 가능 실측 완료.

결정(2026-08-26): quasarzone/arca는 초기 실측에서 헤드리스가 Cloudflare에 막혔으나, 후속 실측에서 챌린지가 TLS 지문 기반임이 확인 — Chrome 지문 모방 HTTP 클라이언트로 양쪽 모두 통과하여 수집 확정(아래 "Cloudflare 통과 실측" 참고).

제외(2026-08-27 결정): mlbpark(엠팍), theqoo(더쿠) — 핫딜 게시글 양이 적고 글 구조가 자유형이라 유의미한 구조화 데이터를 얻기 어려움. `types.ts`의 Community 유니온은 하위 호환을 위해 유지하되 파서/크롤러는 만들지 않는다.

제외(2026-08-26 결정): slrclub — 루트/핫딜 게시판 모두 HTTP 404(서비스 종료 의심)인 데다, 운영 중이어도 유의미한 핫딜이 올라오지 않는 것으로 확인. 파서·크롤러 모두 만들지 않는다. `types.ts`의 Community 유니온은 하위 호환을 위해 유지.

### 접근성 실측 (2026-08-26, 헤드리스 기준)

- fmkorea: 접근 가능. 단 WAF 있음 — 1초 간격 연속 요청 시 챌린지(lite_year 쿠키 + WASM fm5 + ddosCheckOnly) 발생, 쿠키 복제만으로는 429. 크롤러는 5~10초 스로틀 + 목록 우선 수집 필수.
- ppomppu: 접근 가능 (EUC-KR 인코딩 주의).
- ruliweb: 접근 가능. 핫딜/예판 게시판은 `bbs.ruliweb.com/community/board/1020`. 제목 규약 `[쇼핑몰] 상품명 (가격/배송)` + `div.source_url` 출처 링크가 폼 역할. 외부 링크는 `web.ruliweb.com/link.php?ol=<encoded>` 래핑(파서가 언래핑, rawUrl 별도 보존).
- quasarzone: 초기 실측에서 Cloudflare JS 챌린지(_cf_chl_opt)로 헤드리스 접근 불가였으나, **Chrome 지문 모방 HTTP 클라이언트(curl_cffi impersonate="chrome")로는 목록·상세 200 통과 확인(2026-08-26)**. 페이지는 서버 렌더링이라 JS 렌더링 불필요 — 본문 원문이 `textarea#org_contents`에 들어 있고 화면 영역(`#new_contents`)은 JS가 복사해 채운다. 핫딜 폼은 `table.market-info-view-table`(링크/판매처/가격/배송비, 추가 행 예: 기타사항), 상품 링크는 `javascript:goToLink('<base64>')` 래핑(실제 게이트웨이는 `quasarzone.com/link?link=<base64>`), 상태는 `h1.title span.label`로 DOM에 명시 — 변형 실측: `label` "진행중"/`label done` "종료"는 상태, `label mint` "인기"는 인기글 마커라 상태 신호로 쓰면 안 됨.
- arca: 초기 실측에서 Cloudflare "Just a moment" 챌린지로 헤드리스 접근 불가였으나, **Chrome 지문 모방 HTTP 클라이언트(curl_cffi impersonate="chrome")로는 목록·상세 200 통과 확인(2026-08-26)**. 페이지는 서버 렌더링이라 JS 렌더링 불필요 — 핫딜 채널 `arca.live/b/hotdeal/<id>`, 폼은 `table.article-options`(td.displayName span 라벨: 링크/쇼핑몰/상품명/가격/배송비), 상품명 행이 존재해 제목 파싱 폴백이 거의 불필요. 외부 링크는 `unsafelink.com/<실제URL>` 프리픽스 래핑(파서가 언래핑, rawUrl 별도 보존). 가격/배송비 행에 `<exchange data-currency data-value>` 정형 힌트가 있으면 우선 채택. 상태는 DOM 클래스로 명시 — 제목 div `close-deal` 클래스=종료, `span.bubble.live`("LIVE")=진행. 등록일은 `div.article-info time` datetime 속성이 UTC ISO라 +09:00 변환 필요(댓글에도 time이 많아 범위 한정 필수). **stats 라벨은 ko Accept-Language 요청 시 한국어("조회수"/"추천"/"댓글") — 파서가 영어/한국어 둘 다 처리(크롤러 수신 캡처 fixture 181084175로 고정).**
- slrclub: 루트/핫딜 게시판 모두 HTTP 404 — 서비스 종료 의심. **대상 제외 확정(2026-08-26)**, 재확인 불필요.

### 테스트 크롤링 실측 (2026-08-26)

접근 가능 3곳(fmkorea/ppomppu/ruliweb) 목록→상세→파서 실수집 성공(9/9, 실행 중 챌린지 없음). 스로틀: ppomppu/ruliweb 3초, fmkorea 7초. 발견·수정: ① ppomppu 크롤러 수신 HTML의 h1 내 `<span id="comment">` 댓글수가 제목에 섞임 → extractTitle에서 제거. ② ppomppu 단일 상품 글 name: null → 제목 폴백(nameFromTitle: 스토어 태그 + 꼬리 가격/배송 토큰 제거) 추가. ③ 목록에 섞이는 공지/규정 링크는 pmarket 필터 + 파서 폼 게이트로 방어. 라이브 스냅샷 3종이 fixtures로 승격, assertion 20종 고정. 상세는 `docs/interim-review-2026-08-26.md` §9.

quasarzone/arca는 브라우저 캡처 fixture 수급 또는 브라우저 레벨 크롤러가 필요하다는 초기 판단은 폐기 — 아래 방법으로 헤드리스/브라우저 없이 수집 가능해짐.

### Cloudflare 통과 실측 (2026-08-26) — quasarzone/arca 수집 가능

결론: 두 사이트의 Cloudflare 챌린지는 **TLS/HTTP2 지문 기반**이다. IP 기반이 아니라서, Chrome 지문을 모방하는 HTTP 클라이언트면 일반 요청 수준에서 200이 나온다.

- 실측: `curl_cffi` `impersonate="chrome"`으로 arca.live(목록 `/b/hotdeal` + 상세), quasarzone(목록 `/bbs/qb_saleinfo` + 상세 `/views/<id>`) 모두 챌린지 없이 200. RSS(`arca.live/rss/...`)는 403 — 별도 공개 RSS/API는 없다.
- 받아온 HTML을 기존 파서로 즉시 파싱 성공. arca는 크롤러 수신분에서 stats 라벨이 한국어(조회수/추천/댓글)로 오는 변형 발견 → 영어/한국어 라벨 모두 처리하도록 파서 수정, fixture `arca-181084175.html`로 고정.
- 외부 근거: 유사 서비스 dajupma.com도 arca를 서버 측에서 정상 수집(자체 `/api/deals` lastCrawl 로그에 arca ok, quasarzone은 그쪽 기준 403). 즉 헤드리스 없이 수집하는 실서비스가 이미 존재한다.
- **fmkorea WAF도 지문 가중 방식**: 기존엔 일반 클라이언트가 1초 간격만으로도 챌린지(lite_year + WASM fm5 + ddosCheckOnly)가 걸렸으나, Chrome 지문 클라이언트는 0.7초 간격 연속 6회 요청 전부 clean 200 통과(2026-08-26 실측). 즉 fmkorea에 필요했던 5~10초 스로틀도 지문 클라이언트로 크게 완화 가능. 단, 지속 부하(short burst 아님)는 별도이므로 프로덕션은 보수적 스로틀(2~3초 수준) 유지.
- 수집 시 준수: Chrome 지문 모방 클라이언트 + 보수적 스로틀, 목록 우선 수집. 크롤러는 Vercel serverless에서 돌리지 않는 기존 원칙 유지.

**크롤러 전송 계층 표준화 결정(2026-08-26)**: 5곳 수집 전체를 Chrome 지문 모방 HTTP 클라이언트 단일 구현으로 통일한다. quasarzone/arca는 지문 클라이언트가 필수, fmkorea/ppomppu/ruliweb은 지문 클라이언트로 스로틀 부담 완화. 성숙 구현이 `curl_cffi`(Python)이므로, 수집 워커는 Python으로 두고 HTML 스냅샷을 기존 TS 파서(순수 함수: HTML 문자열 → Deal[])에 공급하는 구조가 현실적. Node 단독 TLS 지문 모방은 신뢰할 만한 라이브러리가 제한적이라 권장하지 않음.

### 수집 워커 구현 (2026-08-26) — collector/collect.py

역할 분담: 워커는 **수송 전용**(목록 → 게시글 발견 → 상세 → HTML 스냅샷 + manifest.json 저장). 딜 파싱은 일절 하지 않으며, 기존 TS 순수 파서가 스냅샷을 받아 처리한다. 챌린지/비-200 페이지는 게시글로 저장하지 않고 해당 커뮤니티 run을 중단·기록한다.

- 실행: `collector/.venv/bin/python collector/collect.py` (기본 5곳, 목록 1페이지, 상세 최대 5건). 옵션: `--communities`(쉼표 목록), `--pages`, `--max-details`, `--out`, `--throttle`, `--list-only`. venv 설치법은 파일 헤더/`collector/requirements.txt` 참고.
- 출력: `data/crawls/<run-id>/<community>/<postId>.html` + `manifest.json`(run 정보 + entry별 url/httpStatus/challenge/snapshot). append-only, `.gitignore` 처리.
- 스로틀: 지문 통과가 확인돼도 보수적으로 fmkorea 3.0초, 나머지 2.5초 유지.
- 실측(2026-08-26): 5곳 전부 목록·상세 clean 200, 챌린지 0건. 스냅샷 15건 전부 기존 파서 파이프라인 통과(스키마 v2.0 위반 0, 파싱 예외 0) — 검증은 `tests/snapshot-ingest-test.ts`(run 디렉터리 미지정 시 최신 run 자동 선택).
- **챌린지 감지 주의(실측 교훈)**: Cloudflare **Managed Challenge**가 켜진 사이트(quasarzone)는 *통과한 정상 페이지*에도 `__CF$cv$params` 부트스트랩 스니펫(`/cdn-cgi/challenge-platform/...`)을 주입한다. 따라서 마커 문자열 존재만으로 챌린지 판정하면 오탐으로 전량 차단된다. 판정은 ① 403/503 ② `<title>`이 "Just a moment" 계열 ③ (보조) 마커 포함 + 페이지 <64KB — 의 조합으로 해야 한다.
- **quasarzone 목록 주의**: 목록 URL에 `?page=N`을 붙이면 행 앵커 href에도 `?page=N`이 붙어온다(`views/1981994?page=1`) — id 뒤 쿼리스트링을 허용하는 정규식이 필요. 공지(라벨 `공지`, `all-notice-wrap` 블록)는 딜이 아니므로 목록 단계에서 제외(안 그러면 규정 글이 가짜 딜로 파싱됨). fmkorea는 통합공지 srl 제외, ruliweb은 notice 행 제외와 동일한 원칙.

### DB 계층 + 증분 수집 (2026-08-26) — data/hotdeal.db

종료 딜 수집 결정(2026-08-26): **종료 딜도 수집한다.** 최저가 히스토리는 커뮤니티 가격 관측의 시계열(파서가 상품 페이지를 직접 받지 않으므로)이고, 종료 딜은 "가격 관측 + 종료 시점"을 함께 주는 가장 값진 데이터다. 프론트는 active만 노출하고 DB는 전부 보존.

SQLite(내장 `node:sqlite`, 드라이버 무설치) 스키마는 `src/db/schema.sql`:
- `posts` — (community, post_id) 유일. 주기 수집에서 같은 글은 재삽입 없이 상태/stats 갱신. `products_count=0`이면 폼 미입력/자유형 글이라는 표시(워커가 ended와 함께 동결 처리).
- `deals` — (post_rowid, seq) 유일로 제자리 upsert. 1게시글 N상품. `item_id`(ali/coupang 등)는 상품 단위 묶음의 1차 후보 신호로 보존 — productKey 해결은 다음 단계(이 섹션 아래 보류 결정과 동일).
- `price_observations` — append-only 시계열. 가격/배송비/추정원화/게시글 상태가 직전 관측과 다를 때만 행 추가(조회수 같은 연속 변동은 관측을 만들지 않음). ended 전환 시점도 여기 기록된다.
- `ingest_runs` — run 중복 적재 방지 원장.

적재: `npx tsx scripts/ingest-crawls.ts` (인자 없으면 미적재 run 전부, run 경로 지정 가능). products=0 글도 post 행은 적재한다 — 워커의 동결 판단 근거가 되기 때문.

워커는 DB를 읽어 **상세 요청 자체를 줄인다**(`--no-db`로 비활성, `--force`로 무시):
- ended 또는 products=0 게시글 → 동결 스킵 (터미널 상태, 재수집 불필요).
- active/unknown 게시글 → `--recheck-hours`(기본 12h) 내 재확인 완료면 스킵, 경과 후 재수집해 상태 전환·가격 변동을 관측.
- 스킵은 요청이 없어 `--max-details` 예산을 소모하지 않는다. 즉 예산은 전부 "새 글"에 쓰인다.

실측(2026-08-26): run 45스냅샷 적재 시 posts 19개로 병합(중복 제거 확인), 재적재 시 관측 중복 없음. DB 스킵 스모크에서 ended/폼미입력 동결 + TTL 스킵 정상 동작 확인.

### 주기 수집 스케줄링 (2026-08-26) — run-pipeline.sh + launchd(로컬 Mac)

단일 진입점: `collector/run-pipeline.sh [collect.py 옵션]`. collect(Python) → ingest(Node)를 순차 실행하되, collect가 일부 차단(exit 1)이나 완전 실패(exit 2+)여도 ingest는 반드시 돌려 부분 수집분·이전 미적재분을 따라잡는다. mkdir 기반 잠금으로 중복 실행 방지(진행 중이면 exit 75). 로그는 `data/logs/pipeline.log`(append).

스케줄링 위치 최종 결정(2026-08-26): **로컬 Mac + launchd, 2시간 주기.**

결정 경위:
1. 로컬 launchd 1차 시도 → macOS TCC 차단(`~/Documents` 보호, exit 126).
2. VPS(Oracle Always Free)로 방향 전환 → 사용자 우려(과금 경험, 인계 복잡도)로 재검토.
3. **Vercel 서버리스 실측(프로브 배포)** — 핵심 발견:
   - curl_cffi(Chrome 지문)는 Vercel에서 정상 동작. Cloudflare 계열(quasarzone/arca)은 해외 DC IP에서도 지문으로 통과(200, 목록 파싱 성공).
   - 그러나 **fmkorea는 430(자체 WAF "에펨코리아 보안 시스템") — TLS 지문 6종(chrome/safari/firefox/edge 등) 전부 차단 → IP 평판 기반, 지문으로 우회 불가.**
   - **ruliweb은 TCP 커넥션 타임아웃 — 해외/DC IP 대역 차단.**
   - 결론: Vercel로는 3/5 커뮤니티만 수집 가능(최대 출처 fmkorea 상실). Vercel은 파일시스템 휘발성이라 SQLite/스냅샷 구조 재설계도 필요.
4. fmkorea·ruliweb 포함 전체 수집은 **한국 IP 필수** → 무료 한국 IP는 사용자 Mac(가정용 회선)이 유일하게 실측 통과. 프로젝트 경로를 `~/Documents` → `~/dev/hotdeal-monitor`로 이동해 TCC 회피, launchd 실측 통과(exit 0).

launchd 구성: `collector/com.beomjun.hotdeal-monitor.pipeline.plist`(Label `com.beomjun.hotdeal-monitor.pipeline`, StartInterval 7200초 = 2h, 수면 중 밀린 분은 기상 후 1회 따라잡기, `--pages 1 --max-details 40`). 설치는 `~/Library/LaunchAgents` 복사 + `launchctl bootstrap gui/$UID`. 로그는 `data/logs/launchd-{stdout,stderr}.log`.

유의:
- `~/dev`는 TCC 비보호 경로라 launchd 접근 가능. 프로젝트를 다시 보호 폴더로 옮기면 재발.
- plist의 PATH에 nvm node 경로를 명시함 — node 버전 변경 시 plist도 수정 필요.
- 장기 호스팅(인계 시점) 재논의 때 위 Vercel 실측 결과를 전제로: 5곳 전체는 한국 IP 호스트 필요. `deploy/`의 VPS 패키지(systemd timer)는 그 경우의 대안으로 보존.

## 향후 프론트엔드 설계 메모 (지금 구현하지 않음)

동일 아이템(상품명&옵션 동일 또는 상품 ID 동일)이 여러 커뮤니티에 동시 바이럴된 경우: 프론트에서는 아이템 카드 1개로 노출하고 커뮤니티 목록을 복수로 표시, 각 커뮤니티 탭에서도 동일 카드가 보이도록 한다. 즉 상품 정체성(productKey)은 커뮤니티 위에 있고, 커뮤니티는 카드의 속성 목록이 된다. 이 때문에 DB 설계 시 상품:게시글 = 1:N 관계(커뮤니티 교차)를 전제로 한다.

## 배포 방향 (2026-08-27)

- 디자인 확정 전까지는 Vercel 무료 플랜으로 빠르게 배포.
- 이후 국내 서비스 무료 플랜 대안 검토(국내 IP가 크롤러/WAF에 유리).
- 수집 데이터는 OSINT 정제물이라 외부 호스팅에 보안 리스크 없음.
- 단, 수집 워커는 Vercel 서버리스에 올리지 않는다 — 실측(2026-08-26)으로 fmkorea 430(IP 평판 WAF)·ruliweb TCP 차단 확인. 3/5만 수집 가능해 최대 출처가 빠지므로 부적합(상세: "주기 수집 스케줄링" 섹션).
