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

/**
 * 읽기 전용 연결 (웹 조회용).
 *
 * 스키마 적용/PRAGMA 설정 없이 열고, 파일이 없으면 null을 돌려준다
 * (수집 이력이 아직 없는 환경에서 페이지가 죽지 않도록).
 * 수집 파이프라인과 동시 접근은 WAL 모드라 안전하다.
 */
export function openDbReadOnly(
  dbPath: string = DEFAULT_DB_PATH,
): DatabaseSync | null {
  if (!fs.existsSync(dbPath)) return null;

  return new DatabaseSync(dbPath, { readOnly: true });
}

/** ISO 8601 (+09:00) 현재 시각 문자열. */
export function nowKstIso(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);

  return kst.toISOString().replace("Z", "+09:00");
}
