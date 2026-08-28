-- hotdeal-monitor DB 스키마 (2026-08-28: 어드민 오버라이드 컬럼 추가)
--
-- 설계 원칙
-- 1. 게시글 단위 중복 제거: posts는 (community, post_id) 유일.
--    주기 수집에서 같은 글을 다시 만나면 행을 추가하지 않고 갱신한다.
-- 2. 딜 행은 안정 키: deals는 (post_rowid, seq) 유일로 제자리 upsert.
--    관측 기록(price_observations)이 deal id를 참조하므로 행이 사라지면 안 된다.
-- 3. 가격 관측은 append-only: 가격 관련 필드가 변했을 때만 새 행을 붙인다.
--    조회수 같은 연속 변동은 관측을 만들지 않는다(posts에만 반영).
-- 4. 상품 단위 묶음(productKey)은 아직 해결하지 않는다.
--    item_id 등 정체성 신호는 deals에 온전히 보존해 두고,
--    items 테이블/매칭 로직은 다음 단계에서 추가한다. (AGENTS.md 보류 결정)
-- 5. 종료 딜도 데이터다: ended는 터미널 상태라 수집 워커가 재수집을
--    건너뛰지만, 행 자체는 최저가 히스토리용으로 영구 보존한다.
-- 6. 수동 수정은 오버라이드 레이어: *_override 컬럼은 어드민이 쓰고,
--    수집기는 절대 건드리지 않는다. 노출은 오버라이드 우선 합성.
--    수집기는 파서 최신 값을 원본 컬럼에 계속 갱신하므로 값이 고이지
--    않고, 오버라이드 해제 시 최신 파서 값으로 즉시 복귀한다.
--
-- 적용: CREATE TABLE IF NOT EXISTS 기반이라 멱등. src/db/index.ts가 실행한다.
-- 운영 중 DB에는 scripts/migrate-admin.ts가 컬럼을 멱등 추가한다.

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  community TEXT NOT NULL
    CHECK(community IN (
      'fmkorea', 'ppomppu', 'ruliweb', 'quasarzone', 'arca',
      'mlbpark', 'theqoo', 'slrclub'   -- 하위 호환 유니온 (수집 대상 아님)
    )),
  post_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  -- ISO 8601 (+09:00). 사이트가 노출하지 않으면 null.
  posted_at TEXT,
  status TEXT NOT NULL DEFAULT 'unknown'
    CHECK(status IN ('active', 'ended', 'unknown')),
  views INTEGER,
  recommendations INTEGER,
  comments INTEGER,
  affiliate_enabled INTEGER NOT NULL DEFAULT 0,
  affiliate_raw_url TEXT,
  -- 게시글에서 파싱된 상품 수. 0이면 폼 미입력/자유형 글이라
  -- 수집 워커가 ended와 마찬가지로 재수집을 건너뛴다(동결).
  products_count INTEGER NOT NULL DEFAULT 0,
  -- 첫 적재 시각 / 마지막 적재(갱신) 시각. ISO 8601 (+09:00).
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  -- 마지막 적재 시 스냅샷의 run 내 상대 경로 (가지치기되면 null 가능).
  snapshot_path TEXT,
  -- 어드민 수동 상태 지정(진행중/종료 고정). 노출 시 수집기 상태보다 우선.
  -- 해제하면 NULL → 수집기 판정 복귀.
  status_override TEXT
    CHECK(status_override IN ('active', 'ended') OR status_override IS NULL),
  -- 어드민 소프트 하이드. 공개 피드에서 제외하되 행은 보존한다.
  hidden INTEGER NOT NULL DEFAULT 0,
  UNIQUE(community, post_id)
);

CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY,
  post_rowid INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  -- 게시글 내 상품 순서(0부터). 1게시글 N상품 모델.
  seq INTEGER NOT NULL,

  -- product
  product_name TEXT,
  normalized_name TEXT,
  category TEXT,
  store TEXT,
  -- 사이트가 노출한 상품 id (있는 커뮤니티만).
  product_id TEXT,
  -- ali/coupang 등 URL에서 추출된 아이템 id. 상품 단위 묶음의 1차 후보 신호.
  item_id TEXT,

  -- price
  deal_price REAL,
  currency TEXT NOT NULL
    CHECK(currency IN ('KRW', 'USD', 'CNY', 'JPY', 'EUR', 'GBP')),
  price_text TEXT NOT NULL,
  estimated_krw REAL,
  shipping REAL,
  shipping_text TEXT,
  condition TEXT NOT NULL
    CHECK(condition IN (
      'normal', 'coupon', 'card_discount', 'multiple_discount',
      'option', 'target', 'app_only', 'coin', 'unknown'
    )),

  -- purchase
  product_url TEXT,
  url_type TEXT NOT NULL
    CHECK(url_type IN (
      'direct', 'redirect', 'affiliate', 'javascript', 'app', 'none', 'unknown'
    )),
  -- 래핑 해제 전 원본 URL (원본 유지 원칙).
  original_product_url TEXT,

  -- sourceMeta (원본 보존)
  raw_price TEXT,
  raw_shipping TEXT,

  -- discount (배열/중첩 구조는 JSON 텍스트로 보존)
  discount_types TEXT,
  discount_codes TEXT,
  discount_stackable TEXT,
  discount_alternatives TEXT,
  discount_description TEXT,

  -- 어드민 오버라이드 레이어 (수집기는 이 컬럼들을 쓰지 않는다).
  -- 노출은 오버라이드 우선 합성 (src/db/queries.ts).
  name_override TEXT,
  -- 원화 표시값. 설정 시 통화와 무관하게 이 값으로 노출.
  price_override REAL,
  category_override TEXT,
  store_override TEXT,
  -- 구매링크 수동 지정. 설정 시 노출·상품 병합 키(productKey)가
  -- 이 링크 기준으로 바뀌고, 링크 유형은 직접 링크로 취급한다.
  url_override TEXT,
  -- 어드민 소프트 하이드.
  hidden INTEGER NOT NULL DEFAULT 0,

  -- 제외 기록: 인제스트가 제외 규칙 판정 시 사유를 남기고 행은 적재한다.
  -- 어드민 복원은 사유를 지우고 exclusion_restored=1로 표시 →
  -- 이후 인제스트가 규칙에 걸려도 다시 제외하지 않는다.
  excluded_reason TEXT
    CHECK(excluded_reason IN (
      'category', 'zero-price', 'promo-title', 'software-title',
      'rental-title', 'travel-title'
    ) OR excluded_reason IS NULL),
  exclusion_restored INTEGER NOT NULL DEFAULT 0,

  UNIQUE(post_rowid, seq)
);

CREATE INDEX IF NOT EXISTS idx_deals_item_id
  ON deals(item_id) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deals_name
  ON deals(normalized_name) WHERE normalized_name IS NOT NULL;

-- 가격 관측 시계열. append-only.
-- 가격/배송비/추정원화/게시글 상태가 직전 관측과 다를 때만 행이 생긴다.
CREATE TABLE IF NOT EXISTS price_observations (
  id INTEGER PRIMARY KEY,
  deal_rowid INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  -- 관측 시점의 게시글 상태 (ended 전환 시점 기록용).
  post_status TEXT NOT NULL
    CHECK(post_status IN ('active', 'ended', 'unknown')),
  deal_price REAL,
  currency TEXT,
  estimated_krw REAL,
  shipping REAL,
  -- 관측 시점 게시글 stats 스냅샷 (참고용).
  views INTEGER,
  recommendations INTEGER,
  comments INTEGER
);

CREATE INDEX IF NOT EXISTS idx_obs_deal
  ON price_observations(deal_rowid, observed_at);

-- 인제스트 원장. run 중복 적재 방지 + 감사 흔적.
CREATE TABLE IF NOT EXISTS ingest_runs (
  run_id TEXT PRIMARY KEY,
  ingested_at TEXT NOT NULL,
  snapshots INTEGER NOT NULL,
  posts_upserted INTEGER NOT NULL,
  deals_upserted INTEGER NOT NULL,
  observations_added INTEGER NOT NULL
);

-- 상품 썸네일 캐시 (2026-08-27).
-- 상품 키 = src/db/queries.ts의 productKeyFromUrl 정규화 결과.
-- 성공 시 image_url 채움, 실패 시 빈 문자열 + attempts 증가.
-- attempts 3회면 포기 — 무한 재시도 방지.
CREATE TABLE IF NOT EXISTS product_images (
  product_key TEXT PRIMARY KEY,
  image_url TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  fetched_at TEXT NOT NULL,
  -- 어드민 수동 지정 썸네일. 설정 시 자동 수집 결과보다 우선하고
  -- 해당 키는 자동 수집 대상에서 제외된다.
  image_override TEXT
);

-- 어드민 감사 로그. 모든 어드민 쓰기 작업이 여기 기록된다.
-- (메뉴 노출은 추후 — 기록은 먼저 시작)
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  -- GitHub OAuth 도입 전까지는 'local'.
  actor TEXT NOT NULL DEFAULT 'local',
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  field TEXT,
  old_value TEXT,
  new_value TEXT
);

-- ── 네이버 쇼핑 키워드 트렌드 (2026-08-28, v1.7) ────────────────
-- 출처: snxbest.naver.com 공식 주간 쇼핑 키워드 랭킹.
-- 수집: collector/trends.py (차트 API + Google News RSS + 선택적으로
-- 네이버 검색광고·YouTube) → 매니퍼스트 → scripts/ingest-trends.ts 적재.
--
-- 차트 2종: 'popular' = 인기 키워드 (당주차만 제공 — 주간 누적),
--           'new' = 급상승 키워드 (사이트가 과거 주차 조회 지원).
-- ymd는 사이트 주차 키 (YYYYMMDD, 주차 시작일).

CREATE TABLE IF NOT EXISTS trend_weeks (
  chart_type TEXT NOT NULL CHECK(chart_type IN ('popular', 'new')),
  ymd TEXT NOT NULL,
  month INTEGER,
  week INTEGER,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (chart_type, ymd)
);

CREATE TABLE IF NOT EXISTS trend_keywords (
  id INTEGER PRIMARY KEY,
  chart_type TEXT NOT NULL CHECK(chart_type IN ('popular', 'new')),
  ymd TEXT NOT NULL,
  -- 'A' = 전체, '50000000'.. = 카테고리 코드.
  category_id TEXT NOT NULL,
  category_name TEXT NOT NULL,
  rank INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  sub_title TEXT,
  status TEXT NOT NULL DEFAULT 'STABLE'
    CHECK(status IN ('STABLE', 'NEW', 'UP', 'DOWN', 'SOAR')),
  -- 전주 대비 순위 변동폭 (사이트 제공).
  fluctuation INTEGER NOT NULL DEFAULT 0,
  sync_date TEXT,
  rank_id TEXT,
  UNIQUE(chart_type, ymd, category_id, rank)
);

CREATE INDEX IF NOT EXISTS idx_trend_keywords_week
  ON trend_keywords(chart_type, ymd);

-- 키워드 부가 정보 — (주차, 키워드) 단위. 카테고리 무관이라 분리.
-- 기사수는 Google News RSS(상한 100), 유튜브수는 Data API 추정치,
-- 검색량은 네이버 검색광고 키워드도구 월간 쿼리수. 전부 널 허용.
CREATE TABLE IF NOT EXISTS trend_enrichment (
  ymd TEXT NOT NULL,
  keyword TEXT NOT NULL,
  news_count INTEGER,
  -- 최근 기사 3건 [{title, source, date, link}] JSON.
  news_sample TEXT,
  news_fetched_at TEXT,
  youtube_count INTEGER,
  youtube_fetched_at TEXT,
  -- 조회수 선두 영상 {"id","title","channel"} JSON; '{}' = 결과 없음 마커.
  youtube_top TEXT,
  monthly_pc_qc INTEGER,
  monthly_mobile_qc INTEGER,
  ads_fetched_at TEXT,
  PRIMARY KEY (ymd, keyword)
);
