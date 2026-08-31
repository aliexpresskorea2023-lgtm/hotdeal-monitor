import { Worker } from "node:worker_threads";
import type { Db, RunResult, SqlValue, Statement } from "./driver";

/*
 * Cloudflare D1 어댑터 (2026-08-31, D1 이주 1단계).
 *
 * D1은 REST API로만 접근한다(바인딩은 Workers 전용). 호출부는 전부
 * 동기 시맨틱이라, 워커 스레드에서 fetch를 돌리고 메인 스레드는
 * Atomics.wait으로 대기하는 "동기 브리지"를 쓴다. 워커는 프로세스당
 * 1개만 만들어 재사용한다.
 *
 * 브리지 설계 — 공유 메모리 채널:
 * 워커→메인 전달에 MessagePort를 쓰면 안 된다. 포트 메시지는 수신
 * 스레드의 이벤트 루프를 통해서만 배달되는데, 메인 스레드는
 * Atomics.wait으로 막혀 있어 배달이 무한 지연된다(실측으로 확인).
 * 그래서 결과를 SharedArrayBuffer에 직접 쓰고 완료를 플래그+notify로
 * 알린다. Atomics 순차 일관성 덕분에 플래그 관찰 시점에는 페이로드
 * 쓰기가 전부 가시적이다. 요청은 항상 1개씩(동기)이라 버퍼 1개면
 * 충분하고, 응답이 버퍼(16MB)를 초과하면 오류로 처리한다.
 *
 * 측정 근거(2026-08-31, docs/d1-migration-draft §9):
 * - Vercel icn1 → D1 중앙값 ~55ms, SQL 자체는 ~0.15ms(전부 RTT).
 * - 다중 구문 1요청은 암묵적 원자 트랜잭션. 단, 파라미터는 단일
 *   구문 요청에서만 허용 → 이 어댑터는 prepare 구문을 항상
 *   "단일 구문 + params"로 보낸다.
 * - BEGIN/COMMIT은 D1이 거부 → exec()에서 무시. 트랜잭션 사용처는
 *   멱등이라 계획서 리스크 3의 폴백(부분 실패 허용)을 따른다.
 * - PRAGMA journal_mode/foreign_keys는 SQLITE_AUTH 거부 → 스킵.
 *   (foreign_keys는 D1 기본 ON, 저널링은 관리 대상 아님)
 */

const REQUEST_TIMEOUT_MS = 60_000;
const WAIT_SLICE_MS = 5_000;
const SAB_BYTES = 16 * 1024 * 1024; // 응답 버퍼 상한
const PAYLOAD_OFFSET = 8; // 헤더: [0]=완료 플래그, [1]=페이로드 길이

// 워커 소스 — CJS 문자열. 공유 버퍼는 workerData로 한 번만 받는다.
const WORKER_SOURCE = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");

const sab = workerData.sab;
const header = new Int32Array(sab, 0, 2);
const payload = new Uint8Array(sab, ${PAYLOAD_OFFSET});
const capacity = sab.byteLength - ${PAYLOAD_OFFSET};
const encoder = new TextEncoder();

function finish(envelope) {
  let bytes;
  try {
    bytes = encoder.encode(JSON.stringify(envelope));
  } catch {
    bytes = encoder.encode('{"ok":false,"error":"응답 직렬화 실패"}');
  }
  if (bytes.length > capacity) {
    bytes = encoder.encode(
      '{"ok":false,"error":"D1 응답이 공유 버퍼를 초과함 (' +
        bytes.length + ' bytes)"}',
    );
  }
  payload.set(bytes);
  Atomics.store(header, 1, bytes.length);
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0);
}

parentPort.on("message", async (msg) => {
  const { url, token, body } = msg;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    finish({
      ok: true,
      status: res.status,
      json,
      snippet: json ? null : text.slice(0, 400),
    });
  } catch (err) {
    finish({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});
`;

export interface D1Config {
  accountId: string;
  databaseId: string;
  apiToken: string;
}

export function loadD1Config(
  env: NodeJS.ProcessEnv = process.env,
): D1Config {
  const accountId = env.CF_ACCOUNT_ID;
  const databaseId = env.CF_D1_DATABASE_ID;
  const apiToken = env.CF_API_TOKEN;

  if (!accountId || !databaseId || !apiToken) {
    throw new Error(
      "D1 자격증명 누락 — CF_ACCOUNT_ID / CF_D1_DATABASE_ID / CF_API_TOKEN 필요",
    );
  }

  return { accountId, databaseId, apiToken };
}

interface D1Meta {
  changes: number;
  last_row_id: number;
  duration: number;
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
}

export interface D1StatementResult {
  results: Record<string, unknown>[];
  success: boolean;
  meta: D1Meta;
}

interface BridgeEnvelope {
  ok: boolean;
  status?: number;
  json?: {
    result?: D1StatementResult[];
    errors?: Array<{ code?: number; message?: string }>;
    success?: boolean;
  };
  snippet?: string | null;
  error?: string;
}

let worker: Worker | null = null;
let header: Int32Array | null = null;
let payloadView: Uint8Array | null = null;
const decoder = new TextDecoder();

function ensureBridge(): Worker {
  if (!worker) {
    const sab = new SharedArrayBuffer(SAB_BYTES);

    header = new Int32Array(sab, 0, 2);
    payloadView = new Uint8Array(sab, PAYLOAD_OFFSET);
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { sab },
    });
    worker.on("error", () => {
      worker = null;
    });
    worker.unref();
  }

  return worker;
}

export function d1QuerySync(
  config: D1Config,
  body: { sql: string; params?: Array<string | number | null> },
): D1StatementResult[] {
  const w = ensureBridge();

  if (!header || !payloadView) {
    throw new Error("D1 브리지 초기화 실패");
  }

  Atomics.store(header, 0, 0);
  w.postMessage({
    url:
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}` +
      `/d1/database/${config.databaseId}/query`,
    token: config.apiToken,
    body,
  });

  const deadline = Date.now() + REQUEST_TIMEOUT_MS;

  while (Atomics.load(header, 0) === 0) {
    Atomics.wait(header, 0, 0, WAIT_SLICE_MS);

    if (Date.now() > deadline) {
      throw new Error(`D1 요청 시간 초과 (${REQUEST_TIMEOUT_MS / 1000}s)`);
    }
  }

  const len = Atomics.load(header, 1);
  const text = decoder.decode(payloadView.subarray(0, len));

  let envelope: BridgeEnvelope;

  try {
    envelope = JSON.parse(text) as BridgeEnvelope;
  } catch {
    throw new Error(`D1 브리지: 응답 파싱 실패 — ${text.slice(0, 200)}`);
  }

  if (!envelope.ok) {
    throw new Error(`D1 요청 실패: ${envelope.error}`);
  }

  const json = envelope.json;

  if (envelope.status !== 200 || !json || json.success === false) {
    const detail =
      json && Array.isArray(json.errors) && json.errors.length > 0
        ? json.errors
            .map((e) => `[${e.code ?? "?"}] ${e.message ?? "?"}`)
            .join(" / ")
        : envelope.snippet ?? "응답 본문 없음";
    throw new Error(`D1 HTTP ${envelope.status}: ${detail}`);
  }

  return json.result ?? [];
}

/** node:sqlite 바인딩 값을 D1 REST 파라미터(JSON 안전 값)로 변환. */
function toD1Param(value: SqlValue | undefined): string | number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    // sqlite는 NaN/Infinity를 NULL로 저장 — 동일 행동 유지.
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "bigint") {
    if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
      return Number(value);
    }

    return value.toString();
  }

  if (typeof value === "string") return value;

  throw new Error(
    `D1 바인딩 미지원 타입: ${Object.prototype.toString.call(value)}`,
  );
}

class D1Statement implements Statement {
  constructor(
    private readonly config: D1Config,
    private readonly sql: string,
  ) {}

  private query(params: SqlValue[]): D1StatementResult {
    const body: { sql: string; params?: Array<string | number | null> } = {
      sql: this.sql,
    };
    const sanitized = params.map(toD1Param);

    if (sanitized.length > 0) body.params = sanitized;

    const results = d1QuerySync(this.config, body);

    if (!results || results.length !== 1) {
      throw new Error(
        `D1 응답 이상: prepare는 단일 구문이어야 함 (결과 ${results?.length ?? 0}개)`,
      );
    }

    return results[0];
  }

  run(...params: SqlValue[]): RunResult {
    const r = this.query(params);

    return {
      changes: r.meta?.changes ?? 0,
      lastInsertRowid: r.meta?.last_row_id ?? 0,
    };
  }

  get(...params: SqlValue[]): Record<string, unknown> | undefined {
    return this.query(params).results[0];
  }

  all(...params: SqlValue[]): Record<string, unknown>[] {
    return this.query(params).results;
  }
}

export class D1Db implements Db {
  private readonly config: D1Config;

  constructor(config?: D1Config) {
    this.config = config ?? loadD1Config();
  }

  prepare(sql: string): Statement {
    return new D1Statement(this.config, sql);
  }

  exec(sql: string): void {
    const trimmed = sql.trim();

    // D1이 거부하거나 의미 없는 구문은 조용히 스킵.
    if (/^(BEGIN|COMMIT|END|ROLLBACK)\b/i.test(trimmed)) return;

    if (/^PRAGMA\s+(journal_mode|foreign_keys|wal_checkpoint)\b/i.test(trimmed)) {
      return;
    }

    // 다중 구문은 그대로 — D1이 한 요청 안에서 원자 실행한다.
    d1QuerySync(this.config, { sql: trimmed });
  }

  close(): void {
    // HTTP 기반이라 닫을 연결이 없다.
  }
}
