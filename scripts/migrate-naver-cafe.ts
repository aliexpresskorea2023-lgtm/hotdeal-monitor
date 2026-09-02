/**
 * posts 테이블 CHECK 제약조건 업데이트.
 *
 * SQLite는 ALTER TABLE로 CHECK 제약조건을 추가/변경할 수 없어서
 * 테이블 재성으로 처리한다. 데이터는 전부 보존된다.
 *
 * 사용법:
 *   npx tsx scripts/migrate-naver-cafe.ts [--write]
 *   --write: 실제 적용 (기본은 dry-run)
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "hotdeal.db");

const DRY_RUN = !process.argv.includes("--write");

function main() {
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA busy_timeout = 10000;");

  // 기존 행 수 확인
  const countRow = db
    .prepare("SELECT COUNT(*) as cnt FROM posts")
    .get() as { cnt: number };
  console.log(`기존 posts 행: ${countRow.cnt}개`);

  if (DRY_RUN) {
    console.log("[dry-run] 아래 SQL을 실행합니다:");
    console.log(`
  CREATE TABLE posts_new (... CHECK constraint updated ...);
  INSERT INTO posts_new SELECT ... FROM posts;
  DROP TABLE posts;
  ALTER TABLE posts_new RENAME TO posts;
  (인덱스·트리거 재생성)
`);
    db.close();
    return;
  }

  // posts 테이블 재생성 (CHECK 제약조건에 'naver_cafe' 추가)
  db.exec("PRAGMA foreign_keys = OFF;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS posts_new (
      id INTEGER PRIMARY KEY,
      community TEXT NOT NULL
        CHECK(community IN (
          'fmkorea', 'ppomppu', 'ruliweb', 'quasarzone', 'arca',
          'mlbpark', 'theqoo', 'slrclub',
          'naver_cafe'
        )),
      post_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      posted_at TEXT,
      status TEXT NOT NULL DEFAULT 'unknown'
        CHECK(status IN ('active', 'ended', 'unknown')),
      views INTEGER,
      recommendations INTEGER,
      comments INTEGER,
      affiliate_enabled INTEGER NOT NULL DEFAULT 0,
      affiliate_raw_url TEXT,
      products_count INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      snapshot_path TEXT,
      status_override TEXT
        CHECK(status_override IN ('active', 'ended') OR status_override IS NULL),
      hidden INTEGER NOT NULL DEFAULT 0,
      UNIQUE(community, post_id)
    )
  `);

  // 데이터 복사
  const insertStmt = db.prepare(`
    INSERT INTO posts_new (
      id, community, post_id, url, title, posted_at, status,
      views, recommendations, comments,
      affiliate_enabled, affiliate_raw_url, products_count,
      first_seen_at, last_seen_at, snapshot_path,
      status_override, hidden
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?
    )
  `);

  const rows = db
    .prepare(
      `SELECT * FROM posts ORDER BY id`,
    )
    .all() as Record<string, string | number | null>[];

  for (const row of rows) {
    insertStmt.run(
      row.id as number,
      row.community as string,
      row.post_id as string,
      row.url as string,
      row.title as string,
      row.posted_at as string | null,
      row.status as string,
      row.views as number | null,
      row.recommendations as number | null,
      row.comments as number | null,
      row.affiliate_enabled as number,
      row.affiliate_raw_url as string | null,
      row.products_count as number,
      row.first_seen_at as string,
      row.last_seen_at as string,
      row.snapshot_path as string | null,
      row.status_override as string | null,
      row.hidden as number,
    );
  }

  // 기존 테이블 삭제 + 새 테이블 이름 변경
  db.exec("DROP TABLE posts;");
  db.exec("ALTER TABLE posts_new RENAME TO posts;");

  // 인덱스 재생성 (기존 posts 기반 인덱스가 있다면)
  // posts는 UNIQUE(community, post_id)만 있음 — CREATE TABLE에 포함됨

  db.exec("PRAGMA foreign_keys = ON;");

  // 검증
  const newCountRow = db
    .prepare("SELECT COUNT(*) as cnt FROM posts")
    .get() as { cnt: number };
  console.log(
    `posts 마이그레이션 완료: ${countRow.cnt}개 → ${newCountRow.cnt}개 (${countRow.cnt === newCountRow.cnt ? "일치" : "불일치!"})`,
  );

  // ── deals 테이블 excluded_reason CHECK 제약조건 업데이트 ──
  const dealCountRow = db
    .prepare("SELECT COUNT(*) as cnt FROM deals")
    .get() as { cnt: number };
  console.log(`기존 deals 행: ${dealCountRow.cnt}개`);

  // 기존 스키마를 읽어서 excluded_reason CHECK만 교체
  const dealsSchema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='deals'")
    .get() as { sql: string };

  // CHECK 제약조건 교체: 기존 excluded_reason IN (...)을 새 목록으로
  const newDealsSchema = dealsSchema.sql.replace(
    /CHECK\(excluded_reason IN \([^)]+\)/,
    `CHECK(excluded_reason IN (
      'category', 'zero-price', 'promo-title', 'software-title',
      'rental-title', 'travel-title',
      'mart-flyer-title', 'telecom-title', 'live-benefit-title',
      'point-reward-title'`,
  );

  db.exec("PRAGMA foreign_keys = OFF;");

  db.exec(newDealsSchema.replace("CREATE TABLE deals", "CREATE TABLE deals_new"));

  // 컬럼 목록 가져오기
  const columns = db
    .prepare("PRAGMA table_info(deals)")
    .all() as { name: string }[];
  const colNames = columns.map((c) => c.name).join(", ");

  db.exec(`INSERT INTO deals_new (${colNames}) SELECT ${colNames} FROM deals`);
  db.exec("DROP TABLE deals;");
  db.exec("ALTER TABLE deals_new RENAME TO deals;");

  // 인덱스 재생성
  db.exec(`CREATE INDEX IF NOT EXISTS idx_deals_item_id ON deals(item_id) WHERE item_id IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_deals_name ON deals(normalized_name) WHERE normalized_name IS NOT NULL`);

  db.exec("PRAGMA foreign_keys = ON;");

  const newDealCountRow = db
    .prepare("SELECT COUNT(*) as cnt FROM deals")
    .get() as { cnt: number };
  console.log(
    `deals 마이그레이션 완료: ${dealCountRow.cnt}개 → ${newDealCountRow.cnt}개 (${dealCountRow.cnt === newDealCountRow.cnt ? "일치" : "불일치!"})`,
  );

  db.close();
}

main();
