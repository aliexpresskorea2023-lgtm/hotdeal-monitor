import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/*
 * SQLite 연결 + 스키마 적용.
 *
 * 드라이버는 Node 내장 node:sqlite (v22.5+, 의존성 없음).
 * 스키마는 schema.sql의 CREATE TABLE IF NOT EXISTS 기반으로
 * 멱등 적용한다 — 별도 마이그레이션 도구는 아직 불필요.
 *
 * 기본 DB 위치: data/hotdeal.db (.gitignore 처리).
 */

export const DEFAULT_DB_PATH = path.join(
  process.cwd(),
  "data",
  "hotdeal.db",
);

export function openDb(dbPath: string = DEFAULT_DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);

  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  const schema = fs.readFileSync(
    path.join(process.cwd(), "src", "db", "schema.sql"),
    "utf-8",
  );

  db.exec(schema);

  return db;
}

/** ISO 8601 (+09:00) 현재 시각 문자열. */
export function nowKstIso(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);

  return kst.toISOString().replace("Z", "+09:00");
}
