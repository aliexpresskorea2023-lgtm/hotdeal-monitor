/*
 * 기존 DB의 무형·비핫딜 행 일괄 정리 (원타임 스크립트).
 *
 * 제외 규칙(2026-08-27 확정) 도입 이전에 적재된 딜을
 * exclusion.ts의 동일 판정으로 골라낸다:
 * - 대상 deal 행 삭제
 * - 해당 게시글의 products_count를 남은 딜 수로 갱신
 *   (0이 되면 수집 워커가 재확인 없이 동결)
 *
 * 뷰 계층(queries.ts)에도 동일 필터가 있어 이 스크립트 없이도
 * 노출은 안 되지만, 워커의 쓸모없는 재수집과 인계 데이터의
 * 노이즈를 없애려면 실행 쪽이 맞다.
 *
 * 실행:
 *   npx tsx scripts/purge-excluded.ts            # 적용
 *   npx tsx scripts/purge-excluded.ts --dry-run  # 삭제 예정 보고만
 */

import { DEFAULT_DB_PATH, openDb } from "../src/db";
import { checkExclusion } from "../src/db/exclusion";

const dryRun = process.argv.includes("--dry-run");
const db = openDb(DEFAULT_DB_PATH);

if (!db) {
  console.error(`DB를 열 수 없습니다: ${DEFAULT_DB_PATH}`);
  process.exit(1);
}

interface JoinedRow {
  deal_id: number;
  post_rowid: number;
  community: string;
  category: string | null;
  deal_price: number | null;
  title: string;
}

const rows = db
  .prepare(
    `SELECT d.id AS deal_id, d.post_rowid, p.community,
            d.category, d.deal_price, p.title
     FROM deals d
     JOIN posts p ON p.id = d.post_rowid`,
  )
  .all() as unknown as JoinedRow[];

const dealsToDelete: number[] = [];
const affectedPosts = new Set<number>();
const reasonCounts = new Map<string, number>();
const samples = new Map<string, string[]>();

for (const row of rows) {
  const result = checkExclusion({
    community: row.community,
    category: row.category,
    title: row.title,
    price: row.deal_price,
  });

  if (!result.excluded || result.reason === null) continue;

  dealsToDelete.push(row.deal_id);
  affectedPosts.add(row.post_rowid);
  reasonCounts.set(
    result.reason,
    (reasonCounts.get(result.reason) ?? 0) + 1,
  );

  const list = samples.get(result.reason) ?? [];
  if (list.length < 5) list.push(row.title.slice(0, 60));
  samples.set(result.reason, list);
}

console.log(`전체 딜 ${rows.length}건 중 제외 대상 ${dealsToDelete.length}건`);
for (const [reason, count] of [...reasonCounts.entries()].sort()) {
  console.log(`  ${reason}: ${count}`);
  for (const title of samples.get(reason) ?? []) {
    console.log(`    예) ${title}`);
  }
}
console.log(`영향 받는 게시글 ${affectedPosts.size}개`);

if (dryRun) {
  console.log("--dry-run: 삭제하지 않고 종료합니다.");
  process.exit(0);
}

if (dealsToDelete.length === 0) {
  console.log("삭제할 행이 없습니다.");
  process.exit(0);
}

const deleteStmt = db.prepare(`DELETE FROM deals WHERE id = ?`);
for (const id of dealsToDelete) {
  deleteStmt.run(id);
}

/* 남은 딜 수 기준으로 products_count 재계산 (워커 동결 기준). */
const updateStmt = db.prepare(
  `UPDATE posts SET products_count =
     (SELECT COUNT(*) FROM deals WHERE deals.post_rowid = posts.id)
   WHERE id = ?`,
);
for (const postRowid of affectedPosts) {
  updateStmt.run(postRowid);
}

console.log(
  `완료: deal ${dealsToDelete.length}행 삭제, ` +
    `게시글 ${affectedPosts.size}개 products_count 갱신.`,
);
