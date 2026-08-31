/*
 * DB 드라이버 추상화 (2026-08-31, D1 이주 1단계).
 *
 * 목적: `node:sqlite`(동기)와 Cloudflare D1(REST, 본질상 비동기)을
 * 호출부 변경 없이 바꿔 끼울 수 있게 하는 최소 공통 인터페이스.
 *
 * - `DatabaseSync`는 이 인터페이스를 구조적으로 충족하므로 기존
 *   sqlite 경로는 그대로 동작한다.
 * - D1 어댑터(d1.ts)는 worker 스레드 + Atomics.wait로 동기 시맨틱을
 *   흉내 낸다. 따라서 모든 메서드는 동기다.
 *
 * 시맨틱 차이(허용된 것):
 * - D1은 명시적 트랜잭션(BEGIN/COMMIT)을 거부한다. d1 어댑터는
 *   이를 무시하고 구문 단위로 즉시 실행한다. 이 코드베이스의
 *   트랜잭션 사용처(ingest-trends, purge-old-trends)는 멱등이라
 *   부분 실패 후 재실행으로 복구 가능 — 계획서 리스크 3의 폴백.
 */

export type SqlValue =
  | number
  | bigint
  | string
  | null
  | Uint8Array;

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: SqlValue[]): RunResult;
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  all(...params: SqlValue[]): Record<string, unknown>[];
}

export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}
