/*
 * ppomppu 마커 가격 오류 일회성 수리 스크립트.
 *
 * 원인(2026-08-27 발견): 가격 마커(체감가/혜택가/판매가/할인가...)
 * 라인을 파싱할 때 라인 전체에서 첫 단위 토큰을 채택해서,
 * 마커 앞에 나온 적립금/정가 토큰이 상품 가격으로 잡혔다.
 * 예: "네멤이면 적립금 1,000원정도 있어서 체감가 4천원대"
 *     → 1,000원이 가격으로 적재됨 (정답: 제목의 5,400원).
 *
 * 파서는 마커 뒤 구간만 파싱하도록 수정 완료. 이 스크립트는
 * 이미 적재된 ppomppu 딜을 스냅샷 기준으로 재파싱해 가격
 * 필드만 수리한다 (게시글 행·관측치·다른 필드는 건드리지 않음).
 *
 * 실행:
 *   npx tsx scripts/repair-ppomppu-prices.ts            # 적용
 *   npx tsx scripts/repair-ppomppu-prices.ts --dry-run  # 보고만
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_DB_PATH, openDb } from "../src/db";
import { parsePpomppuHtml } from "../src/parsers/ppomppu";
import { normalizePpomppuDeal } from "../src/parsers/normalize";

const CRAWLS_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "data",
  "crawls",
);

const dryRun = process.argv.includes("--dry-run");

const db = openDb(DEFAULT_DB_PATH);

const rows = db
  .prepare(
    `SELECT p.id AS post_rowid, p.post_id, p.title, p.snapshot_path,
            d.seq, d.deal_price, d.currency, d.price_text, d.raw_price
     FROM posts p
     JOIN deals d ON d.post_rowid = p.id
     WHERE p.community = 'ppomppu'
     ORDER BY p.id, d.seq`,
  )
  .all() as Array<{
  post_rowid: number;
  post_id: string;
  title: string;
  snapshot_path: string;
  seq: number;
  deal_price: number | null;
  currency: string | null;
  price_text: string | null;
  raw_price: string | null;
}>;

const byPost = new Map<number, typeof rows>();

for (const row of rows) {
  const bucket = byPost.get(row.post_rowid) ?? [];
  bucket.push(row);
  byPost.set(row.post_rowid, bucket);
}

const update = db.prepare(
  `UPDATE deals
   SET deal_price = ?, currency = ?, price_text = ?, raw_price = ?
   WHERE post_rowid = ? AND seq = ?`,
);

let repaired = 0;
let skipped = 0;

for (const [postRowid, postRows] of byPost) {
  const snapshotPath = path.join(CRAWLS_ROOT, postRows[0].snapshot_path);

  if (!existsSync(snapshotPath)) {
    skipped += postRows.length;
    continue;
  }

  const html = readFileSync(snapshotPath, "utf-8");
  const deal = parsePpomppuHtml(html, {
    sourceUrl: `https://www.ppomppu.co.kr/zboard/view.php?id=pmarket&no=${postRows[0].post_id}`,
  });
  const deals = normalizePpomppuDeal(deal);

  if (deals.length !== postRows.length) {
    /*
     * 딜 개수가 달라진 게시글은 가격 필드만 수리하는 이
     * 스크립트의 범위를 벗어난다. (이번 수리 대상 아님.)
     */
    console.log(
      `개수 불일치 건너뜀: ${postRows[0].post_id} ` +
        `(DB ${postRows.length} vs 재파싱 ${deals.length})`,
    );
    skipped += postRows.length;
    continue;
  }

  for (let seq = 0; seq < deals.length; seq++) {
    const oldRow = postRows[seq];
    const price = deals[seq].price;
    const newPrice = price.dealPrice ?? null;
    const newCurrency = price.currency ?? null;
    const newPriceText = price.priceText ?? null;
    const newRawPrice = price.priceText || null;

    if (
      newPrice === oldRow.deal_price &&
      newCurrency === oldRow.currency &&
      newPriceText === oldRow.price_text
    ) {
      continue;
    }

    console.log(
      `수리: ${postRows[0].post_id} seq${seq} ` +
        `${oldRow.deal_price} ${oldRow.currency} → ` +
        `${newPrice} ${newCurrency} | ${postRows[0].title.slice(0, 50)}`,
    );

    if (!dryRun) {
      update.run(
        newPrice,
        newCurrency,
        newPriceText,
        newRawPrice,
        postRowid,
        seq,
      );
    }

    repaired++;
  }
}

db.close();

console.log("---");
console.log(
  `ppomppu 게시글 ${byPost.size}개 / 딜 ${rows.length}행 점검, ` +
    `수리 ${repaired}건, 건너뜀 ${skipped}건`,
);

if (dryRun) {
  console.log("--dry-run: 수정하지 않고 종료합니다.");
}
