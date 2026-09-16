import { DEFAULT_DB_PATH, openDb } from "../src/db";
import { classifyPostKind } from "../src/parsers/post-kind";

/*
 * 기존 posts 행의 post_kind(상품 구성) 백필 (2026-09-16).
 *
 * 신규 적재는 ingest-crawls.ts / fetch-naver-cafe.ts가 분류해 채우지만,
 * 그 전에 쌓인 게시글은 post_kind가 기본값('single')이다. 이 스크립트는
 * 디스크 스냅샷 없이 DB의 제목 + 적재 딜 수만으로 전부 재분류한다
 * (classifyPostKind는 순수 제목/딜수 기반이라 스냅샷이 필요 없다).
 *
 * 어드민 오버라이드(post_kind_override)는 절대 건드리지 않는다 —
 * 자동 분류(post_kind)만 갱신한다. openDb()를 쓰므로 DB_BACKEND 설정에
 * 따라 sqlite/D1 어디든 적재된다.
 *
 * 실행:
 *   set -a && . ./.env.local && set +a          # D1 대상일 때만
 *   npx tsx scripts/backfill-post-kind.ts        # 변경되는 행만 UPDATE
 *   npx tsx scripts/backfill-post-kind.ts --dry  # UPDATE 없이 집계만
 */

type Db = ReturnType<typeof openDb>;

interface PostRow {
  id: number;
  title: string | null;
  post_kind: string;
}

function main(): void {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");

  const db: Db = openDb(DEFAULT_DB_PATH);

  try {
    const rows = db
      .prepare(
        `SELECT id, title, post_kind
         FROM posts
         ORDER BY id`,
      )
      .all() as unknown as PostRow[];

    console.log(
      `DB: ${DEFAULT_DB_PATH} · 대상 posts ${rows.length}건${dry ? " (dry-run)" : ""}`,
    );

    /*
     * UPDATE는 배치로 묶어 db.exec() 한 번에 보낸다. D1 REST 어댑터는
     * 다중 구문 exec를 단일 원자 요청으로 실행하므로 행마다 REST 왕복
     * (1만 회)하는 것보다 훨씬 빠르다. sqlite에서도 동일하게 동작.
     */
    const BATCH = 200;
    let buffer: string[] = [];
    let updated = 0;

    const flush = (): void => {
      if (buffer.length === 0) return;
      db.exec(buffer.join("\n"));
      updated += buffer.length;
      buffer = [];
    };

    let bundle = 0;
    let single = 0;
    let changed = 0;

    for (const row of rows) {
      const kind = classifyPostKind({ title: row.title });

      if (kind === "bundle") bundle += 1;
      else single += 1;

      /* 이미 같은 값이면 UPDATE 생략 — D1 쓰기 왕복 절약. */
      if (row.post_kind === kind) continue;

      changed += 1;
      if (!dry) {
        buffer.push(
          `UPDATE posts SET post_kind='${kind}' WHERE id=${row.id};`,
        );
        if (buffer.length >= BATCH) flush();
      }
    }

    if (!dry) flush();

    console.log("\n분류 결과:");
    console.log(`  단품(single)     ${single}`);
    console.log(`  묶음·행사(bundle) ${bundle} (${((bundle / Math.max(1, rows.length)) * 100).toFixed(1)}%)`);
    console.log(
      `\n${dry ? "(dry-run) 변경 예정" : "갱신"} ${changed}건` +
        (dry ? "" : ` · 실제 UPDATE ${updated}건`),
    );
  } finally {
    db.close();
  }
}

main();
