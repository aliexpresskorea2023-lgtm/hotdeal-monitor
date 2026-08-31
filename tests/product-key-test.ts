import { productKeyFromUrl } from "../src/db/queries";

/*
 * 상품 식별 키 정규화 테스트.
 *
 * 배경: 핫딜 카드 병합은 구매링크에서 계산한 키로 이루어진다.
 * 같은 상품을 다른 주소 체계로 서비스하는 스토어(오늘의집)에서
 * 키가 찢어져 카드가 갈라지는 사고(5408·5482, 상품 3727926)가
 * 있었고, 별칭 정규화(PATH_ALIASES)로 막았다.
 *
 * 검증 대상:
 * 1. 오늘의집 별칭 — 두 주소 체계 + /selling 접미사가 한 키로
 * 2. 기존 규칙 회귀 — 추적 파라미터 제거, 쿠팡/지마켓 정체성
 *    파라미터, 무관한 주소는 그대로
 */

let failed = 0;

function expectSame(urls: string[], label: string): void {
  const keys = urls.map((url) => productKeyFromUrl(url));
  const first = keys[0];

  if (first === null || keys.some((key) => key !== first)) {
    failed++;
    console.log(`FAIL ${label}`);
    urls.forEach((url, i) => console.log(`  ${url} → ${keys[i]}`));
    return;
  }

  console.log(`PASS ${label} → ${first}`);
}

function expectDifferent(
  urlA: string,
  urlB: string,
  label: string,
): void {
  const keyA = productKeyFromUrl(urlA);
  const keyB = productKeyFromUrl(urlB);

  if (keyA === null || keyB === null || keyA === keyB) {
    failed++;
    console.log(
      `FAIL ${label}: ${keyA} vs ${keyB} (같으면 안 됨)`,
    );
    return;
  }

  console.log(`PASS ${label}`);
}

/* 1. 오늘의집 별칭 */

expectSame(
  [
    "https://ohou.se/productions/3727926/selling",
    "https://store.ohou.se/goods/3727926",
  ],
  "오늘의집: 직접링크(딜 5408)와 스토어 링크(딜 5482)는 같은 상품",
);

expectSame(
  [
    "https://ohou.se/productions/3727926/selling",
    "https://ohou.se/productions/3727926",
  ],
  "오늘의집: /selling 접미사 유무",
);

expectSame(
  [
    "https://store.ohou.se/goods/4070224#4011249",
    "https://store.ohou.se/goods/4070224#4010668",
    "https://store.ohou.se/goods/4070224",
  ],
  "오늘의집: 옵션 프래그먼트(#옵션번호)는 키를 가르지 않음",
);

expectDifferent(
  "https://ohou.se/productions/3727926/selling",
  "https://store.ohou.se/goods/3688590",
  "오늘의집: 상품 번호가 다르면 다른 키",
);

/* 2. 기존 규칙 회귀 */

expectSame(
  [
    "https://example.com/product/123",
    "https://example.com/product/123?utm_source=ppomppu&utm_medium=referral",
  ],
  "추적 파라미터 제거",
);

expectSame(
  [
    "https://www.coupang.com/vp/products/123?itemId=456",
    "https://www.coupang.com/vp/products/123?itemId=456&vendorId=999&tracker=abc",
  ],
  "쿠팡: itemId만 정체성",
);

expectSame(
  [
    "https://item.gmarket.co.kr/Item?goodscode=12345",
    "https://item.gmarket.co.kr/Item?goodscode=12345&cust_rank=1",
  ],
  "지마켓: goodscode만 정체성",
);

expectDifferent(
  "https://www.coupang.com/vp/products/123?itemId=456",
  "https://www.coupang.com/vp/products/123?itemId=789",
  "쿠팡: itemId가 다르면 다른 키",
);

{
  /* 무관한 주소는 경로 보존 (과도한 정규화 금지). */
  const key = productKeyFromUrl(
    "https://prod.danawa.com/info/?pcode=12345678",
  );

  if (key === "prod.danawa.com/info?pcode=12345678") {
    console.log(`PASS 다나와: 정체성 파라미터 없는 주소는 경로·쿼리 보존`);
  } else {
    failed++;
    console.log(`FAIL 다나와 보존: ${key}`);
  }
}

{
  const key = productKeyFromUrl("not a url at all");

  if (key === null) {
    console.log("PASS 잘못된 URL은 null");
  } else {
    failed++;
    console.log(`FAIL 잘못된 URL: ${key}`);
  }
}

if (failed > 0) {
  console.log(`\n${failed}개 케이스 실패`);
  process.exit(1);
}

console.log("\n상품 키 정규화 케이스 전부 통과.");
