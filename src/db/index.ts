import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { D1Db } from "./d1";
import type { Db } from "./driver";

/*
 * SQLite 연결 + 스키마 적용.
 *
 * 드라이버는 Node 내장 node:sqlite (v22.5+, 의존성 없음).
 * 스키마는 schema.sql의 CREATE TABLE IF NOT EXISTS 기반으로
 * 멱등 적용한다 — 별도 마이그레이션 도구는 아직 불필요.
 *
 * 기본 DB 위치: data/hotdeal.db (.gitignore 처리).
 *
 * 백엔드 전환 (2026-08-31, D1 이주 1단계):
 * `DB_BACKEND=d1`이면 두 진입점 모두 Cloudflare D1 어댑터를
 * 돌려준다. 이 경우:
 * - dbPath 인자는 무시된다.
 * - 스키마는 열 때마다 적용하지 않는다(호출당 1회 HTTP 왕복 비용).
 *   스키마 적용은 일회성 벌크 수입 스크립트가 담당한다.
 * - 자격증명은 CF_ACCOUNT_ID / CF_D1_DATABASE_ID / CF_API_TOKEN
 *   (env 전용 — 커밋 금지).
 */

export const DEFAULT_DB_PATH = path.join(
  process.cwd(),
  "data",
  "hotdeal.db",
);

export type { Db, RunResult, SqlValue, Statement } from "./driver";

function backend(): "sqlite" | "d1" {
  return process.env.DB_BACKEND === "d1" ? "d1" : "sqlite";
}

export function openDb(dbPath: string = DEFAULT_DB_PATH): Db {
  if (backend() === "d1") return new D1Db();

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
 *
 * D1 백엔드는 연결 파일이 없으므로 항상 드라이버를 돌려준다.
 */
export function openDbReadOnly(
  dbPath: string = DEFAULT_DB_PATH,
): Db | null {
  if (backend() === "d1") return new D1Db();

  if (!fs.existsSync(dbPath)) return null;

  return new DatabaseSync(dbPath, { readOnly: true });
}

/** ISO 8601 (+09:00) 현재 시각 문자열. */
export function nowKstIso(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);

  return kst.toISOString().replace("Z", "+09:00");
}
