/*
 * 뽐뿌 복수 상품 게시글 일괄 정리 (원타임 스크립트, 2026-09-02).
 *
 * 배경: 뽐뿌 파서는 2026-09-02부터 복수 상품 구조(groups ≥ 2 또는
 * variantLines ≥ 3)가 감지되면 products=[]로 스킵한다. 그 이전에
 * 적재된 복수 상품 딜 행은 DB에 남아 카드가 쪼개져 노출되므로
 * 이 스크립트로 정리한다.
 *
 * 판정 기준은 파서 감지와 동일한 "post_rowid 당 deal 2개 이상".
 * 단일 상품 게시글은 deal이 1개라 영향 없음.
 *
 * 동작:
 * - 대상 deal 행 삭제
 * - 해당 게시글 products_count를 남은 딜 수로 갱신 (0 → 워커 동결)
 *
 * 실행:
 *   npx tsx scripts/purge-ppomppu-multi.ts            # 적용
 *   npx tsx scripts/purge-ppomppu-multi.ts --dry-run  # 삭제 예정 보고만
 */

import { DEFAULT_DB_PATH, openDb } from "../src/db";

const dryRun = process.argv.includes("--dry-run");
const db = openDb(DEFAULT_DB_PATH);

if (!db) {
  console.error(`DB를 열 수 없습니다: ${DEFAULT_DB_PATH}`);
  process.exit(1);
}

/* dev 서버·워커와 WAL 경합 시 즉시 실패 방지. */
db.exec("PRAGMA busy_timeout = 10000;");

interface MultiPostRow {
  post_rowid: number;
  title: string;
  deal_count: number;
}

interface DealRow {
  id: number;
  post_rowid: number;
}

const multiPosts = db
  .prepare(
    `SELECT p.id AS post_rowid, p.title, COUNT(d.id) AS deal_count
     FROM posts p
     JOIN deals d ON d.post_rowid = p.id
     WHERE p.community = 'ppomppu'
     GROUP BY p.id
     HAVING COUNT(d.id) >= 2
     ORDER BY deal_count DESC`,
  )
  .all() as unknown as MultiPostRow[];

if (multiPosts.length === 0) {
  console.log("복수 상품 뽐뿌 게시글이 없습니다.");
  process.exit(0);
}

const postRowids = multiPosts.map((r) => r.post_rowid);
const placeholders = postRowids.map(() => "?").join(", ");

const dealsToDelete = db
  .prepare(
    `SELECT id, post_rowid FROM deals WHERE post_rowid IN (${placeholders})`,
  )
  .all(...postRowids) as unknown as DealRow[];

const totalDeals = dealsToDelete.length;

console.log(
  `복수 상품 뽐뿌 게시글 ${multiPosts.length}개 / 딜 ${totalDeals}행`,
);
console.log("상위 10개:");
for (const row of multiPosts.slice(0, 10)) {
  console.log(`  [${row.deal_count}행] ${row.title.slice(0, 70)}`);
}

if (dryRun) {
  console.log("--dry-run: 삭제하지 않고 종료합니다.");
  process.exit(0);
}

db.exec("BEGIN;");
try {
  const deleteStmt = db.prepare(`DELETE FROM deals WHERE id = ?`);
  for (const row of dealsToDelete) {
    deleteStmt.run(row.id);
  }

  const updateStmt = db.prepare(
    `UPDATE posts SET products_count =
       (SELECT COUNT(*) FROM deals WHERE deals.post_rowid = posts.id)
     WHERE id = ?`,
  );
  for (const postRowid of postRowids) {
    updateStmt.run(postRowid);
  }

  db.exec("COMMIT;");
} catch (err) {
  db.exec("ROLLBACK;");
  throw err;
}

console.log(
  `완료: deal ${totalDeals}행 삭제, ` +
    `게시글 ${multiPosts.length}개 products_count 갱신.`,
);
