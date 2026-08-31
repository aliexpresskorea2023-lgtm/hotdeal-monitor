/*
 * ppomppu 파서 오류 일회성 수리 스크립트.
 *
 * 파서 수정으로 출력이 달라진 기존 적재분을 스냅샷 기준으로
 * 재파싱해 수리한다. 두 번 사용했다:
 *
 * 1차 (2026-08-27): 가격 마커 라인의 라인 전체 파싱 오류.
 *    "네멤이면 적립금 1,000원정도 있어서 체감가 4천원대"에서
 *    적립금 1,000원이 가격으로 잡힘. 수정: 마커 뒤 구간만 파싱.
 * 2차 (2026-08-27): 공구형 "[공구혜택가 125만]" 라벨이 상품명으로
 *    잡히고 진짜 상품명/링크가 끊기던 문제. 수정: 대괄호 라벨 =
 *    섹션 헤더, 라벨 뒤 첫 텍스트 라인이 상품명.
 * 3차 (2026-08-31): 목록형 본문("최종 혜택가…"/"최대 혜택가…"
 *    라벨)에서 마커 앞 수식어가 상품명으로 잡히던 문제(303752 외
 *    2건). 수정: 수식어뿐이면 직전 라인에서 상품명 역추적.
 *
 * 재파싱 출력과 다른 파서 파생 필드(상품명·가격·링크·스토어 등)를
 * 전부 동기화한다. 게시글 행·관측치(price_observations)는 건드리지
 * 않는다. 딜 개수가 달라진 게시글은 범위 밖이라 건너뛴다.
 *
 * 실행:
 *   npx tsx scripts/repair-ppomppu-deals.ts            # 적용
 *   npx tsx scripts/repair-ppomppu-deals.ts --dry-run  # 보고만
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
     WHERE p.community = 'ppomppu'
     ORDER BY p.id, d.seq`,
  )
  .all() as DealRow[];

const byPost = new Map<number, DealRow[]>();

for (const row of rows) {
  const bucket = byPost.get(row.post_rowid) ?? [];
  bucket.push(row);
  byPost.set(row.post_rowid, bucket);
}

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
     * 딜 개수가 달라진 게시글은 행 추가/삭제가 필요해서 이
     * 스크립트(필드 동기화 전용)의 범위를 벗어난다.
     */
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

    if (
      changes.includes("product_name") ||
      changes.includes("product_url") ||
      changes.includes("deal_price")
    ) {
      console.log(
        `  이름: ${JSON.stringify(old.product_name)} → ` +
          `${JSON.stringify(next.product_name)}`,
      );
      console.log(
        `  링크: ${old.product_url ?? "없음"} → ` +
          `${next.product_url ?? "없음"}`,
      );
      console.log(
        `  가격: ${old.deal_price} ${old.currency} → ` +
          `${next.deal_price} ${next.currency}`,
      );
    }

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
  `ppomppu 게시글 ${byPost.size}개 / 딜 ${rows.length}행 점검, ` +
    `수리 ${repaired}건, 건너뜀 ${skipped}건`,
);

if (dryRun) {
  console.log("--dry-run: 수정하지 않고 종료합니다.");
}
