import fs from "node:fs";
import path from "node:path";
import { parseFmkoreaHtml } from "../src/parsers/fmkorea";
import { normalizeFmkoreaDeal } from "../src/parsers/normalize";

/*
 * 펨코 URL 숫자 가격 오인식 회귀 테스트 (2026-09-11, 10321755206).
 *
 * 버그: 본문 상품 섹션에 지마켓 링크(`...&goodscode=4740761396`)가
 * 함께 있으면, 가격 정규식의 첫 번째 분기 `(?:=|가격\s*:?)`가
 * `=4740761396`를 가격으로 잡아 47억 원짜리 키보드가 적재됐다.
 *
 * 수정: 가격·상품명 추출 직전 stripUrls()로 URL 토큰을 제거하고,
 * 가격 라벨 분기는 `=` 단독이 아닌 `가격` 키워드 필수로 좁힘.
 *
 * 이 테스트는 실사례 fixture로 (1) 터무니없는 가격(1억 원 이상)이
 * 없는지, (2) 기대 가격 5종이 나오는지, (3) 상품명에 URL이 섞이지
 * 않는지 회귀 검증한다.
 */

const html = fs.readFileSync(
  path.join(process.cwd(), "tests", "fixtures", "fmkorea-10321755206.html"),
  "utf-8",
);

const result = parseFmkoreaHtml(html, {
  sourceUrl: "https://www.fmkorea.com/10321755206",
});

const deals = normalizeFmkoreaDeal(result as never) as Array<{
  product: { name: string | null };
  price: { dealPrice: number | null };
  purchase: { productUrl: string | null };
}>;

let failed = 0;

const expectPrices = [37600, 45900, 50220, 49410, 47790];

if (deals.length !== expectPrices.length) {
  failed++;
  console.log(
    `FAIL 딜 개수: 기대 ${expectPrices.length}, 실제 ${deals.length}`,
  );
} else {
  console.log(`PASS 딜 개수: ${deals.length}`);
}

for (let i = 0; i < deals.length; i++) {
  const deal = deals[i];
  const price = deal.price.dealPrice;

  // (1) 터무니없는 가격 차단 — goodscode류 10자리 숫자는 1억 초과.
  if (price !== null && price >= 100_000_000) {
    failed++;
    console.log(
      `FAIL deals[${i}] 비정상 가격: ${price} (상품명=${deal.product.name})`,
    );
    continue;
  }

  // (2) 기대 가격 일치.
  if (price !== expectPrices[i]) {
    failed++;
    console.log(
      `FAIL deals[${i}] 가격: 기대 ${expectPrices[i]}, 실제 ${price}`,
    );
    continue;
  }

  // (3) 상품명에 URL 잔존 금지.
  if (deal.product.name && /https?:\/\//i.test(deal.product.name)) {
    failed++;
    console.log(
      `FAIL deals[${i}] 상품명에 URL 잔존: ${deal.product.name}`,
    );
    continue;
  }

  console.log(
    `PASS deals[${i}] 가격 ${price} / 상품명 ${deal.product.name} / 링크 ${deal.purchase.productUrl ?? "(없음)"}`,
  );
}

// 링크는 URL 제거와 무관하게 유지되어야 한다 (goodscode 포함 전체 URL).
const linked = deals.filter((d) => d.purchase.productUrl).length;
if (linked < 4) {
  failed++;
  console.log(`FAIL 상품 링크 손실: ${linked}건만 추출 (기대 4건 이상)`);
} else {
  console.log(`PASS 상품 링크 유지: ${linked}건`);
}

if (failed > 0) {
  console.log(`\n${failed}개 검증 실패`);
  process.exit(1);
}

console.log("\n펨코 URL 숫자 가격 오인식 회귀 케이스 전부 통과.");
