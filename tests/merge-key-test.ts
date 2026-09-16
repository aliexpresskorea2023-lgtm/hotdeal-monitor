import { computeMergeKeys, productKeyFromUrl } from "../src/db/queries";

/*
 * 카드 병합 키(2단계) 단위 검증.
 *
 * computeMergeKeys는 피드·히스토리·어드민이 공유하는 유효 병합 키 합성.
 * 우선순위 product_key_override > URL 키 > 게시글 폴백과,
 * "urlKey는 오버라이드와 무관하게 항상 실제 URL 기준"이라는 불변식을
 * 고정한다 (썸네일 조회·사망링크 판정이 수동 병합 키에 오염되면 안 됨).
 *
 * 실행: npx tsx tests/merge-key-test.ts  (실패 시 exit 1)
 */

type Deal = Parameters<typeof computeMergeKeys>[0];

function deal(over: Partial<Deal> = {}): Deal {
  return {
    product_url: null,
    url_override: null,
    product_key_override: null,
    seq: 0,
    community: "arca",
    post_id: "1000",
    ...over,
  };
}

let failures = 0;
let count = 0;

function eq(actual: unknown, expected: unknown, label: string): void {
  count += 1;
  if (actual !== expected) {
    failures += 1;
    console.error(`  FAIL ${label}\n    expected: ${expected}\n    actual:   ${actual}`);
  } else {
    console.log(`  ok   ${label}`);
  }
}

console.log("computeMergeKeys — 우선순위");

/* 1. product_key_override가 URL 키를 이긴다. */
{
  const { key, urlKey } = computeMergeKeys(
    deal({
      product_url: "https://www.coupang.com/vp/products/111?itemId=222",
      product_key_override: "merged:canon",
    }),
  );
  eq(key, "merged:canon", "override beats urlKey (key)");
  eq(
    urlKey,
    "www.coupang.com/vp/products/111?itemId=222",
    "urlKey stays URL-based despite override",
  );
}

/* 2. product_key_override가 게시글 폴백을 이긴다 (링크 없는 카드 병합). */
{
  const { key, urlKey } = computeMergeKeys(
    deal({ product_key_override: "merged:canon", seq: 3, post_id: "777" }),
  );
  eq(key, "merged:canon", "override beats post fallback");
  eq(urlKey, null, "no url -> urlKey null");
}

/* 3. 오버라이드 없으면 URL 키가 키. */
{
  const { key } = computeMergeKeys(
    deal({ product_url: "https://ko.aliexpress.com/item/1005008347365017.html" }),
  );
  eq(key, "ko.aliexpress.com/item/1005008347365017.html", "urlKey used when no override");
}

/* 4. 오버라이드·URL 모두 없으면 게시글 폴백. */
{
  const { key } = computeMergeKeys(
    deal({ community: "quasarzone", post_id: "555", seq: 2 }),
  );
  eq(key, "post:quasarzone:555#2", "post fallback key");
}

/* 5. url_override가 product_url보다 우선 (URL 키 산출 시). */
{
  const { key } = computeMergeKeys(
    deal({
      product_url: "https://a.example.com/x",
      url_override: "https://www.lotteon.com/product/LO123",
    }),
  );
  eq(key, "www.lotteon.com/product/LO123", "url_override wins for urlKey");
}

/* 6. 단축링크 해석(resolutions)이 URL 키에 반영된다. */
{
  const short = "https://link.coupang.com/a/ABC";
  const resolvedUrl = "https://www.coupang.com/vp/products/999?itemId=888";
  const { key } = computeMergeKeys(
    deal({ product_url: short }),
    new Map([[short, resolvedUrl]]),
  );
  eq(key, "www.coupang.com/vp/products/999?itemId=888", "resolution feeds urlKey");
}

/* 7. 오늘의집 별칭 주소는 하나의 정규 키로 접힌다 (PATH_ALIASES). */
{
  const a = computeMergeKeys(
    deal({ product_url: "https://ohou.se/productions/3739448/selling" }),
  ).key;
  const b = computeMergeKeys(
    deal({ product_url: "https://store.ohou.se/goods/3739448#option" }),
  ).key;
  eq(a, "ohou.se/productions/3739448", "ohou canonical A");
  eq(b, a, "ohou alias folds to same key");
}

/* 8. 같은 상품 두 카드 — override로 키를 맞추면 병합된다. */
{
  const canonical = "www.coupang.com/vp/products/111?itemId=222";
  const left = computeMergeKeys(
    deal({
      product_url: "https://www.coupang.com/vp/products/111?itemId=222",
      product_key_override: canonical,
      community: "arca",
      post_id: "1",
    }),
  ).key;
  const right = computeMergeKeys(
    deal({
      product_url: null,
      product_key_override: canonical,
      community: "quasarzone",
      post_id: "2",
      seq: 1,
    }),
  ).key;
  eq(left, right, "override unifies url-bearing and url-less cards");
  eq(left, canonical, "unified key equals canonical");
}

console.log("productKeyFromUrl — 트래킹 파라미터 제거");
{
  eq(
    productKeyFromUrl("https://www.coupang.com/vp/products/111?itemId=222&utm_source=x&fbclid=y"),
    "www.coupang.com/vp/products/111?itemId=222",
    "tracking params stripped, identity kept",
  );
  eq(productKeyFromUrl("not a url"), null, "invalid url -> null");
}

console.log(`\n${count - failures}/${count} 통과`);
if (failures > 0) process.exit(1);
