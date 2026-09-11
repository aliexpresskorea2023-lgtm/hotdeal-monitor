/*
 * fmkorea 파서 오류 일회성 수리 스크립트 (2026-09-11).
 *
 * 버그: 본문 상품 섹션의 지마켓 링크 `goodscode=NNNNNNNNNN` 숫자가
 * 가격 정규식 `=` 분기에 걸려 터무니없는 가격(예: 4,740,761,396원)과
 * 상품명에 URL이 섞인 채 적재됐다. 파서는 stripUrls()로 수정 완료.
 *
 * 이 스크립트는 오염_signature를 가진 펨코 게시글(딜 가격 1억 이상
 * 또는 상품명에 http 잔존)만 골라 스냅샷 재파싱 → 딜 필드 동기화.
 * 게시글 행·관측치는 건드리지 않고, 딜 개수가 달라진 글은 건너뛴다.
 *
 * openDb()를 쓰므로 DB_BACKEND에 따라 sqlite/D1 모두 수리 가능.
 *
 * 실행:
 *   npx tsx scripts/repair-fmkorea-deals.ts            # 적용
 *   npx tsx scripts/repair-fmkorea-deals.ts --dry-run  # 보고만
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_DB_PATH, openDb } from "../src/db";
import { parseFmkoreaHtml } from "../src/parsers/fmkorea";
import { normalizeFmkoreaDeal } from "../src/parsers/normalize";

const CRAWLS_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "data",
  "crawls",
);

const dryRun = process.argv.includes("--dry-run");

/* 오염 판정: 가격 1억 이상(10자리 goodscode) 또는 상품명에 URL 잔존. */
const ABSURD_PRICE = 100_000_000;

const db = openDb(DEFAULT_DB_PATH);

type DealRow = {
  post_rowid: number;
  post_id: string;
  title: string;
  snapshot_path: string;
  seq: number;
  product_name: string | null;
  normalized_name: string | null;
  category: string | null;
  store: string | null;
  product_id: string | null;
  item_id: string | null;
  deal_price: number | null;
  currency: string | null;
  price_text: string | null;
  shipping: number | null;
  shipping_text: string | null;
  condition: string;
  product_url: string | null;
  url_type: string;
  original_product_url: string | null;
  raw_price: string | null;
  raw_shipping: string | null;
  discount_types: string | null;
  discount_codes: string | null;
  discount_stackable: string | null;
  discount_alternatives: string | null;
  discount_description: string | null;
};

const rows = db
  .prepare(
    `SELECT p.id AS post_rowid, p.post_id, p.title, p.snapshot_path,
            d.seq, d.product_name, d.normalized_name, d.category, d.store,
            d.product_id, d.item_id, d.deal_price, d.currency, d.price_text,
            d.shipping, d.shipping_text, d.condition,
            d.product_url, d.url_type, d.original_product_url,
            d.raw_price, d.raw_shipping,
            d.discount_types, d.discount_codes, d.discount_stackable,
            d.discount_alternatives, d.discount_description
     FROM posts p
     JOIN deals d ON d.post_rowid = p.id
     WHERE p.community = 'fmkorea'
       AND EXISTS (
         SELECT 1 FROM deals x
         WHERE x.post_rowid = p.id
           AND (x.deal_price >= ? OR x.product_name LIKE '%http%')
       )
     ORDER BY p.id, d.seq`,
  )
  .all(ABSURD_PRICE) as DealRow[];

const byPost = new Map<number, DealRow[]>();

for (const row of rows) {
  const bucket = byPost.get(row.post_rowid) ?? [];
  bucket.push(row);
  byPost.set(row.post_rowid, bucket);
}

console.log(
  `오염 후보 펨코 게시글 ${byPost.size}개 / 딜 ${rows.length}행${dryRun ? " (dry-run)" : ""}`,
);

const update = db.prepare(
  `UPDATE deals
   SET product_name = ?, normalized_name = ?, category = ?, store = ?,
       product_id = ?, item_id = ?,
       deal_price = ?, currency = ?, price_text = ?,
       shipping = ?, shipping_text = ?, condition = ?,
       product_url = ?, url_type = ?, original_product_url = ?,
       raw_price = ?, raw_shipping = ?,
       discount_types = ?, discount_codes = ?, discount_stackable = ?,
       discount_alternatives = ?, discount_description = ?
   WHERE post_rowid = ? AND seq = ?`,
);

let repaired = 0;
let skipped = 0;

for (const [postRowid, postRows] of byPost) {
  const snapshotPath = path.join(CRAWLS_ROOT, postRows[0].snapshot_path);

  if (!existsSync(snapshotPath)) {
    console.log(`스냅샷 없음 건너뜀: ${postRows[0].post_id}`);
    skipped += postRows.length;
    continue;
  }

  const html = readFileSync(snapshotPath, "utf-8");
  const parsed = parseFmkoreaHtml(html, {
    sourceUrl: `https://www.fmkorea.com/${postRows[0].post_id}`,
  });
  const deals = normalizeFmkoreaDeal(parsed as never) as Array<{
    product: {
      name: string | null;
      normalizedName: string | null;
      category: string | null;
      store: string | null;
      productId: string | null;
    };
    price: {
      dealPrice: number | null;
      currency: string;
      priceText: string | null;
      shipping: number | null;
      shippingText: string | null;
      condition: string;
    };
    purchase: { productUrl: string | null; urlType: string; itemId: string | null };
    sourceMeta: {
      originalProductUrl: string | null;
      rawPrice: string | null;
      rawShipping: string | null;
    };
    discount: {
      types: unknown;
      codes: unknown;
      stackable: unknown;
      alternatives: unknown;
      description: string | null;
    };
  }>;

  if (deals.length !== postRows.length) {
    console.log(
      `개수 불일치 건너뜀: ${postRows[0].post_id} ` +
        `(DB ${postRows.length} vs 재파싱 ${deals.length}) | ` +
        postRows[0].title.slice(0, 50),
    );
    skipped += postRows.length;
    continue;
  }

  for (let seq = 0; seq < deals.length; seq++) {
    const old = postRows[seq];
    const fresh = deals[seq];

    const next = {
      product_name: fresh.product.name,
      normalized_name: fresh.product.normalizedName,
      category: fresh.product.category,
      store: fresh.product.store,
      product_id: fresh.product.productId,
      item_id: fresh.purchase.itemId,
      deal_price: fresh.price.dealPrice,
      currency: fresh.price.currency,
      price_text: fresh.price.priceText,
      shipping: fresh.price.shipping,
      shipping_text: fresh.price.shippingText,
      condition: fresh.price.condition,
      product_url: fresh.purchase.productUrl,
      url_type: fresh.purchase.urlType,
      original_product_url: fresh.sourceMeta.originalProductUrl,
      raw_price: fresh.sourceMeta.rawPrice,
      raw_shipping: fresh.sourceMeta.rawShipping,
      discount_types: JSON.stringify(fresh.discount.types),
      discount_codes: JSON.stringify(fresh.discount.codes),
      discount_stackable: JSON.stringify(fresh.discount.stackable),
      discount_alternatives: JSON.stringify(fresh.discount.alternatives),
      discount_description: fresh.discount.description,
    };

    const changes: string[] = [];

    for (const key of Object.keys(next) as Array<keyof typeof next>) {
      if ((old[key] ?? null) !== (next[key] ?? null)) {
        changes.push(key);
      }
    }

    if (changes.length === 0) {
      continue;
    }

    console.log(
      `수리: ${postRows[0].post_id} seq${seq} [${changes.join(", ")}] | ` +
        postRows[0].title.slice(0, 40),
    );
    console.log(
      `  가격: ${old.deal_price} → ${next.deal_price} / ` +
        `이름: ${JSON.stringify(old.product_name)} → ${JSON.stringify(next.product_name)}`,
    );

    if (!dryRun) {
      update.run(
        next.product_name,
        next.normalized_name,
        next.category,
        next.store,
        next.product_id,
        next.item_id,
        next.deal_price,
        next.currency,
        next.price_text,
        next.shipping,
        next.shipping_text,
        next.condition,
        next.product_url,
        next.url_type,
        next.original_product_url,
        next.raw_price,
        next.raw_shipping,
        next.discount_types,
        next.discount_codes,
        next.discount_stackable,
        next.discount_alternatives,
        next.discount_description,
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
  `펨코 오염 게시글 ${byPost.size}개 / 딜 ${rows.length}행 점검, ` +
    `수리 ${repaired}건, 건너뜀 ${skipped}건`,
);

if (dryRun) {
  console.log("--dry-run: 수정하지 않고 종료합니다.");
}
