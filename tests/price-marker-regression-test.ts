import fs from "node:fs";
import path from "node:path";
import { parsePpomppuHtml } from "../src/parsers/ppomppu";
import { normalizePpomppuDeal } from "../src/parsers/normalize";

/*
 * 뽐뿌 복수 상품 스킵 정책 회귀 테스트 (2026-09-02 정책 변경).
 *
 * 이전 버전(2026-08-27)은 마커 가격 라인 파싱 버그 3종을 고치고
 * 복수 상품을 실제로 분리해 적재했다. 그러나 뽐뿌는 정형 서식이
 * 없어 파서 유지보수 복잡도가 계속 쌓이고, 그룹핑이 조금만
 * 어긋나도 DB 필드값(상품명·가격·URL)이 뒤섞이는 사고로 이어졌다.
 *
 * 새 정책(사용자 확정): 본문에서 복수 상품 구조가 감지되면
 * products=[]로 스킵한다. 감지 조건은 기존 groupProductSections /
 * findVariantPriceLines 결과를 그대로 재사용한다.
 *
 * 이 테스트는 감지 로직이 무너지지 않았는지(=스킵이 제대로
 * 걸리는지)를 과거 실사례 fixture로 회귀 검증한다.
 *
 * 과거 버그 사례(지금은 스킵으로 방어):
 * - 303707 "네멤이면 적립금 1,000원정도 있어서 체감가 4천원대"
 *   → 단일 상품이라 스킵 대상 아님. 제목 가격 5,400원만 추출.
 * - 303702 "월 101,400원 → [카드 할인가] 월 59,400원" (10모델 나열)
 *   → 복수 상품 감지 → products=[]
 * - 303722 공구형("[공구혜택가 125만]" 라벨 반복, 5모델)
 *   → 복수 상품 감지 → products=[]
 * - 303752 다나와 기획전 목록형(31개 상품, 링크 없음)
 *   → 복수 상품 감지 → products=[]
 */

type Expectation = {
  file: string;
  no: string;
  /** 복수 상품 스킵 대상이면 true, 단일 상품이면 false. */
  multiProduct: boolean;
  /** 단일 상품일 때 기대 가격. */
  singlePrice?: number | null;
};

const cases: Expectation[] = [
  {
    file: "ppomppu-303707.html",
    no: "303707",
    multiProduct: false,
    singlePrice: 5400,
  },
  {
    /* 10개 모델 나열 — 그룹핑 요건(이름+가격+링크) 9개 충족. */
    file: "ppomppu-303702.html",
    no: "303702",
    multiProduct: true,
  },
  {
    /* 공구형 5모델 — 라벨("[공구혜택가 N만]") 반복. */
    file: "ppomppu-303722.html",
    no: "303722",
    multiProduct: true,
  },
  {
    /* 다나와 기획전 목록형 31개 상품 — 링크 없음. */
    file: "ppomppu-303752.html",
    no: "303752",
    multiProduct: true,
  },
];

let failed = 0;

for (const expected of cases) {
  const html = fs.readFileSync(
    path.join(process.cwd(), "tests", "fixtures", expected.file),
    "utf-8",
  );

  const result = parsePpomppuHtml(html, {
    sourceUrl: `https://www.ppomppu.co.kr/zboard/view.php?id=pmarket&no=${expected.no}`,
  });

  if (expected.multiProduct) {
    const productsOk = result.products.length === 0;
    const dealsOk = normalizePpomppuDeal(result).length === 0;

    if (!productsOk || !dealsOk) {
      failed++;
      console.log(
        `FAIL ${expected.file}: 복수 상품 스킵 정책 미적용 ` +
          `(products=${result.products.length}, deals=${normalizePpomppuDeal(result).length})`,
      );
      continue;
    }

    console.log(
      `PASS ${expected.file}: 복수 상품 감지 → products=[] (스킵 정책)`,
    );
    continue;
  }

  /* 단일 상품: 기존 가격 마커 회귀 검증 유지. */
  const price = result.products[0]?.price ?? null;

  if (result.products.length !== 1 || price !== expected.singlePrice) {
    failed++;
    console.log(
      `FAIL ${expected.file}: 단일 상품 기대 가격 ${expected.singlePrice}, ` +
        `실제 ${price} (products=${result.products.length})`,
    );
    continue;
  }

  console.log(`PASS ${expected.file}: 단일 상품 [${price}]`);
}

if (failed > 0) {
  console.log(`\n${failed}개 케이스 실패`);
  process.exit(1);
}

console.log("\n복수 상품 스킵 정책 회귀 케이스 전부 통과.");
