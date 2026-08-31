/*
 * PATH_ALIASES 도입(2026-08-31)에 따른 기존 키 재키잉 일회성 스크립트.
 *
 * 상품 키는 쿼리 시점에 productKeyFromUrl로 계산되므로 그룹핑은
 * 코드 변경 즉시 새 표준 키로 동작한다. 다만 키를 그대로 저장하는
 * 테이블 두 개는 옛 키로 남아 있다:
 *
 *   product_images (썸네일 캐시 + 어드민 이미지 오버라이드)
 *   link_checks    (구매링크 사망 판정 이력)
 *
 * 옛 키를 표준 키로 다시 달면서, 같은 표준 키로 모이는 행끼리는
 * 병합한다 (이미지: 빈 값보다 채워진 값·오버라이드 우선, 점검:
 * 사망 신호가 하나라도 있으면 사망 유지).
 *
 * 범위 사고 방지: 오늘의집 호스트 행만 건드린다 — 이번 별칭
 * 정규화의 대상이 그것뿐이므로.
 *
 * 실행:
 *   npx tsx scripts/rekey-ohou-product-keys.ts --dry-run  # 보고만
 *   npx tsx scripts/rekey-ohou-product-keys.ts            # 적용
 */

import { DEFAULT_DB_PATH, openDb } from "../src/db";
import { productKeyFromUrl } from "../src/db/queries";

const AFFECTED_HOSTS = [
  "ohou.se",
  "www.ohou.se",
  "m.ohou.se",
  "store.ohou.se",
];

const dryRun = process.argv.includes("--dry-run");

const db = openDb(DEFAULT_DB_PATH);

function affectedHost(key: string): boolean {
  const host = key.split("/", 1)[0].toLowerCase();

  return AFFECTED_HOSTS.includes(host);
}

/** 저장 키(host+경로[?쿼리])를 표준 키로. 변화 없으면 그대로. */
function canonicalKey(storedKey: string): string | null {
  if (!affectedHost(storedKey)) {
    return storedKey;
  }

  return productKeyFromUrl(`https://${storedKey}`);
}

/* =========================================================
 * product_images
 * ======================================================= */

type ImageRow = {
  product_key: string;
  image_url: string;
  attempts: number;
  fetched_at: string;
  image_override: string | null;
};

const imageRows = db
  .prepare(
    `SELECT product_key, image_url, attempts, fetched_at, image_override
     FROM product_images`,
  )
  .all() as ImageRow[];

/* 표준 키 → 병합할 행들 */
const imageGroups = new Map<string, ImageRow[]>();

for (const row of imageRows) {
  const key = canonicalKey(row.product_key);

  if (key === null) {
    continue;
  }

  const group = imageGroups.get(key) ?? [];
  group.push(row);
  imageGroups.set(key, group);
}

let imageMoved = 0;
let imageMerged = 0;

const deleteImage = db.prepare(
  `DELETE FROM product_images WHERE product_key = ?`,
);
const insertImage = db.prepare(
  `INSERT INTO product_images
     (product_key, image_url, attempts, fetched_at, image_override)
   VALUES (?, ?, ?, ?, ?)`,
);

for (const [key, group] of imageGroups) {
  const needsRewrite = group.some((row) => row.product_key !== key);

  if (!needsRewrite && group.length === 1) {
    continue;
  }

  /* 병합: 빈 값보다 채워진 값, 오버라이드는 하나라도 있으면 보존. */
  const imageUrl =
    group.find((row) => row.image_url !== "")?.image_url ?? "";
  const imageOverride =
    group.find((row) => row.image_override !== null)?.image_override ??
    null;
  const attempts = Math.max(...group.map((row) => row.attempts));
  const fetchedAt = group
    .map((row) => row.fetched_at)
    .sort()
    .at(-1) as string;

  const oldKeys = group.map((row) => row.product_key);

  console.log(
    `이미지: [${oldKeys.join(" + ")}] → ${key}` +
      (group.length > 1 ? " (병합)" : ""),
  );

  if (dryRun) {
    group.length > 1 ? imageMerged++ : imageMoved++;
    continue;
  }

  for (const oldKey of oldKeys) {
    deleteImage.run(oldKey);
  }

  insertImage.run(key, imageUrl, attempts, fetchedAt, imageOverride);

  group.length > 1 ? imageMerged++ : imageMoved++;
}

/* =========================================================
 * link_checks
 * ======================================================= */

type CheckRow = {
  product_key: string;
  target_url: string;
  last_checked_at: string | null;
  last_status: number | null;
  dead_signals: number;
  dead: number;
};

const checkRows = db
  .prepare(
    `SELECT product_key, target_url, last_checked_at, last_status,
            dead_signals, dead
     FROM link_checks`,
  )
  .all() as CheckRow[];

const checkGroups = new Map<string, CheckRow[]>();

for (const row of checkRows) {
  const key = canonicalKey(row.product_key);

  if (key === null) {
    continue;
  }

  const group = checkGroups.get(key) ?? [];
  group.push(row);
  checkGroups.set(key, group);
}

let checkMoved = 0;
let checkMerged = 0;

const deleteCheck = db.prepare(
  `DELETE FROM link_checks WHERE product_key = ?`,
);
const insertCheck = db.prepare(
  `INSERT INTO link_checks
     (product_key, target_url, last_checked_at, last_status,
      dead_signals, dead)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

for (const [key, group] of checkGroups) {
  const needsRewrite = group.some((row) => row.product_key !== key);

  if (!needsRewrite && group.length === 1) {
    continue;
  }

  /*
   * 병합: 사망 신호는 보수적으로 — 하나라도 사망이면 사망.
   * 대표 점검 기록은 가장 최근 점검 것을 따른다.
   */
  const latest = [...group].sort((a, b) =>
    (b.last_checked_at ?? "").localeCompare(a.last_checked_at ?? ""),
  )[0];
  const dead = Math.max(...group.map((row) => row.dead));
  const deadSignals = Math.max(...group.map((row) => row.dead_signals));

  const oldKeys = group.map((row) => row.product_key);

  console.log(
    `링크점검: [${oldKeys.join(" + ")}] → ${key}` +
      (group.length > 1 ? " (병합)" : ""),
  );

  if (dryRun) {
    group.length > 1 ? checkMerged++ : checkMoved++;
    continue;
  }

  for (const oldKey of oldKeys) {
    deleteCheck.run(oldKey);
  }

  insertCheck.run(
    key,
    latest.target_url,
    latest.last_checked_at,
    latest.last_status,
    deadSignals,
    dead,
  );

  group.length > 1 ? checkMerged++ : checkMoved++;
}

db.close();

console.log("---");
console.log(
  `product_images 재키잉 ${imageMoved}건·병합 ${imageMerged}건, ` +
    `link_checks 재키잉 ${checkMoved}건·병합 ${checkMerged}건`,
);

if (dryRun) {
  console.log("--dry-run: 수정하지 않고 종료합니다.");
}
