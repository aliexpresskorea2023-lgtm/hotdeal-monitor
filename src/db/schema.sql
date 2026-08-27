-- hotdeal-monitor DB 스키마 v1 (2026-08-26)
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
--
-- 적용: CREATE TABLE IF NOT EXISTS 기반이라 멱등. src/db/index.ts가 실행한다.

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
  fetched_at TEXT NOT NULL
);
