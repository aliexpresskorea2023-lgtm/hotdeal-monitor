import { DEFAULT_DB_PATH, openDb } from "../src/db";

/*
 * 어드민 스키마 마이그레이션 (2026-08-28) — 멱등.
 *
 * 운영 중인 DB에 오버라이드/하이드/제외 기록 컬럼과 감사 로그
 * 테이블을 추가한다. openDb()가 schema.sql의 CREATE TABLE IF NOT
 * EXISTS를 적용하므로, 여기서는 새 테이블+기존 테이블의 새 컬럼만
 * pragma 검사 후 ALTER 한다.
 *
 * 실행: npx tsx scripts/migrate-admin.ts
 */

type Db = ReturnType<typeof openDb>;

const DEAL_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "name_override", ddl: "ALTER TABLE deals ADD COLUMN name_override TEXT" },
  { name: "price_override", ddl: "ALTER TABLE deals ADD COLUMN price_override REAL" },
  { name: "category_override", ddl: "ALTER TABLE deals ADD COLUMN category_override TEXT" },
  { name: "store_override", ddl: "ALTER TABLE deals ADD COLUMN store_override TEXT" },
  { name: "hidden", ddl: "ALTER TABLE deals ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0" },
  { name: "excluded_reason", ddl: "ALTER TABLE deals ADD COLUMN excluded_reason TEXT" },
  {
    name: "exclusion_restored",
    ddl: "ALTER TABLE deals ADD COLUMN exclusion_restored INTEGER NOT NULL DEFAULT 0",
  },
];

const POST_COLUMNS: Array<{ name: string; ddl: string }> = [
  {
    name: "status_override",
    ddl: "ALTER TABLE posts ADD COLUMN status_override TEXT",
  },
  { name: "hidden", ddl: "ALTER TABLE posts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0" },
];

const IMAGE_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "image_override", ddl: "ALTER TABLE product_images ADD COLUMN image_override TEXT" },
];

function columnsOf(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;

  return new Set(rows.map((r) => r.name));
}

function migrateTable(
  db: Db,
  table: string,
  columns: Array<{ name: string; ddl: string }>,
): number {
  const existing = columnsOf(db, table);
  let added = 0;

  for (const col of columns) {
    if (existing.has(col.name)) continue;

    db.exec(col.ddl);
    console.log(`  + ${table}.${col.name}`);
    added += 1;
  }

  return added;
}

function main(): void {
  const db = openDb(DEFAULT_DB_PATH);

  try {
    console.log(`DB: ${DEFAULT_DB_PATH}`);

    const added =
      migrateTable(db, "posts", POST_COLUMNS) +
      migrateTable(db, "deals", DEAL_COLUMNS) +
      migrateTable(db, "product_images", IMAGE_COLUMNS);

    /* admin_audit는 schema.sql의 CREATE TABLE IF NOT EXISTS가 생성. */

    if (added === 0) {
      console.log("추가할 컬럼 없음 — 이미 최신 스키마.");
    } else {
      console.log(`마이그레이션 완료: 컬럼 ${added}개 추가.`);
    }
  } finally {
    db.close();
  }
}

main();
