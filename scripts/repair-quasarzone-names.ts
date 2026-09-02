import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DB_PATH, openDb } from "../src/db";
import { parseQuasarzoneHtml } from "../src/parsers/quasarzone";

/*
 * 퀘이사존 빈 상품명/제목 복구 (1회성).
 *
 * 배경: 퀘이사존이 게시글 뷰 템플릿을 v2(h1.v2-view-head__title)로
 * 전환하면서, 옛 셀렉터(h1.title)만 보던 파서가 v2로 서빙된 글의
 * 제목·상품명·등록일을 빈 값으로 뽑았다. 거기에 ingest upsert가
 * title/product_name을 조건 없이 덮어써서, v2로 재크롤된 글은 기존
 * 좋은 값까지 지워졌다. 파서는 수정됐고 ingest는 COALESCE 가드로
 * 막았다. 이 스크립트는 이미 빈 값으로 저장된 행을 복구한다.
 *
 * 방법: data/crawls/ run 디렉터리별로 남아 있는 스냅샷
 * (quasarzone/<post_id>.html)을 수정된 파서로 다시 읽고, 글마다
 * 여러 스냅샷의 필드 중 "채워진 값"을 모아 병합한다(제목/등록일/
 * 상품명/스토어/카테고리). 그 다음 DB에서는 "비어 있는 필드만"
 * 채운다(COALESCE) — 상태·조회수·가격 등 시간가변 사실은 건드리지
 * 않는다(관측 시계열 보존).
 *
 * 사용법:
 *   npx tsx scripts/repair-quasarzone-names.ts          # dry-run(기본)
 *   npx tsx scripts/repair-quasarzone-names.ts --write  # 실제 반영
 *
 * 주의: 컷오버(D1 전환) 전에 SQLite에서 돌린다. DB 파일은 파이프라인이
 * 자동 커밋하므로 이 스크립트는 커밋하지 않는다.
 */

type Db = ReturnType<typeof openDb>;

const CRAWL_ROOT = join(process.cwd(), "data", "crawls");

interface Recovered {
  title: string | null;
  postedAt: string | null;
  name: string | null;
  store: string | null;
  category: string | null;
  snapshotCount: number;
}

/** post_id → 스냅샷 경로 목록(run 디렉터리 = 시간순). */
function buildSnapshotIndex(): Map<string, string[]> {
  const index = new Map<string, string[]>();

  let runs: string[] = [];
  try {
    runs = readdirSync(CRAWL_ROOT).filter((name) => {
      try {
        return statSync(join(CRAWL_ROOT, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return index;
  }

  runs.sort();

  for (const run of runs) {
    const qszDir = join(CRAWL_ROOT, run, "quasarzone");

    let files: string[] = [];
    try {
      files = readdirSync(qszDir).filter((f) => f.endsWith(".html"));
    } catch {
      continue;
    }

    for (const file of files) {
      const postId = file.replace(/\.html$/, "");
      const list = index.get(postId) ?? [];
      list.push(join(qszDir, file));
      index.set(postId, list);
    }
  }

  return index;
}

/** 글의 모든 스냅샷을 재파싱해 채워진 필드를 모은다. */
function recoverFromSnapshots(
  postId: string,
  paths: string[],
): Recovered {
  const acc: Recovered = {
    title: null,
    postedAt: null,
    name: null,
    store: null,
    category: null,
    snapshotCount: paths.length,
  };

  for (const file of paths) {
    const complete =
      acc.title !== null &&
      acc.postedAt !== null &&
      acc.name !== null &&
      acc.store !== null &&
      acc.category !== null;

    if (complete) {
      break;
    }

    let html: string;
    try {
      html = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    let parsed;
    try {
      parsed = parseQuasarzoneHtml(html, {
        sourceUrl: `https://quasarzone.com/bbs/qb_saleinfo/views/${postId}`,
      });
    } catch {
      continue;
    }

    if (acc.title === null && parsed.title) {
      acc.title = parsed.title;
    }
    if (acc.postedAt === null && parsed.postedAt) {
      acc.postedAt = parsed.postedAt;
    }
    if (acc.category === null && parsed.category) {
      acc.category = parsed.category;
    }

    const product = parsed.products[0];
    if (product) {
      if (acc.name === null && product.name) {
        acc.name = product.name;
      }
      if (acc.store === null && product.store) {
        acc.store = product.store;
      }
    }
  }

  return acc;
}

function main(): void {
  const write = process.argv.includes("--write");
  const dbPath = process.env.HOTDEAL_DB_PATH || DEFAULT_DB_PATH;
  const db: Db = openDb(dbPath);

  /*
   * openDb는 busy_timeout을 두지 않아(node:sqlite 기본 0) 개발 서버가
   * WAL을 잡고 있으면 쓰기가 곧바로 "database is locked"로 실패한다.
   * 경합 시 최대 10초 기다리게 한다.
   */
  db.exec("PRAGMA busy_timeout = 10000;");

  const index = buildSnapshotIndex();

  const emptyPosts = db
    .prepare(
      `SELECT id, post_id FROM posts
       WHERE community = 'quasarzone'
         AND (title = '' OR title IS NULL)
       ORDER BY id`,
    )
    .all() as { id: number; post_id: string }[];

  let repairedPosts = 0;
  let repairedDeals = 0;
  let postedAtFilled = 0;
  const noSnapshot: string[] = [];
  const stillEmpty: string[] = [];

  const updatePost = db.prepare(
    `UPDATE posts
     SET title = ?,
         posted_at = COALESCE(?, posted_at)
     WHERE id = ?
       AND (title = '' OR title IS NULL)`,
  );

  const updateDeal = db.prepare(
    `UPDATE deals
     SET product_name = COALESCE(?, product_name),
         category = COALESCE(?, category),
         store = COALESCE(?, store)
     WHERE post_rowid = ?
       AND (product_name IS NULL OR product_name = '')`,
  );

  const countDeals = db.prepare(
    `SELECT COUNT(*) AS n FROM deals
     WHERE post_rowid = ?
       AND (product_name IS NULL OR product_name = '')`,
  );

  /*
   * 1단계 — 읽기/파싱 (트랜잭션 없음).
   * 스냅샷 재파싱은 CPU·파일 I/O가 크므로 쓰기 락을 오래 잡지 않게
   * 트랜잭션 밖에서 미리 복구값을 계산해 둔다.
   */
  interface Row {
    id: number;
    rec: Recovered;
    dealCount: number;
  }
  const rows: Row[] = [];

  for (const post of emptyPosts) {
    const paths = index.get(post.post_id);

    if (!paths || paths.length === 0) {
      noSnapshot.push(post.post_id);
      continue;
    }

    const rec = recoverFromSnapshots(post.post_id, paths);

    if (rec.title === null) {
      stillEmpty.push(post.post_id);
      continue;
    }

    const dealCount = (
      countDeals.get(post.id) as { n: number } | undefined
    )?.n ?? 0;

    rows.push({ id: post.id, rec, dealCount });
  }

  repairedPosts = rows.length;
  postedAtFilled = rows.filter((r) => r.rec.postedAt !== null).length;

  if (!write) {
    repairedDeals = rows.reduce((sum, r) => sum + r.dealCount, 0);
  }

  /*
   * 2단계 — 쓰기 (단일 트랜잭션, UPDATE만).
   */
  if (write) {
    db.exec("BEGIN");

    try {
      for (const row of rows) {
        updatePost.run(row.rec.title, row.rec.postedAt, row.id);

        const dealRes = updateDeal.run(
          row.rec.name,
          row.rec.category,
          row.rec.store,
          row.id,
        );
        repairedDeals += Number(dealRes.changes ?? 0);
      }

      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  console.log(
    `${write ? "[WRITE]" : "[DRY-RUN]"} 퀘이사존 빈 제목 posts: ${emptyPosts.length}개`,
  );
  console.log(`  복구 가능 posts : ${repairedPosts}개`);
  console.log(`  복구 대상 deals : ${repairedDeals}개`);
  console.log(`  등록일 함께 충전: ${postedAtFilled}개`);
  console.log(`  스냅샷 없음     : ${noSnapshot.length}개`);
  console.log(`  스냅샷도 빈 제목: ${stillEmpty.length}개`);

  if (noSnapshot.length > 0) {
    console.log(`  - 스냅샷 없음 ids: ${noSnapshot.slice(0, 20).join(", ")}${noSnapshot.length > 20 ? " …" : ""}`);
  }
  if (stillEmpty.length > 0) {
    console.log(`  - 여전히 빈 ids: ${stillEmpty.slice(0, 20).join(", ")}${stillEmpty.length > 20 ? " …" : ""}`);
  }

  if (!write) {
    console.log("\n  실제로 반영하려면 --write 플래그로 다시 실행하세요.");
  }

  db.close();
}

main();
