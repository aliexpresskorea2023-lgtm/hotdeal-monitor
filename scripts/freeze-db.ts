/**
 * 배포용 DB 스냅샷 고정 (freeze).
 *
 * 배경: SQLite를 WAL 모드로 읽기 전용 열람하려면 -shm 보조 파일이
 * 필요한데, Vercel serverless는 파일시스템이 읽기 전용이라 -shm을
 * 생성하지 못해 `unable to open database file`(CANTOPEN)로 죽는다.
 * (2026-08-27 프로덕션 장애 원인)
 *
 * 해결: 배포 직전에 저널 모드를 DELETE(롤백 저널)로 전환한다.
 * 롤백 저널 DB는 보조 파일 없이 파일 하나만으로 읽기 전용 열람이
 * 가능하다. 로컬 수집 파이프라인은 openDb()가 다시 WAL로 돌리므로
 * 운영에는 영향이 없다.
 *
 * 절차:
 * 1. 남은 WAL 내용을 본체로 체크포인트 (TRUNCATE).
 * 2. journal_mode=DELETE 전환 — 헤더 플래그가 바뀌고 -wal/-shm이
 *    정리되어 단일 파일 스냅샷이 된다.
 *
 * 사용법: npx tsx scripts/freeze-db.ts [db경로]
 * 다른 연결이 물고 있어 전환이 실패하면 비0 종료 (파이프라인 로그에 남김).
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const dbPath = process.argv[2] ?? path.join(process.cwd(), "data", "hotdeal.db");

if (!fs.existsSync(dbPath)) {
  console.error(`freeze-db: DB 파일이 없음 — ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);

try {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  const row = db.prepare("PRAGMA journal_mode=DELETE;").get() as {
    journal_mode: string;
  };

  if (row.journal_mode !== "delete") {
    console.error(
      `freeze-db: 저널 모드 전환 실패 — 현재 ${row.journal_mode} (다른 연결이 사용 중일 수 있음)`,
    );
    process.exit(1);
  }

  console.log(`freeze-db: ${dbPath} → 롤백 저널 스냅샷 완료`);
} finally {
  db.close();
}
