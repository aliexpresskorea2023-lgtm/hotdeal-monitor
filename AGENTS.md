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

단일 진입점: `collector/run-pipeline.sh [collect.py 옵션]`. 4단계 순차: ① collect(Python) ② ingest(Node) ③ 썸네일 수집(`fetch-thumbnails.ts --limit 40`, 베스트 에포트, 2단계: og:image → 다나와 폴백) ④ 배포(아래 "배포 파이프라인" 참고). collect가 일부 차단(exit 1)이나 완전 실패(exit 2+)여도 ingest는 반드시 돌려 부분 수집분·이전 미적재분을 따라잡는다. mkdir 기반 잠금으로 중복 실행 방지(진행 중이면 exit 75). 로그는 `data/logs/pipeline.log`(append).

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

launchd 구성: `collector/com.beomjun.hotdeal-monitor.pipeline.plist`(Label `com.beomjun.hotdeal-monitor.pipeline`, **StartCalendarInterval 08~22시 매 2시간 = 하루 8회**, 수면 중 밀린 분은 기상 후 1회 따라잡기, `--pages 1 --max-details 40`). 설치는 `~/Library/LaunchAgents` 복사 + `launchctl bootstrap gui/$UID`. 로그는 `data/logs/launchd-{stdout,stderr}.log`.

스케줄 변경(2026-08-27): 초기엔 StartInterval 7200(24h 무중단)이었으나 주간 전용으로 축소. 근거: ① 심야(00~07시) 실행은 집 회선에서도 일부 사이트가 차단을 걸어 수집량이 0에 수렴(실측: 05시 실행 스냅샷 1건) ② 2시간 주기 launchd 깨움이 맥을 밤새 깨워 배터리를 바닥냄. 야간 글은 08시 실행에서 회수되므로 데이터 손실 미미. 같은 시점 재검토한 클라우드 대안들 — "Vercel + 무료 한국 프록시", "GitHub Actions + 안드로이드 공단말기 프록시" — 은 기각: 무료 한국 주거용 프록시는 존재하지 않고(레지덴셜 프록시는 유료 산업), 공개 프록시는 DC IP라 fmkorea IP 평판·ruliweb TCP 차단을 통과 불가. 공단말기 방식은 추가 단말+포트포워딩(국내 가정 회선 CGNAT 많음)+집 회선 노출 보안 위험.

장기 호스팅 최종 결정(2026-08-26): **지금은 Mac 유지, 인계/상시 가동 시점에 한국 소형 VPS로 이사.** 오라클 재검토 시 조사 결론:
- 오라클 Free Tier는 등록 카드 정보를 삭제할 수 없음(공식 문서 — PAYG 전환 시점에나 변경 가능, 계정 삭제 시에만 소멸). 개인 카드를 회사 프로젝트에 남기는 것은 부적합.
- 홈리전은 영구 고정인데 한국(서울) 리전은 Always Free 용량이 사실상 없어 한국 선택이 불가 → 일본/싱가포르 선택 = 해외 IP = fmkorea/ruliweb 차단으로 Vercel과 동일하게 3/5.
- 따라서 인계 시점에는 **회사 계정·회사 카드로 개설한 한국 IP VPS**(국내 클라우드 무료/소액 플랜)가 정답 — 퇴사 후 개인 부담 없음.

유의:
- `~/dev`는 TCC 비보호 경로라 launchd 접근 가능. 프로젝트를 다시 보호 폴더로 옮기면 재발.
- plist의 PATH에 nvm node 경로를 명시함 — node 버전 변경 시 plist도 수정 필요.
- 이사 도구: `deploy/migrate-to-vps.sh` — Mac에서 대상 서버로 리포+DB+스냅샷을 rsync하고 `setup-vps.sh`를 실행하는 원커맨드 마이그레이션. `deploy/`의 VPS 패키지(systemd timer)와 함께 인계용으로 보존.

### 프론트엔드 실데이터 연결 (2026-08-27) — mock 졸업

`app/page.tsx`가 더 이상 `data/mock/…v0.2.json`을 import하지 않는다. 데이터 흐름: `src/db/queries.ts`의 `getDealFeed()`가 `openDbReadOnly()`(읽기 전용, 파일 없으면 빈 피드)로 posts+deals를 조회해 뷰 타입(`ItemView` — 아이템 기반, 상세는 아래 "프론트엔드 아이템 기반 전환" 섹션)으로 조립 → 페이지는 뷰만 렌더. 표시 형태와 저장 스키마를 분리했으니 디자인 변경은 페이지 마크업만, 노출 기준 변경은 queries.ts만 고치면 된다. `dynamic = "force-dynamic"`이라 매 요청 DB 재읽음 — 수집 결과가 재시작 없이 반영된다.

노출 규칙(현 단계): 상품 1개 이상 파싱된 게시글만, 종료 딜 포함, 진행중·상태 모름 → 종료 순, 마지막 적재 시각 내림차순, 게시글 500개 상한. 툴바 필터/정렬은 퀘이사존형 탭·칩으로 실연결 완료 — 아래 "퀘이사존형" 섹션. 실측 검증: 렌더 카드 수가 DB deals 수와 정확히 일치(※ 이후 아이템 단위 전환으로 카드 수 = 아이템 수 — 아래 섹션). 참고: 초기 검증에서 "구매 링크 없는 카드 114건"으로 보였으나 HTML flight 데이터 중복 집계 탓이었고 실체는 57건 — 아래 섹션에서 조사·수정.

### 구매 링크 누락 조사·수정 (2026-08-27) — url none 57→35

원인 세 갈래:

1. **뽐뿌 그룹핑 버그 (수정)** — "상품명 → `혜택가 218만원대` → [구매하러가기]"가 반복되는 글(오늘의집 모음전 등)에서 마커 붙은 가격 라인이 가격 전용 라인으로 인식되지 않아 멀티상품 그룹핑이 실패 → 옵션 나열 모드로 빠져 **존재하는 상품별 링크가 전부 버려짐**. `groupProductSections`에 마커 가격 라인 처리 추가: `PRICE_MARKER`(혜택가/체감가/판매가 등, `extractSinglePrice`와 공유) 매치 시 가격을 파싱하고, 마커 앞 텍스트가 있으면 상품명으로 취급. 링크가 진짜 없는 옵션 나열(체감가 나열 등)은 기존대로 대표 링크를 물리지 않는다.
2. **루리웹 출처 필드 부재 (수정)** — 작성자가 "출처" 필드를 비우면 본문에 구매 링크가 하나 있어도 `url=null`. 폴백 추가: 출처 링크가 없고 본문 외부 링크가 **정확히 1개**면 그걸 상품 링크로 쓴다(이미지/내부 글 링크는 기존 필터로 제외). 2개 이상이면 임의 선택 금지 원칙으로 그대로 null.
3. **원문에 링크가 진짜 없는 글 (정상)** — 토스 앱 진입형(펨코), 라이브 커머스 옵션 나열(뽐뿌 DMAC: 대표 랜딩만 존재), 멀티링크 이벤트 글(루리웹) 등. 정책대로 유지.

재적재 결과: none 57→35건(7.7%), deals 444→452(그룹핑 복구로 상품 행 증가). 전체 테스트(9종) 통과, 페이지 렌더 대조 일치(링크 없음 카드 35개 = DB). 부수: `tests/fixtures-live/`는 live-crawl-test 실행 시 자동 갱신되는 실황 스냅샷이라 변동분 포함 커밋.

### 프론트엔드 아이템 기반 전환 (2026-08-27) — 카드 단위: 게시글 → 아이템

표시 단위를 딜/게시글에서 **아이템**으로 전환. `getDealFeed()`는 이제 `ItemView[]`를 반환한다(구 `PostView` 폐기): 같은 정규화 구매 URL을 가진 딜은 커뮤니티 무관 카드 1개로 병합, `sources[]`에 출처 게시글(커뮤니티·제목·그 글의 가격·조회수·시각·원문 링크)을 최신 확인 순으로 담는다. 상품 정체성이 커뮤니티 위에 있다는 설계 메모의 1단계 구현.

식별 키 규칙(`productKeyFromUrl`): 스킴 무시·호스트 소문자, 프래그먼트 제거(옵션 앵커는 정체성 아님), 트래킹 파라미터 제거(`utm_*`/fbclid/gclid/igsh/spm/scm 등, 파라미터 정렬), 나머지 쿼리는 보존(식별자가 쿼리에 있는 스토어 대비). 파싱 실패·링크 없는 딜은 병합 불가라 `post:<community>:<id>#<seq>` 키의 단독 카드로 남는다.

대표값 정책: 이름 = 이름 있는 최신 출처, 가격 = 최신 가격 출처의 통화를 기준으로 같은 통화들의 최저가(통화 혼합 최저 금지), 상태 = 출처 하나라도 active면 active.

실측(2026-08-27 데이터): 딜 452장 → 아이템 365장(병합 42, 그중 실제 크로스커뮤니티 25 — 닌텐도 스위치2가 루리웹·아카·퀘이사존 동시 등판 등 / 링크 없음 단독 35). 렌더 대조: article·data-item-key 365, 병합 배지 42, source-row 438, 진행중 143 전부 뷰 함수 출력과 일치.

### 퀘이사존형 리스트 리디자인 + 필터/정렬 실연결 (2026-08-27)

카드형 레이아웃을 퀘이사존 핫딜 목록 스타일의 **리스트 로우**로 교체. 1라인 = 상태 배지(진행중/종료) + 제목(구매 링크, 없으면 원문 링크) + 카테고리 칩, 2라인 = 스토어 · 가격 · 배송비 · 추천합(★) · 경과 시간 · 출처 커뮤니티 링크들. 라이트 모드 기준 — 다크 모드 토글은 추후(`:root` 변수 교체 방식 예정).

**통합 분류 레이어 `src/db/taxonomy.ts`**: 커뮤니티 고유 카테고리명을 통합 카테고리로 매핑(커뮤니티별 매핑 표 + 미매칭/빈 값은 "기타") — 화면 노출 7종: PC/하드웨어 · 게임/하드웨어 · 노트북/모바일 · 가전/TV · 생활/식품 · 패션/뷰티 · 기타, + 수집 제외 3종(아래 "무형 아이템 제외" 섹션): 게임/SW · 상품권/쿠폰 · 포인트/래플. `CATEGORIES`(노출용)와 `ALL_NORM_CATEGORIES`(내부 분류 전체) 분리. 루리웹 게임H/W는 실물 게임기라 게임/하드웨어로 노출 보존, 게임S/W만 제외. 스토어 별칭 정규화(`STORE_ALIASES`: 지마켓/G마켓/GMARKET→지마켓, 알리/알리익스프레스/타임딜 변형→알리, 쿠팡와우→쿠팡, 네이버*/카카오*/토스* 접두 변형 통합). `ItemView`에 `categoryNorm`/`storeNorm` 필드 추가. 애매한 원 카테고리 귀속은 제목 샘플링으로 결정(펨코 모바일/상품권→상품권/쿠폰, 루리웹 PC/가전→PC/하드웨어, 아카 전자제품→가전/TV 등).

**필터/정렬 = URL 쿼리스트링**(서버 컴포넌트라 클라이언트 JS 없음): `?cat=&store=&status=&sort=`. 페이지 진입 시 값 검증(카테고리는 노출 7종 목록, 스토어는 실재 facet, status는 active/ended, sort는 hot/price만 인정 — 나머지는 무시하고 기본값). 툴바 3단: 상태·정렬 탭(전체/진행중/종료 + 최신순/인기순/가격순) → 카테고리 탭(전 카테고리 + 노출 7종) → 쇼핑 칩(전체 피드 기준 스토어 상위권). 탭/칩 링크는 `hrefFor()`로 현재 쿼리 보존한 채 한 축만 교체.

**임시 상태 정책**: `unknown`은 화면에 "진행중"으로 노출하고, 종료가 확인된 건만 "종료" 배지(수집 재확인이 쌓이면 폐기 예정). 필터 `status=active`도 unknown을 포함.

**정렬 규칙**: 어떤 정렬에서도 종료 건은 항상 맨 뒤. 인기순 = `hotScore`(추천수 합 × 1억 + 조회수 합 — 추천이 조회수보다 항상 우선하도록 자릿수 분리), 가격순 = **원화 환산** 오름차순(통화별 고정 환율 상수 `FX_TO_KRW`, 아래 "무형 아이템 제외" 섹션)·가격 없음은 맨 뒤, 최신순 = 마지막 적재 시각 내림차순.

실측 검증(빌드 + 프로덕션 서버 렌더, 스크립트 제거 후 카운트): 루트 365 · 진행중 346 · 종료 19 · 카테고리별 41/37/4/52/158/7/29/2/35(합 365) · 스토어 쿠팡 39/네이버 58 · 3중 조합(생활/식품+쿠팡+진행중) 31 · 조합 정렬 346 — 전부 `getDealFeed()` 뷰 함수 출력과 정확히 일치. 잘못된 파라미터는 전부 기본 피드(365)로 폴백 확인. 종료-항상-마지막 정렬 불변식 확인. (숫자는 무형 제외 적용 전 기준; 적용 후는 아래 섹션.)

### 데이터 정리: 무형 아이템 제외 + 원화 정렬 + 원문 보기 + 통화 교정 (2026-08-27)

**무형 아이템 전면 제외 — 수집 규칙이자 노출 규칙.** 대상: 상품권·기프티콘, 소프트웨어(게임 포함), 프로모션/이벤트 홍보글, 라이브방송 예고글, 항공권·여행 상품(사용자 결정: 무형 원칙으로 함께 제외). 단일 판정기 `src/db/exclusion.ts`(`checkExclusion`)를 3곳에서 공유: ① 인제스트(`scripts/ingest-crawls.ts`) — 딜 단위 필터, 제외 후 남은 딜 수로 `products_count` 기록 → 전부 제외된 글은 워커 동결 조건(`products_count=0`)에 걸려 재확인 중단. ② 뷰 레이어(`queries.ts`) — 과거 데이터 방어. ③ 일회성 정리 `scripts/purge-excluded.ts`(`--dry-run` 지원) — 기존 DB 삭제 + `products_count` 재계산. 실측: 523 딜 중 112건 삭제(카테고리 97 · 홍보 제목 8 · 여행 제목 2 · 0원 5), 아이템 365→347.

판정 순서: 제외 카테고리(게임/SW·상품권/쿠폰·포인트/래플) → 가격 0원 → 홍보 제목 정규식 → 여행 제목 정규식. **키워드 안전 규칙**: 맨 단어 "이벤트/라이브/적립"은 금지 — 실데이터 검증 결과 해당 단어 포함 실물 딜이 전부 존재(예: "라이브 구매시" 포함 손목시계 딜). 그래서 홍보 판정은 구체적 조합만 잡는다(소문내기·관심고객·출석·퀴즈·응모·종합/적립 차트·쇼핑라이브·라이브 예고·방송 예정·멤버십 데이·게시판 규정·공지사항·필독·선착순 쿠폰 등). 여행 판정도 "항공권/왕복/편도/숙박권/렌터카/이용권/입장권/공항-도시-날짜 패턴"만 사용하고 맨 단어 "여행"은 금지(캐리어 등 실물 방지). 가격 `null`은 제외 아님(정보 부족일 뿐).

**퀘이사존 공지 유입 정리**: `qb_saleinfo` 게시판 핀 고정 공지("핫딜 게시판 규정")가 과거에 가짜 딜(￦7,777,777, 게시판 URL이 구매 링크)로 적재됐던 잔재. 수집기의 공지 필터(`notice_ids`)는 실동작 확인 — 유입은 과거 DB 잔여분. 파서에 게시판 내부 URL 가드 추가(`quasarzone.com/bbs/*`는 구매 링크로 인정 안 함), 공지 글은 홍보 제목 판정으로 purge에서 제거.

**통화 교정 가드(퀘이사존 파서)**: 원인은 폼에 "￦ 6.82 (KRW)"로 입력된 외화 금액 — 글쓴이가 달러를 적고 통화 기본값 KRW를 안 바꾼 케이스. 규칙: 소수점 있는 "KRW" 가격은 오기재로 간주(원화는 보조 단위 없음) → 제목·본문 증거(달러/USD/$, 위안/元, ¥/엔, €/유로)로 교정, 증거 없으면 스토어가 알리면 USD, 그것도 없으면 유지(추측 금지). 실측 교정: 상품 1005012887056846(본문 "10달러" 증거) → $6.82.

**가격 정렬 = 원화 환산 오름차순.** `queries.ts`에 정렬 전용 고정 환율 `FX_TO_KRW`(2026-08-27 기준: USD 1385 · JPY 8.7 · CNY 205 · EUR 1615, 표시는 원문 그대로). 렌더 검증: $6.82(≈9,446원)가 9,430원/9,500원 사이에 위치, ¥14,948(×8.7≈13만)/¥107,800(≈93.8만) 제 위치, 무가격 맨 뒤·종료 항상 마지막 불변식 유지.

**원문 보기 버튼**: 카드 2라인에 `원문 보기` 추가 — 커뮤니티명 칩이 필터로 오인된다는 사용자 지적에 따라 원문 이동을 전용 버튼으로 분리. 복수 커뮤니티 병합 아이템은 `firstSource` = 게시 시각(`posted_at`, 없으면 최초 수집 시각)이 가장 빠른 출처로 랜딩. 제목 링크도 동일 대상(`item.url ?? item.firstSource.sourceUrl`).

실측 검증(적용 후): 루트 347(진행중 332 · 종료 15) · 원문 보기 앵커 347/347 · 카테고리 탭 7종(제외 카테고리 노출 없음) · `?sort=price` 원화 환산 단조 증가 확인 — 전부 뷰 함수 출력과 일치.

### 뽐뿌 가격 오류 수정 + 스토어 필터 로고·고정 순서 (2026-08-27)

**뽐뿌 마커 라인 가격 파싱 규칙(버그 수정)**: 증상 — 303707 "대왕오징어"가 제목 5,400원인데 1,000원으로 노출. 원인은 마커 라인 전체에서 첫 단위 토큰을 채택한 것: "네멤이면 적립금 1,000원정도 있어서 체감가 4천원대"에서 적립금 1,000원이 이겼다. 수정: `PRICE_MARKER`(혜택가/체감가/판매가…) 매치 후 **마커 위치 이후 구간만** 파싱(`line.text.slice(markerMatch.index)`) — 마커는 라벨이고 가격이 뒤에 오며, 마커 앞 숫자 토큰(적립금·쿠폰액·정가)은 보조 정보. 3곳 동일 적용(`extractSinglePrice`, `groupProductSections`, `findVariantPriceLines` — 변형 가격 라인의 이름은 마커 앞 구간). 마커 뒤 파싱 실패 시 타이틀 가격 폴백(303707은 "(5,400원/무료)"에서). 회귀 테스트 `tests/price-marker-regression-test.ts`: 303707 → `[5400]`, 303702(렌탈 다중상품) → 9개 모델 가격(링크 없는 마지막 모델은 비그룹 유지).

**일회성 DB 수리**: `scripts/repair-ppomppu-prices.ts`(`--dry-run` 지원) — 저장된 스냅샷을 수정된 파서로 재파싱해 가격이 바뀐 딜만 `deal_price/currency/price_text/raw_price` UPDATE. 실측 4행(303707→5400, 303702 seq0–2→59,400/59,600/80,200), 수리 후 전체 감사 0건. 향후 수집분은 수정된 파서가 커버.

**스토어 필터 = 고정 목록 + 로고.** 동적 facet(top 12) 폐기, 사용자 지정 고정 18종: 전체, 알리익스프레스, 쿠팡, 네이버, 토스, 11번가, 지마켓, 옥션, SSG, 카카오톡딜, 오늘의집, 무신사, 컬리, 롯데온, 다나와, 아마존, 타오바오, 테무, 기타(`taxonomy.ts`의 `STORE_FILTERS` + `OTHER_STORE_FILTER`). 칩은 로고 이미지만 표시(`public/store-logos/*`, `/store-logos/*`로 서빙), 활성은 배경이 아닌 테두리 링(로고 가시성 유지).

별칭 정규명 변경: **정규 표기 = 필터 라벨**. 알리 계열 → "알리익스프레스"(구 "알리"), 카카오/카카오톡/톡딜 → "카카오톡딜"(구 "카카오"), 기타 스토어는 그대로. **"기타" 필터는 캐치올** — 목록 밖 스토어 + 스토어 없는 아이템 전부(하이마트·애플스토어·스팀·null 등). `storeNorm`은 뷰 레이어에서 계산되므로 별칭 변경에 DB 마이그레이션 불필요.

실측 검증: 스토어별 렌더 카운트 = 뷰 출력과 일치(알리익스프레스 24 · 쿠팡 46 · 네이버 55 · 토스 28 · 11번가 12 · 지마켓 30 · 옥션 4 · SSG 3 · 카카오톡딜 7 · 오늘의집 21 · 무신사 1 · 컬리 0 · 롯데온 17 · 다나와 9 · 아마존 3 · 타오바오 0 · 테무 0 · 기타 87, 합 347). 목록 밖 값·구 라벨(?store=알리)은 전부 347 폴백. 주의: 검증 시 한글 파라미터는 `curl -G --data-urlencode` 필수(그냥 넣으면 0건으로 오진).

### 뽐뿌 공구형 대괄호 라벨 파싱 수정 (2026-08-27)

**증상**: 303722 "2026 LG그램" 공동구매 글에서 `[공구혜택가 125만]` 같은 가격 라벨의 `[공구` 파편이 상품명으로 잡히고, 링크 없이 5개 상품이 변형 모드로 빠져나감. 실제 상품명은 라벨 아래 줄(`2026 LG그램북 16 ...`)이다.

**원인 체인**: 대괄호 라벨이 `PRICE_MARKER`의 혜택가에 매치 → 마커 앞 구간(`[공구`)이 이름 후보가 됨 → 라벨 뒤 진짜 상품명 라인이 `pendingPrice`를 리셋해 그룹 성립 실패 → 유효 그룹 0개 → `findVariantPriceLines` 변형 모드 폴백 → 이름 `[공구`, `url:null`, `urlType:"none"` 5개.

**수정(3곳)**: ① `PRICE_MARKER`에 `공동구매혜택가|공구혜택가` 변형 추가. ② `isBracketLabel()` — 라인 전체가 `[...]` 하나에 감싸이면 **섹션 헤더 라벨**. 라벨이면 앞서 쌓인 `pendingName`을 버리고(홍보 문구 취급) `awaitingName=true`; 라벨 뒤 첫 텍스트 라인만 상품명 채택(후속 스펙 라인은 무시), 링크가 그룹 확정·상태 리셋. 마커 앞에 인라인 이름이 있는 기존 패턴(라벨 아님)은 ①번 분기로 무변경. ③ `findVariantPriceLines`도 대괄호 라벨이면 이름을 `null`로(파편 이름 금지).

**회귀 케이스 등록**: `tests/fixtures/ppomppu-303722.html`(수집 스냅샷과 md5 동일). `tests/price-marker-regression-test.ts`를 이름·가격·링크 접미사 3필드 검증으로 확장, 303722 기대값: 가격 `[1250000,1490000,1560000,1590000,1930000]` + 이름 5개 + `smartstore.naver.com/bestcnfshop/products/{id}` 5개. 303707·303702 기존 케이스 무영향 통과.

**수리 스크립트 일반화**: `scripts/repair-ppomppu-prices.ts` → `scripts/repair-ppomppu-deals.ts`(`git mv`). 가격 필드만 수리하던 것을 인제스트 upsert와 동일한 파서 파생 필드 전체(상품명·카테고리·스토어·item_id·가격·배송·URL·url_type·할인) 동기화로 확장, `--dry-run` 지원, 딜 개수 불일치 게시글은 건너뜀. 실측: 303722 ×5(상품명+링크 복원) + 303702 ×3(raw_price를 인제스트 시맨틱인 null로 환원) = 8건 수리, 재감사 0건. 뷰 레이어 확인: 아이템 375개 중 LG그램 5로우 이름·가격·스마트스토어 링크 정상, `[공구` 잔존 0.

### 디자인 시스템: shadcn + Tailwind 토큰 (2026-08-27)

v0 시안 이식을 위해 shadcn 도입(radix base·nova 프리셋, `components.json`·`lib/utils.ts`·`components/ui/*`: button/badge/card/tabs/select/skeleton/separator). **컬러웨이 = `app/globals.css`의 `:root` 토큰 블록 한 곳** — 기존 라이트 팔레트를 shadcn 시맨틱으로 매핑해 초기값으로 사용(`--primary` #111, `--muted-foreground` #777, `--background` #f5f5f3, `--muted/--accent/--secondary` #f0f0ed). 테마 에디터(ui.shadcn.io/themes) 출력으로 이 블록만 swap하면 전체 컴포넌트가 따라감. 기존 커스텀 CSS(로우/칩 클래스)는 비레이어로 공존 — 구 시맨틱 참조는 `--primary`/`--muted-foreground`로 개명 완료, 렌더 무변경 검증(375 로우). v0 산출물은 동일 토큰·동일 컴포넌트 가정 하에 **표현층만** 이식(데이터 레이어 `getDealFeed` + 쿼리스트링 계약 유지). `.dark` 블록은 shadcn 기본값 대기 중(다크 모드 태스크).

## 향후 프론트엔드 설계 메모

- **[1단계 완료]** 아이템 카드 병합 — 정규화 URL 기반(위 섹션). 남은 단계: **아이템 ID 매칭** — 같은 상품을 가리키는 서로 다른 URL(스토어별 링크, 단축링크 변형)까지 병합. 수집 시 파서가 남기는 item_id 신호가 재료.
- **[필터/정렬 완료]** 상태·카테고리·스토어 필터 + 3종 정렬이 쿼리스트링으로 실연결(위 "퀘이사존형" 섹션). 남은 축: **커뮤니티 탭** — 설계 원칙: 각 커뮤니티 탭에서도 동일 아이템 카드가 보이고 커뮤니티는 카드의 속성 목록으로 남는다. 그리고 **다크 모드 토글**(`:root` 변수 교체).
- **최저가 히스토리 = 상단 내비 두 번째 탭** (v0 시안 2026-08-27에서 mock 버튼으로 배치 확정 — 실구현은 추후). `price_observations`(append-only) 재료가 이미 쌓이는 중. 상세 뷰와 연계 설계.
- 페이지네이션 — 현재 게시글 500개 상한 조회 후 아이템 조립.

## 배포 방향 (2026-08-27)

- 디자인 확정 전까지는 Vercel 무료 플랜으로 빠르게 배포.
- 이후 국내 서비스 무료 플랜 대안 검토(국내 IP가 크롤러/WAF에 유리).
- 수집 데이터는 OSINT 정제물이라 외부 호스팅에 보안 리스크 없음.
- 단, 수집 워커는 Vercel 서버리스에 올리지 않는다 — 실측(2026-08-26)으로 fmkorea 430(IP 평판 WAF)·ruliweb TCP 차단 확인. 3/5만 수집 가능해 최대 출처가 빠지므로 부적합(상세: "주기 수집 스케줄링" 섹션).

### 배포 파이프라인 (2026-08-27) — 수집 주기 = 배포 주기

`run-pipeline.sh` 4단계가 자동 배포로 이어진다: ingest 성공 시 ① `scripts/freeze-db.ts`로 DB 스냅샷 고정 ② `data/hotdeal.db` 커밋·푸시(리포=백업) ③ `vercel deploy --prod --yes`. 배포 실패는 수집 실패와 분리해 로그·종료코드 전파.

**절대 규칙 — 배포 전 `freeze-db.ts`(WAL → 롤백 저널)를 반드시 거쳐야 한다.** 실측 장애(2026-08-27): WAL 모드 DB를 읽기 전용으로 열려면 `-shm` 보조 파일이 필요한데, 보조 파일 없이 `hotdeal.db`만 배포되자 읽기 전용 파일시스템인 Vercel serverless에서 `unable to open database file`(CANTOPEN)로 전 페이지가 죽었다. 보조 파일이 함께 업로드된 과거 배포는 우연히 동작했던 것. 롤백 저널(`PRAGMA journal_mode=DELETE`) DB는 단일 파일로 읽기 전용 열람이 가능하다. 로컬 운영은 영향 없음 — `openDb()`가 수집 시 다시 WAL로 전환한다. 수동 배포 시에도 `npx tsx scripts/freeze-db.ts`를 먼저 실행할 것.

기타 배포 고정값: `vercel.json` 미사용(`nodeVersion` 필드는 미지원이라 에러 유발 — 폐기함), 노드는 `package.json "engines":{"node":"22.x"}`로 고정. DB는 `.gitignore` 제외(커밋 대상) + `next.config.ts outputFileTracingIncludes`로 serverless 번들 포함. `vercel deploy` 업로드는 `.gitignore`를 무시하므로 대용량 디렉터리도 같이 올라간다(불필요 분은 `.vercelignore`로만 제외 가능).

### v1.1 데이터 품질 수정 + 리브랜드 (2026-08-27)

**리브랜드**: 앱명 "사우론의 눈 / EYE OF SAURON". 로고 `public/sauron-eye.png`(사이드바 `img.brand-logo`), 파비콘은 `app/icon.png`(App Router 파일 컨벤션 — 기존 `app/favicon.ico`는 폐기·Trash). 메타데이터 타이틀 템플릿 동일 파일에서 갱신.

**액션 버튼**: 핫딜 모음 로우 우측 `.row-actions` — 원문링크(`.btn.primary`, 테마 블루 `var(--primary)`)= 첫 출처 게시글 URL, 구매하기(`.btn.ghost` 흰색)= 구매 URL(없으면 `.disabled` 스팬). 순위 테이블은 맨 오른쪽 8번째 그리드 컬럼에 원문링크(`.btn.primary.sm`). 제목 링크는 원문 게시글로 통일(구매 링크는 버튼과 분리).

**순위 필터**: /ranking에도 카테고리+쇼핑몰 칩(쿼리스트링, 홈과 동일 `hrefFor`). 화면 라벨 "스토어" → "쇼핑몰" 전면 변경.

**무형 제외 보강** (`exclusion.ts`): ① `SOFTWARE_TITLE` 신설(윈도우 1[01]·office/microsoft 365·한글 20xx·adobe·라이센스·정품 키·게임 패스 — "정품"/"윈도우" 단독은 실물 수식어라 금지). ② `TRAVEL_TITLE` 보강: 항공사명 단독(이스타항공 등), 하이픈 경로 단독(인천-오사카 — 날짜 선후 무관), 월일 범위(9월8일~10일). ③ `PROMO_TITLE`에 다운로드 쿠폰/쿠폰 정리 추가. 실측 4건(이스타항공·인천-도쿄·윈도우11 홈·다운로드 쿠폰 정리) — `purge-excluded.ts` 재실행으로 삭제, 오탐 0.

**카테고리 재분류** (`taxonomy.ts`): 네이티브 맵 누락 보완(ruliweb 휴대폰→노트북/모바일, ppomppu 패션/뷰티·의류→패션/뷰티). `normalizeCategory(community, raw, title?)`로 시그니처 확장 — 통합 분류가 "기타"일 때만 `TITLE_CATEGORY_RULES`(보조배터리/충전기→노트북/모바일, 샴푸/바디워시/토너→패션/뷰티, 세제/치약/김치/생수→생활/식품)로 제목 기반 재분류. 호출부 3곳(queries·exclusion·history) 전부 title 전달. 기타 탭 37→10(남은 것은 취미/장난감/모음글).

**룰리웹 맨 가격** (`ruliweb.ts` `consumeBareWon`): 괄호/슬래시 밖 "N원" 토(쉼표 자리구분 또는 4자리 이상, 뒤에 적립/쿠 붙으면 포인트 문구라 스킵)을 가격으로 채택. 예: "앤커 프라임 보조배터리 + 충전베이스 151,829원".

**펨코 종료 마커** (`fmkorea.ts` `extractStatus`): `div[class*="hotdeal_var"]`(접미사 세션가변) 텍스트에 "종료" 있으면 즉시 ended — 마커가 `<article>` 밖 `.rd_body` 직하에 있어 본문 스캔으로는 못 잡던 것.

**스냅샷 리페어** (`scripts/repair-snapshots.ts`, `--dry-run`): data/crawls 전 run을 시간순 재파싱 — ① status ended 승격만(강등 금지) ② 가격은 저장 딜과 seq 개수 일치 시 null→파싱값 보강 + observation 기록. 실측: 승격 15건·가격 5건. 인제스트와 동일 제외 필터로 seq를 맞춘 것이 핵심(개수 불일치 글은 스킵).

### v1.2 커뮤니티 필터 + 필드형 상품명 + 다나와 썸네일 (2026-08-27)

**커뮤니티 필터**: `taxonomy.ts`에 `COMMUNITIES`(5종) + `COMMUNITY_LOGOS`(`public/community-logos/*`). 홈·순위표 둘 다 `?community=` 쿼리스트링 칩, `getDealFeed`는 `sources.some(s => s.source === com)` 필터(병합 아이템은 어느 한 커뮤니티 소속이면 노출).

**인기 점수 표기**: 순위표 점수 숫자 제거 — 1위 대비 상대 비율 프로그레스바만 표시(최소 폭 4%). 마우스 오버 툴팁에 조회수·추천·댓글 원문 숫자. 숫자 자체의 스케일(추천×1e8)이 외부 독자에게 해석 불가라 내린 결정.

**필드형 상품명 표시** (`name.ts` `splitNameParts`): 정제된 표시명을 `main` + 수량/구성 미사로 분리 — 개수 단위(통·개·박스·팩…18종), 중량(총 N kg/g/L), N+N 번들, "개당" 파생. `ItemView.displayParts`로 전달, 렌더는 `main` + `.name-qty` 스팬(없으면 스킵). 브랜드/옵션명/품목넘버는 프리텍스트에서 신뢰 추출 불가라 분리 안 함 — 파서·DB는 원본 유지. **검색은 계속 원본 데이터**(아이템 이름 + 출처 게시글 제목) 대상이라 표시명과 무관하게 동작.

**다나와 썸네일 폴백** (`fetch-thumbnails.ts` 2단계): 프론트 실시간 조회는 불가(다나와가 ~3.5MB 페이지를 SSR·CORS 미허용)라 수집기에서 검색해 `product_images`에 캐시. 대상은 가전/디지털 4개 카테고리만(다나와 카탈로그 범위) — 직접 링크는 og:image 3회 소진 후, 제휴/리다이렉트는 즉시. 검색어 = `splitNameParts(cleanDisplayName()).main`, 결과 상품명과 토큰 중복률 ≥50%(토큰 2개 이상일 때만) 채택. `attempts=4` = 다나와 시도 완료 마커(스키마 변경 없이 기존 컬럼 재활용), 3초 스로틀, `--danawa-limit`(기본 10, 파이프라인은 그대로).
파싱 함정 실측: 페이지에 빈 광고 슬롯(`li class="prod_item"` 정확히 일치)이 섞여 있어 정확히 일치 클래스만 찾으면 "결과 없음" 오진 — 실제 결과는 `class="prod_item width_change searched"` 복합 클래스 + `data-product-order` 속성. 복합 클래스로 분할하고 유기 블록을 우선한다. 첫 백필 실측: 후보 88건 중 14건 채택(거절 사유는 검색 무관 결과·결과 없음 — 게시글 제목이 상품명인 케이스).

**표시 폴백 체인**: 타일/썸네일 = 상품 이미지(`product_images`) → 원문 커뮤니티 로고 → 스토어 로고. 홈 타일·순위표 동일.

**`.vercelignore` 신설**: `vercel deploy` 업로드가 .gitignore를 무시해 매 배포 ~300MB가 올라가던 것 차단 — onlook(112M), data/crawls(170M), collector/.venv(21M), tests(10M), 로그·잠금·WAL 보조파일 제외. `data/hotdeal.db` 본체는 제외 목록에 넣으면 안 된다.

### v1.3 타임존 고정 + 종료 스윕 + 히스토리 원문 링크 (2026-08-28)

**시간 표시 KST 고정** (`format.ts`): `formatTime`에 `timeZone: "Asia/Seoul"` 고정. 로컬 Mac은 KST라 정상 노출됐지만 Vercel serverless는 UTC라 9시간 어긋나 보이던 문제. `timeAgo`는 시각차 기반이라 원래 안전.

**종료 딜 재검증 스윕** (`collect.py --sweep-ended`, `run-pipeline.sh`가 08시·22시 런에 자동 부여): 종료 게시글 원문을 재수집해 재개장된 딜을 되살린다. 상품이 있는(products_count>0) 종료 글만, 최근 확인순, `--sweep-limit`(기본 500). 스냅샷은 일반 상세 수집과 동일한 형식이라 인제스트가 같은 파서로 재판정 — 페이지에서 종료 신호가 사라졌으면 승격, 여전하면 ended 유지. 스윕 중 챌린지는 해당 커뮤니티 스윕만 중단(전체 run 상태는 유지).

**삭제 게시글 오검출 수정**: 삭제된 글 안내 페이지(퀘이사존 "글이 존재하지 않습니다" 등)에 Cloudflare 비콘 스크립트가 심겨 있어, 작은 페이지+CF 마커 챌린지 휴리스틱이 오검출 → 커뮤니티 수집 전체가 중단될 뻔한 결함. `is_gone_post()`를 챌린지 판정 앞에 두고 삭제 안내 문구(8종) 매치 시 "삭제 — 동결/종료 유지"로 처리. 일반 상세 수집 루프에도 동일 적용.

**최저가 히스토리 원문 링크**: 상세 화면 최고가·최저가 카드의 관측 시각에 원문 게시글 링크(점선 밑줄 + 외부링크 아이콘). 딜 1행 = 게시글 1개라 관측 시점과 무관하게 해당 글이 원문.

**대왕오징어 1000원 수리**: 303707 마커 라인 버그 시점(파서 수정 전)에 기록된 관측 1건(1000원=적립금 오독)이 히스토리에 남아 있었음. 전수 감사로 유일한 오염 확인 → 실제 가격 5400원으로 수정. 딜 자체는 이전 `repair-ppomppu-prices.ts`로 이미 수리된 상태였음.

**커뮤니티 로고 정방형 교체**: 사용자 제공 250×250 PNG(ppomppu·arca는 jpeg→png 확장자 변경, COMMUNITY_LOGOS 경로 갱신).

### v1.4 로컬 어드민 — 오버라이드 레이어 + 5메뉴 (2026-08-28)

**게이트**: `ADMIN_MODE=1`일 때만 어드민이 열린다(`src/lib/admin-gate.ts`). 페이지는 레이아웃에서 `notFound()`, API는 `adminGate()`로 404. 프로덕션(Vercel)은 환경변수 미설정이라 입구 자체가 없다. 쓰기 어드민은 로컬 전용 — 현재 쓰기 가능 DB는 수집기가 도는 맥에 있고, 수정분은 2시간 주기 파이프라인의 DB 커밋+배포로 자동 반영된다.

**오버라이드 레이어 원칙**: 파서 값 컬럼(`product_name`, `deal_price`, `category`, `store`, …)은 인제스트가 계속 갱신하고, 수동 수정은 `*_override` 컬럼에만 쓴다. 노출은 `queries.ts`가 오버라이드 우선으로 합성. "잠금·스킵" 방식은 수집기 갱신이 멈춰 값이 영원히 고이는 문제가 있어 기각. 파서 최신값 ≠ 오버라이드인 행이 곧 검토 큐(어드민 "수동수정 있음" 필터). 쓰기 계층은 `src/db/admin.ts` 한 곳으로 모아 변경 필드 단위 감사 기록(`admin_audit`).

**제외 딜 기록**: 인제스트가 제외 딜도 `excluded_reason`(category|zero-price|promo-title|software-title|rental-title|travel-title)과 함께 적재한다(전엔 스킵). 복원 = `exclusion_restored=1` + 사유 해제 → 인제스트가 다시 제외하지 않고 관측도 계속. 복원 시 사유가 지워지므로 제외 탭 쿼리는 `excluded_reason IS NOT NULL OR exclusion_restored = 1`(복원 철회 입구 보존). 복원 철회 = 마커 해제뿐 — 실제 재제외는 다음 인제스트의 규칙 재판정.

**관측 오염 정정**: 가격 오버라이드는 표시값에만 영향, `price_observations`는 사실 기록으로 유지. 오염 관측 자체는 행 단위 수정·물리 삭제로 제거(삭제 확정).

**메뉴**: ① 핫딜 카드 관리(`/admin/deals`, 행 단위 목록+상세 편집기) ② 썸네일 관리(`/admin/thumbnails`, 상품 키 단위·수동 URL/해제/캐시 초기화 — `fetch-thumbnails`는 `image_override` 있는 키 자동 수집 스킵) ③ 제외/미분류 상품 관리(`/admin/excluded`, 복원·카테고리 지정) ④ 택소노미(읽기 전용 — 분류는 계속 코드가 단일 진실 소스) ⑤ 로그(플레이스홀더 — 한국 VPS 이전 시 오픈, 그동안 기록은 `admin_audit`에 누적).

**주의할 구현 디테일**: `/admin` 인덱스는 `force-dynamic` — 정적 프리렌더가 빌드 시점(게이트 꺼진 상태) 404를 굽던 문제. 어드민 API 라우트는 쓰기 전용이지만 `GET` 핸들러가 무조건 404를 돌려 게이트 꺼진 상태에서 405로 라우트 존재가 새는 것을 막는다. `deals`/`posts`의 `hidden`은 노출에서만 숨김(행·관측 보존).
