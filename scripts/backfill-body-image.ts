import fs from "node:fs";
import path from "node:path";
import { DEFAULT_DB_PATH, openDb } from "../src/db";
import { extractBodyImage } from "../src/parsers/body-image";

/*
 * 기존 posts 행의 body_image_url 백필 (2026-09-11).
 *
 * 신규 적재는 ingest-crawls.ts가 스냅샷을 읽으며 채우지만,
 * 그 전에 쌓인 게시글은 컬럼이 비어 있다. 디스크에 남은 run
 * 스냅샷(data/crawls/<snapshot_path>)을 다시 읽어 본문 대표
 * 이미지를 추출·갱신한다.
 *
 * 스냅샷이 없는 글(예: API 수집 naver_cafe, 정리된 run)은 건너뛴다.
 * openDb()를 쓰므로 DB_BACKEND 설정에 따라 sqlite/D1 어디든 적재된다.
 *
 * 실행:
 *   npx tsx scripts/backfill-body-image.ts            # 비어 있는 행만
 *   npx tsx scripts/backfill-body-image.ts --all      # 스냅샷 있는 전부 재추출
 *   npx tsx scripts/backfill-body-image.ts --dry      # UPDATE 없이 집계만
 */

type Db = ReturnType<typeof openDb>;

interface PostRow {
  id: number;
  community: string;
  url: string;
  snapshot_path: string | null;
  body_image_url: string | null;
}

function main(): void {
  const argv = process.argv.slice(2);
  const all = argv.includes("--all");
  const dry = argv.includes("--dry");

  const crawlsRoot = path.join(process.cwd(), "data", "crawls");
  const db: Db = openDb(DEFAULT_DB_PATH);

  const stats: Record<string, { scanned: number; found: number; miss: number }> =
    {};

  try {
    const where = all
      ? `snapshot_path IS NOT NULL AND snapshot_path != ''`
      : `snapshot_path IS NOT NULL AND snapshot_path != ''
         AND (body_image_url IS NULL OR body_image_url = '')`;

    const rows = db
      .prepare(
        `SELECT id, community, url, snapshot_path, body_image_url
         FROM posts
         WHERE ${where}
         ORDER BY id`,
      )
      .all() as unknown as PostRow[];

    console.log(
      `DB: ${DEFAULT_DB_PATH} · 대상 posts ${rows.length}건${dry ? " (dry-run)" : ""}${all ? " [전부 재추출]" : ""}`,
    );

    /*
     * UPDATE는 배치로 묶어 db.exec() 한 번에 보낸다. D1 REST 어댑터는
     * 다중 구문 exec를 단일 원자 요청으로 실행하므로, 행마다 REST 왕복
     * (9000+회)하는 것보다 훨씬 빠르다. sqlite에서도 동일하게 동작.
     * URL 리터럴의 작은따옴표는 ''로 이스케이프.
     */
    const BATCH = 100;
    let buffer: string[] = [];

    const flush = (): void => {
      if (buffer.length === 0) return;
      db.exec(buffer.join("\n"));
      updated += buffer.length;
      buffer = [];
    };

    let scanned = 0;
    let found = 0;
    let miss = 0;
    let updated = 0;

    for (const row of rows) {
      const snapshotFile = path.join(crawlsRoot, row.snapshot_path as string);

      const bucket = (stats[row.community] ??= {
        scanned: 0,
        found: 0,
        miss: 0,
      });

      if (!fs.existsSync(snapshotFile)) {
        bucket.scanned += 1;
        bucket.miss += 1;
        miss += 1;
        scanned += 1;
        continue;
      }

      let html: string;
      try {
        html = fs.readFileSync(snapshotFile, "utf-8");
      } catch {
        bucket.scanned += 1;
        bucket.miss += 1;
        miss += 1;
        scanned += 1;
        continue;
      }

      const imageUrl = extractBodyImage(row.community, html, {
        baseUrl: row.url,
      });

      bucket.scanned += 1;
      scanned += 1;

      if (imageUrl) {
        bucket.found += 1;
        found += 1;

        if (!dry && imageUrl !== row.body_image_url) {
          const esc = imageUrl.replace(/'/g, "''");
          buffer.push(
            `UPDATE posts SET body_image_url='${esc}' WHERE id=${row.id};`,
          );
          if (buffer.length >= BATCH) flush();
        }
      }
    }

    if (!dry) flush();

    console.log("\n커뮤니티별 결과:");
    for (const [community, s] of Object.entries(stats).sort()) {
      const rate =
        s.scanned - s.miss > 0
          ? ((s.found / (s.scanned - s.miss)) * 100).toFixed(1)
          : "–";
      console.log(
        `  ${community.padEnd(12)} 스캔 ${String(s.scanned).padStart(5)}  ` +
          `추출 ${String(s.found).padStart(5)} (${rate}%)  스냅샷없음 ${s.miss}`,
      );
    }

    console.log(
      `\n합계: 스캔 ${scanned} · 추출 ${found} · 스냅샷없음 ${miss} · ` +
        `${dry ? "(dry-run, UPDATE 생략)" : `갱신 ${updated}`}`,
    );
  } finally {
    db.close();
  }
}

main();
