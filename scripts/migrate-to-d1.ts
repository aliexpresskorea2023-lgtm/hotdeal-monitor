/**
 * D1 벌크 수입 스크립트 (2단계).
 *
 * 로컬 SQLite(data/hotdeal.db)의 전체 데이터를 Cloudflare D1으로 이전한다.
 * INSERT OR REPLACE 기반이라 멱등 — 중단 후 재실행해도 안전하다.
 *
 * D1 REST API는 바인딩 파라미터 한계(~100개)가 있으므로 값을 SQL에
 * 직접 인라인한다. 배치당 SQL 크기가 90KB를 넘으면 자동으로 행 수를
 * 줄여서 보낸다.
 *
 * 사용법:
 *   npx tsx scripts/migrate-to-d1.ts [--batch N] [--table name] [--verify-only]
 *
 * 사전 조건: .env.local에 CF_ACCOUNT_ID / CF_API_TOKEN / CF_D1_DATABASE_ID.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/* ── .env.local 로더 ─────────────────────────── */

function loadEnvLocal(): void {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvLocal();

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID!;
const CF_API_TOKEN = process.env.CF_API_TOKEN!;
const CF_D1_DATABASE_ID = process.env.CF_D1_DATABASE_ID!;

if (!CF_ACCOUNT_ID || !CF_API_TOKEN || !CF_D1_DATABASE_ID) {
  console.error(
    "CF_ACCOUNT_ID / CF_API_TOKEN / CF_D1_DATABASE_ID 가 .env.local에 필요합니다.",
  );
  process.exit(1);
}

const D1_URL =
  `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}` +
  `/d1/database/${CF_D1_DATABASE_ID}/query`;

/* ── CLI 인자 ─────────────────────────────────── */

const args = process.argv.slice(2);
const BATCH_SIZE = (() => {
  const idx = args.indexOf("--batch");
  if (idx >= 0 && args[idx + 1]) return parseInt(args[idx + 1], 10);
  return 100;
})();
const ONLY_TABLE = (() => {
  const idx = args.indexOf("--table");
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return null;
})();
const VERIFY_ONLY = args.includes("--verify-only");

/** SQL 인라인 크기 상한 (D1 REST 제한 대비 여유롭게 60KB) */
const MAX_SQL_BYTES = 60_000;

/* ── D1 API 호출 ─────────────────────────────── */

interface D1Result {
  results?: Record<string, unknown>[];
  success: boolean;
  meta: { changes: number; rows_read: number; rows_written: number; duration: number };
}

async function d1Query(sql: string): Promise<D1Result[]> {
  const res = await fetch(D1_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CF_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sql }),
  });

  const json = (await res.json()) as {
    result?: D1Result[];
    errors?: Array<{ code?: number; message?: string }>;
    success?: boolean;
  };

  if (!res.ok || json.success === false) {
    const detail =
      json.errors?.map((e) => `[${e.code}] ${e.message}`).join(" / ") ??
      `HTTP ${res.status}`;
    throw new Error(`D1 오류: ${detail}`);
  }

  return json.result ?? [];
}

/* ── 테이블 정의 (FK 의존성 순서) ─────────────── */

const TABLES = [
  "posts",
  "deals",
  "price_observations",
  "product_images",
  "ingest_runs",
  "link_resolutions",
  "link_checks",
  "admin_audit",
  "trend_weeks",
  "trend_keywords",
  "trend_enrichment",
] as const;

/* ── 로컬 SQLite 열기 ────────────────────────── */

const DB_PATH = path.resolve(__dirname, "..", "data", "hotdeal.db");

if (!fs.existsSync(DB_PATH)) {
  console.error(`로컬 DB 없음: ${DB_PATH}`);
  process.exit(1);
}

const localDb = new DatabaseSync(DB_PATH, { open: true, readOnly: true });

/* ── 헬퍼 ────────────────────────────────────── */

function getColumns(table: string): string[] {
  const rows = localDb
    .prepare(`PRAGMA table_info(${table})`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function getLocalCount(table: string): number {
  const row = localDb
    .prepare(`SELECT COUNT(*) AS cnt FROM ${table}`)
    .get() as { cnt: number };
  return row.cnt;
}

async function getD1Count(table: string): Promise<number> {
  const results = await d1Query(`SELECT COUNT(*) AS cnt FROM ${table}`);
  const row = results[0]?.results?.[0] as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

/** SQLite 값을 SQL 리터럴로 안전하게 인코딩 */
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  // 문자열: 단일 인용부호 이스케이프
  const s = String(value).replace(/'/g, "''");
  return `'${s}'`;
}

/* ── 벌크 수입 ───────────────────────────────── */

async function importTable(table: string): Promise<void> {
  const columns = getColumns(table);
  const totalRows = getLocalCount(table);

  if (totalRows === 0) {
    console.log(`  ${table}: 0행 — 건너뜀`);
    return;
  }

  console.log(`  ${table}: ${totalRows}행, ${columns.length}컬럼`);

  const colList = columns.join(", ");
  let imported = 0;
  let offset = 0;
  let batch = BATCH_SIZE;

  while (offset < totalRows) {
    const rows = localDb
      .prepare(`SELECT * FROM ${table} LIMIT ? OFFSET ?`)
      .all(batch, offset) as Record<string, unknown>[];

    if (rows.length === 0) break;

    // SQL 생성
    const valueGroups = rows.map(
      (row) => `(${columns.map((col) => sqlLiteral(row[col])).join(", ")})`,
    );
    const sql = `INSERT OR REPLACE INTO ${table} (${colList}) VALUES ${valueGroups.join(", ")}`;

    // SQL 크기 체크 — 초과하면 배치 줄여서 재시도
    if (sql.length > MAX_SQL_BYTES && rows.length > 1) {
      batch = Math.max(1, Math.floor(batch / 2));
      console.log(`\n    SQL ${(sql.length / 1024).toFixed(0)}KB 초과 → 배치 ${batch}행으로 축소`);
      continue; // offset不变, 다시 읽기
    }

    await d1Query(sql);
    imported += rows.length;
    offset += rows.length;

    // 진행률 표시 (10% 단위)
    const pct = Math.round((imported / totalRows) * 100);
    if (pct % 10 === 0 || imported >= totalRows) {
      process.stdout.write(`\r    ${imported}/${totalRows} (${pct}%)`);
    }
  }

  process.stdout.write("\n");

  // 행 수 검증
  const d1Count = await getD1Count(table);
  if (d1Count !== totalRows) {
    console.warn(`    ⚠ 행 수 불일치: 로컬 ${totalRows} vs D1 ${d1Count}`);
  } else {
    console.log(`    ✓ D1 행 수 일치: ${d1Count}`);
  }
}

/* ── 검증 모드 ───────────────────────────────── */

async function verifyAll(): Promise<void> {
  console.log("\n=== 행 수 검증 (로컬 vs D1) ===\n");
  let allMatch = true;

  for (const table of TABLES) {
    const local = getLocalCount(table);
    const remote = await getD1Count(table);
    const match = local === remote;
    if (!match) allMatch = false;
    console.log(`  ${match ? "✓" : "✗"} ${table}: 로컬 ${local} | D1 ${remote}`);
  }

  console.log(allMatch ? "\n모든 테이블 행 수 일치." : "\n⚠ 불일치 테이블 있음.");
}

/* ── 메인 ────────────────────────────────────── */

async function main(): Promise<void> {
  const tables = ONLY_TABLE
    ? TABLES.filter((t) => t === ONLY_TABLE)
    : [...TABLES];

  if (tables.length === 0) {
    console.error(`알 수 없는 테이블: ${ONLY_TABLE}`);
    process.exit(1);
  }

  if (VERIFY_ONLY) {
    await verifyAll();
    localDb.close();
    return;
  }

  console.log("=== D1 벌크 수입 시작 ===");
  console.log(`  대상: ${tables.join(", ")}`);
  console.log(`  배치 크기: ${BATCH_SIZE}행 (SQL ${MAX_SQL_BYTES / 1024}KB 상한)\n`);

  const start = Date.now();

  for (const table of tables) {
    await importTable(table);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n=== 수입 완료 (${elapsed}s) ===`);

  // 최종 검증
  await verifyAll();

  localDb.close();
}

main().catch((err) => {
  console.error("\n수입 실패:", err.message);
  localDb.close();
  process.exit(1);
});
