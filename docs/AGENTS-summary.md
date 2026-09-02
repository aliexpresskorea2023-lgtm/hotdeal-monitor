# Hotdeal Monitor 요약본 (인계용)

> `AGENTS.md`(날짜별 결정 로그, ~450줄)의 주제별 압축본. **현재 상태** 기준.
> 세부 근거·실측 수치·변경 이력은 원본 `AGENTS.md` 참조. 최종 갱신: 2026-09-02.

## 1. 한 줄 개요

국내 핫딜 커뮤니티 5곳을 주기 수집해 정제·병합·노출하는 모니터링 서비스. 앱명 **"사우론의 눈 / EYE OF SAURON"**.

- 프로덕션: https://hotdeal-monitor-drab.vercel.app
- 스택: Next.js 16(Turbopack) + `node:sqlite`(드라이버 무설치) + Python 컬렉터. Node 22.x.
- 리포: GitHub private `aliexpresskorea2023-lgtm/hotdeal-monitor`, 브랜치 `v1-ui`.
- 성격: OSINT 정제물이라 외부 호스팅 보안 리스크 없음. 개인 사이드 프로젝트로 이관 가능하게 설계(호스팅·DB 형태 무관 로드맵).

## 2. 데이터 흐름 (핵심 아키텍처)

```
collector/collect.py (Python, 수송 전용)
  → data/crawls/<run-id>/<community>/<postId>.html + manifest.json  (스냅샷, append-only, gitignore)
  → scripts/ingest-crawls.ts (Node)
      → src/parsers/*  (순수 함수: HTML 문자열 → Deal[])
      → src/normalize.ts
      → src/db/exclusion.ts (제외 판정)
      → data/hotdeal.db  (posts / deals / price_observations)
  → src/db/queries.ts getDealFeed() → ItemView[]  (표시 계층 조립)
  → app/*/page.tsx  (렌더만, force-dynamic)
```

**분업 원칙**: 컬렉터는 파싱을 일절 하지 않고 HTML 스냅샷만 저장. 파싱은 TS 순수 파서가 담당(수송/파싱 분리). 표시 형태와 저장 스키마 분리 — 디자인 변경은 페이지 마크업만, 노출 기준 변경은 `queries.ts`만.

**파서 규칙**: 실패 시 null(추측 금지), 없는 이름 창작 금지, 파서 내 네트워크 fetch 금지, 번호 섹션 분할은 가격+URL 모두 있을 때만. `product.name`은 nullable. `urlType` enum: direct|redirect|affiliate|javascript|app|none|unknown.

## 3. 수집 대상 커뮤니티

확정 5곳: **fmkorea, ppomppu, ruliweb, quasarzone, arca**.

- 전송 계층 표준: **Python `curl_cffi` `impersonate="chrome"`** 단일 구현. quasarzone/arca의 Cloudflare 챌린지가 TLS/HTTP2 지문 기반이라 지문 모방으로 통과. Node 단독 지문 모방은 신뢰 라이브러리 부족으로 비권장.
- 사이트별 파서 노트:
  - **ppomppu**: EUC-KR 인코딩. 정형 폼 없음 → 자유형. **복수 상품/옵션 나열 글은 수집 중단**(2026-09-02, 아래 §10).
  - **fmkorea**: 자체 WAF(IP 평판). 핫딜/13, srls. 보수적 스로틀.
  - **ruliweb**: board 1020, `div.source_url` 출처 링크, `link.php?ol=` 래핑 언래핑.
  - **quasarzone**: `goToLink('<base64>')` 래핑, 상태는 `h1.title span.label`(`label done`=종료, `label mint`=인기글이라 상태 신호 아님). **v2 뷰 템플릿** 혼재(레거시/v2 셀렉터 둘 다 처리 + `og:title` 폴백).
  - **arca**: `unsafelink.com/` 프리픽스 언래핑, `<exchange data-currency data-value>` 정형 가격 힌트, 등록일 UTC→+09:00, `ko` Accept-Language 필수(스탯 라벨 한국어).
- 제외: mlbpark·theqoo(글 적고 자유형), slrclub(404/서비스 종료). `types.ts` 유니온은 하위호환 유지, 파서·크롤러 없음.
- 봇 방어 준수: 미형성/성인/삭제글 스킵, WAF HTML 저장 금지. Managed Challenge 판정 = 403/503 + "Just a moment" + (보조)마커 포함 & <64KB(마커 단독 오탐 주의 — 통과 페이지에도 `__CF$cv$params` 주입됨). 공지/규정글 제외.

## 4. DB 스키마 (`src/db/schema.sql`, `data/hotdeal.db`)

- `posts` — (community, post_id) 유일. 재삽입 없이 상태/stats 갱신. `products_count=0` = 폼 미입력/자유형/전부 제외 → 워커 동결 조건.
- `deals` — (post_rowid, seq) 유일 제자리 upsert. 1게시글 N상품. `item_id`(ali/coupang 등) 보존(병합 1차 후보 신호).
- `price_observations` — append-only 시계열. 가격/배송/추정원화/상태가 직전과 다를 때만 행 추가(조회수 같은 연속 변동은 관측 안 만듦). ended 전환 시점도 기록.
- `ingest_runs` — run 중복 적재 방지 원장.
- 보조 테이블: `link_resolutions`(단축링크 해석, 병합 키 전용), `link_checks`(구매링크 사망 판정), `product_images`(썸네일 캐시), `product_clusters`(예정, §12), `admin_audit`(어드민 변경 감사).
- **종료 딜도 수집** — 최저가 히스토리의 가장 값진 데이터. 프론트는 active 우선 노출, DB는 전부 보존.

적재: `npx tsx scripts/ingest-crawls.ts` (멱등). **ingest upsert는 `COALESCE(NULLIF(excluded.x,''), table.x)` 가드** — 나쁜 파싱이 기존 좋은 값을 못 지우게(제목/posted_at/상품명/카테고리/스토어). 가격·상태·카운터 등 시간가변 사실은 무조건 갱신.

## 5. 파이프라인 & 스케줄링

단일 진입점 `collector/run-pipeline.sh [collect.py 옵션]`, 5단계:
1. collect (Python)
2. ingest (Node) — collect가 부분 차단이어도 반드시 실행(미적재분 캐치업)
3. 링크 후처리: resolve-links(30/회) → fetch-thumbnails(40/회) → (스윕 시간대만) check-dead-links(40/회)
4. freeze-db (WAL→롤백 저널) + 커밋·푸시
5. 해당 커밋의 git 배포를 프로덕션으로 promote

- collect.py 증분: ended/products=0 → 동결 스킵, active/unknown → `--recheck-hours`(기본 12h) 내 재확인 완료면 스킵. 스킵은 `--max-details` 예산 미소모(예산은 전부 새 글에).
- 종료 스윕: `--sweep-ended`(08시·22시 런 자동) — 종료 글 재수집해 재개장 딜 승격.
- 스케줄: **로컬 Mac + launchd, 08~22시 매 2시간(하루 8회)**, `--pages 1 --max-details 40`. plist `com.beomjun.hotdeal-monitor.pipeline`. mkdir 잠금으로 중복 방지(진행 중 exit 75). 로그 `data/logs/pipeline.log`.
- **한국 IP 필수**: fmkorea는 IP 평판 WAF(430), ruliweb은 해외/DC IP TCP 차단 → Vercel 서버리스는 3/5만 가능. 무료 한국 IP = 사용자 Mac 가정 회선이 유일. 클라우드 대안(무료 한국 프록시/공단말기)은 전부 기각.
- 야간 백필: `collector/backfill-nightly.sh`(22:35, nohup+caffeinate) — 날짜 기반 증가 깊이로 매일 조금씩 과거로. 1년 도달 시 자동 종료 예약(2027-09-12).
- 장기 호스팅: 인계/상시 가동 시점에 **회사 계정·카드로 개설한 한국 IP VPS**로 이사(`deploy/migrate-to-vps.sh`). 오라클 Free는 카드 삭제 불가 + 한국 리전 용량 없음으로 부적합.

## 6. 배포 (Vercel)

- **절대 규칙: 배포 전 `scripts/freeze-db.ts`(WAL→롤백 저널) 필수.** WAL DB는 `-shm` 보조파일 없이 읽기전용 Vercel에서 CANTOPEN으로 전 페이지 사망. 롤백 저널(`journal_mode=DELETE`)은 단일 파일로 읽기전용 열람 가능.
- **로컬 서버 레이스 주의**: `next dev`/`next start`가 떠 있으면 렌더마다 `openDb()`가 헤더를 WAL로 되돌림 → freeze 직후 업로드는 레이스. 안전 절차 = freeze → `data/hotdeal.db` 커밋·푸시 → API로 `source=git` + `meta.githubCommitSha` 일치 배포 찾기 → `vercel promote <dpl_uid> --yes`(빌드 5~7분). 커밋 스냅은 동결 상태라 레이스 없음. (사용자 터미널 dev 서버 임의 kill 금지.)
- Vercel 인증: OAuth 토큰(`~/Library/Application Support/com.vercel.cli/auth.json`) ~2일 만료 → "Not authorized". 파이프라인이 `vercel whoami` 워밍업으로 refreshToken 재발급 트리거. refreshToken도 죽으면 `vercel login` 수동.
- 사내망 `git push` 차단 폴백: `scripts/api-push.ts`(GitHub Git Database API로 blob→tree→commit→ref 재구성, SHA 대조). run-pipeline 5단계가 자동 호출.
- Hobby 한도: 100배포/일, 60/5분. `vercel.json` 미사용(nodeVersion 미지원), node는 `package.json engines`로 고정. `.vercelignore`로 대용량 디렉터리(onlook/data/crawls/.venv/tests) 제외 — 단 `data/hotdeal.db` 본체는 제외하면 안 됨.
- D1 백엔드(이주 중): `DB_BACKEND=d1` 토글(`src/db/driver.ts` + `d1.ts` REST 어댑터). 커트오버 2026-09-03, 안정화 9/4. Node 동기 브리지 = SharedArrayBuffer + Atomics.notify(MessagePort는 Atomics.wait 중 미전달).

## 7. 프론트엔드

- **아이템 단위 병합**: `getDealFeed()` → `ItemView[]`. 같은 정규화 구매 URL(`productKeyFromUrl`) 딜은 커뮤니티 무관 카드 1개로 병합, `sources[]`에 출처 나열. 키 규칙: 스킴 무시·호스트 소문자·프래그먼트/트래킹 파라미터 제거·나머지 쿼리 보존. `PATH_ALIASES`로 별칭 주소 접기(오늘의집 `productions/{번호}` ≡ `store.ohou.se/goods/{번호}`).
- 대표값 정책: 이름=이름 있는 최신 출처, 가격=수동 오버라이드 → **다수 합의(2표+)** → 최저가, 상태=하나라도 active면 active.
- **택소노미**(`src/db/taxonomy.ts`): 노출 7종(PC/하드웨어·게임/하드웨어·노트북/모바일·가전/TV·생활/식품·패션/뷰티·기타) + 제외 3종(게임/SW·상품권/쿠폰·포인트/래플). `STORE_FILTERS` 고정 18종 + 로고. `normalizeCategory(community, raw, title?)` — "기타"일 때만 제목 기반 재분류.
- 필터/정렬 = **URL 쿼리스트링**(서버 컴포넌트, 클라 JS 없음): `?cat=&store=&status=&sort=&community=`. 잘못된 값은 기본 피드 폴백. 정렬: ended 항상 맨 뒤, hot=추천×1e8+조회수, price=`FX_TO_KRW` 원화 환산 오름차순(USD 1385·JPY 8.7·CNY 205·EUR 1615, 무가격 맨 뒤), 최신순=`posted_at`(폴백 first_seen_at) 내림차순.
- 페이지: `/`(핫딜 모음), `/ranking`(실시간 순위 — **24h 신선도 컷 + ended 제외**, 점수는 상대 비율 바만), `/history`·`/history/[id]`(최저가 히스토리 — 관측 2회+만 노출), `/trends`(네이버 키워드 트렌드), `/admin/*`.
- 디자인 시스템: shadcn(radix/nova) + Tailwind. 컬러웨이 = `app/globals.css` `:root` 토큰 한 곳. v0 시안은 **표현층만** 이식(데이터 레이어·쿼리스트링 계약 유지). 모바일 반응형(900px/560px 브레이크포인트).
- 표시 폴백 체인(타일/썸네일): 상품 이미지 → 커뮤니티 로고 → 스토어 로고. 필드형 상품명(`name.ts` `splitNameParts`): main + 수량/구성 미사 분리(검색은 계속 원본 데이터 대상).

## 8. 제외 규칙 (`src/db/exclusion.ts`)

단일 판정기 `checkExclusion`을 3곳에서 공유: ① ingest(딜 단위 필터 + `excluded_reason` 기록) ② queries.ts(과거 데이터 방어) ③ purge-excluded.ts(일회성 정리).

판정 순서: **category → zero-price → promo-title → software-title → rental-title → travel-title → mart-flyer-title → telecom-title → live-benefit-title**.

- 무형 전면 제외: 상품권/기프티콘, SW(게임 포함), 프로모션/이벤트, 라이브 예고, 항공/여행.
- **키워드 안전 규칙**: 맨 단어 단독 금지(이벤트/라이브/적립/여행/정품/윈도우 등 — 실물 딜에 실제 존재). 구체적 조합만 잡는다. 가격 `null`은 제외 아님(정보 부족).
- 2026-09-02 추가 3종: `mart-flyer-title`=`/전단(?!계)/`(부정선독으로 "전단계" 의료 오탐 방지), `telecom-title`(통신사 할인/멤버십 + SKT/KT/LGU+/T데이), `live-benefit-title`(라방/라이브 + 총정리/모음/예고).
- 어드민 복원: `exclusion_restored=1` + 사유 해제 → 인제스트가 재제외 안 함.

## 9. 어드민 (`/admin`, 로컬 전용)

- 게이트: `ADMIN_MODE=1`일 때만(프로덕션은 환경변수 미설정 → 입구 없음, `notFound()`/API 404). 쓰기 가능 DB는 수집 도는 맥에 있고 수정분은 2시간 주기 파이프라인이 자동 반영.
- GitHub OAuth + `permissions.push/admin`(committer-only). Vercel 서버리스는 읽기전용 → 쓰기는 맥/파이프라인에서.
- **오버라이드 레이어 원칙**: 파서 값 컬럼은 인제스트가 계속 갱신, 수동 수정은 `*_override` 컬럼에만. 노출은 `queries.ts`가 오버라이드 우선 합성. "잠금·스킵" 방식은 값 고임 문제로 기각. 파서 최신값 ≠ 오버라이드 = 검토 큐. 쓰기 계층은 `src/db/admin.ts` 한 곳(`admin_audit` 감사).
- `url_override`(구매링크): 합성 = `url_override ?? product_url`, 수동 링크 urlType=direct. **productKey·썸네일 캐시 키도 오버라이드 기준**으로 이동(의도적 설계).
- 메뉴 5종: 핫딜 카드 관리 / 썸네일 관리 / 제외·미분류 관리 / 택소노미(읽기전용) / 로그(플레이스홀더).
- `/admin` 인덱스 force-dynamic(정적 프리렌더 404 방지). 쓰기 API는 GET 핸들러도 무조건 404(405로 라우트 존재 새는 것 방지). `hidden`은 노출에서만 숨김(행·관측 보존).

## 10. 썸네일 수집 (`scripts/fetch-thumbnails.ts`)

단계 구조:
1. **og:image** — `url_type='direct'`(또는 url_override) 대상. curl_cffi 배치(`collector/fetch-html-batch.py` + `scripts/lib/cffi-fetch.ts`) 우선, Node fetch 폴백. 성공/실패 모두 `product_images`에 기록, 실패 3회(`MAX_ATTEMPTS`)까지만 재시도.
2. **다나와 폴백** — 가전/디지털 4개 카테고리(PC/하드웨어·게임/하드웨어·노트북/모바일·가전/TV). 토큰 중복률 ≥50% & 토큰 2개+ 검증. `attempts=4`(`DANAWA_MARK`)=시도 완료 마커.
2b. **네이버 쇼핑 검색 폴백** — 생활/식품·패션/뷰티·기타(다나와 미커버). `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET` 필요(없으면 "no-cred" 스킵). **활성화 대기**: developers.naver.com 무료 앱 등록(기존 `NAVER_ADS_*`는 별개 API).
3. **Playwright 폴백** — `--playwright` 플래그 시에만, `HARD_BLOCK_HOSTS`(coupang/gmarket/auction/epicgames). 옵셔널 의존성(모듈명 변수 우회로 미설치 시에도 빌드 통과). 설치 = `npm i -D playwright && npx playwright install chromium`(무거워 D1 이후 보류).

2026-09-02 방어 우회 개편(7안 중 #2~#6 채택, #1·#7 보류):
- **#2 curl_cffi 브리지**: TLS 지문 방어 우회. `cffi-fetch.ts`는 **`execFileSync` + `input` 필수**(async execFile은 input 미지원 → stdin 빈 채 실행 bug). partial stdout 복구 포함.
- **#3 네이버 계열 분리**: 10초 스로틀 + 24h 쿨다운 + 세션 웜업(홈페이지 GET 쿠키 선취득).
- **#4 비상품 URL 제외**: `NON_PRODUCT_HOSTS`(쇼핑라이브/블로그/카페/통신사페이/기프트콘 등) + 게시판 스레드 누락 → 발견 즉시 영구 스킵 마커.
- 타임아웃 여유화: `DEFAULT_TIMEOUT_MS=25000`, `SLOW_TIMEOUT_MS=35000`(aliexpress/toss). (기존 12000.)
- 실측(20-URL): 13성공/7실패 = **65%**(기존 ~30%). gmarket 0→100%. 잔여 실패: coupang 403(Akamai→Playwright 대기), m.smartstore/m.gmarket 429(쿨다운 분산 예정), cjthemarket SPA(og:image 없음).
- `image_override`(어드민 수동) 있는 키는 자동 수집 스킵.

## 11. 운영 gotchas (모음)

- launchd PATH에 nvm node 경로 명시 — node 버전 변경 시 plist도 수정. `~/dev`는 TCC 비보호(보호 폴더로 옮기면 exit 126 재발). 파이프라인은 **디스크에서 스크립트 읽음** — 미커밋 편집도 다음 런에 반영.
- `data/hotdeal.db`는 파이프라인이 자동 커밋 — **수동 커밋 금지**.
- node:sqlite 쓰기 스크립트는 **`PRAGMA busy_timeout=10000` 필수**(dev 서버/worker와 WAL 경합 시 "database is locked" errcode 5).
- `nowKstIso()`는 `+09:00` 발급 — SQLite 사전식 비교도 같은 표기 유지.
- TS 타깃 es2018 미만 → 정규식 `s`(dotAll) 플래그 불가, `[\s\S]` 사용.
- `globals.css` 주석 내 `*/` 금지(PostCSS 깨져 `app/*/page.tsx` glob 영향). dev 서버는 프로젝트당 1개, `pnpm build` 전 kill(`.next` 충돌).
- 어드민 게이트 검증: `grep -o 'pat' | wc -l`(grep -c 금지). tsx 스크립트는 리포 디렉터리에서 실행.
- 검증 게이트: `npx tsx tests/schema-validation-test.ts` + `npx tsx tests/price-marker-regression-test.ts` + `pnpm build`(스크립트 제거 후 카운트). `pnpm start`는 stale build 서빙 가능.
- 한글 쿼리 파라미터 검증 시 `curl -G --data-urlencode` 필수(그냥 넣으면 0건 오진).
- 네이버 카페 핫딜 유입: 공식 `/v1/search/cafearticle.json`(무료 25k/일)은 부분 가능하나 키워드 검색 기반·제목+스니펫만·인덱스 지연. 직접 크롤링은 불가(SPA 셸 + 로그인/JS 렌더 + 방어). **보류 결정** — 현 파이프라인 안정화 우선.

## 12. 로드맵 / 예정

- **상품 정체성 사다리 4계층**: ① item_id 병합(재료 수집·인덱스 완료) ② 이미지 pHash(제안 신호만) ③ 속성 추출(브랜드·모델·스펙 별도 컬럼 = 근본 답) ④ 어드민 병합 도구(결정론적 신호는 자동, 퍼지는 제안→인간 확정).
- **상품 클러스터 계층**(9/4 이후): 리스팅 정체성(카드 분리 유지) vs 실물 정체성(히스토리 클러스터 단위 합치기) 분리. `product_clusters` + `product_key→cluster_id`. 단위 = 세대+옵션. 수동 지정 우선.
- **뽐뿌 = LLM 추출**(Gemini Flash 확정, 지출 0원): 스키마 계약(`hotdeal.schema_v2.0.json` + Ajv). OpenAI 호환 엔드포인트(`/v1beta/openai/chat/completions`, `x-goog-api-key`) 기준. 폼 기반 사이트는 규칙 유지, 뽐뿌만 LLM 우선 + 규칙 교차검증. ~1주 병행 파일럿 후 전환. **임시 방어**: 복수 상품/옵션 나열 글 스킵(groups≥2 OR variantLines≥3 → products=[]).
- **/history 검색 우선 개편**(9/4 직후): 1단계 검색 SQL 하강(관측 1회+ 전체) 2단계 검색창+안내문 랜딩 3단계 클러스터 통합 4단계 비슷한 상품.
- **트렌드 수집 주기**: 주 1회(`TRENDS_WEEKDAY`, 현재 3=수요일 — **요일 사용자 확정 대기**). 유튜브 지표 = "해당 주차 게시 관련 영상 수"(검색량 아님, 라벨 주의).
- D1 마이그레이션: 9/2 쓰기 경로 → 9/3 09:30 커트오버 → 9/4 안정화. 로드맵 실행은 안정화 이후.
