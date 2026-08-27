import fs from "node:fs";
import path from "node:path";
import { parsePpomppuHtml } from "../src/parsers/ppomppu";

/*
 * 가격 마커 라인 회귀 테스트 (2026-08-27)
 *
 * 버그: 체감가/혜택가/할인가 같은 마커 라인을 파싱할 때
 * 라인 전체의 첫 단위 토큰을 채택해서, 마커 앞에 나온
 * 적립금/정가 금액이 상품 가격으로 잡혔다.
 *
 * 실사례:
 * - 303707 "네멤이면 적립금 1,000원정도 있어서 체감가 4천원대"
 *   → 적립금 1,000원이 가격으로 적재됨. 정답은 제목의 5,400원.
 * - 303702 "월 101,400원 → [카드 할인가] 월 59,400원"
 *   → 정가 101,400원이 잡힘. 마커가 가리키는 값은 59,400원.
 *
 * 수정: 마커 뒤 구간만 파싱. 이 테스트는 두 실사례 스냅샷으로
 * 수정이 유지되는지 지킨다.
 */

type Expectation = {
  file: string;
  no: string;
  prices: Array<number | null>;
};

const cases: Expectation[] = [
  {
    file: "ppomppu-303707.html",
    no: "303707",
    prices: [5400],
  },
  {
    /*
     * 10개 모델 나열 중 9개만 그룹핑 — 10번째는 뒤에 상품
     * 링크가 없어 그룹핑 요건(이름+가격+링크) 미달. 기존 정책.
     */
    file: "ppomppu-303702.html",
    no: "303702",
    prices: [
      59400, 59600, 80200, 15200, 10900, 70300, 28200, 119200,
      15900,
    ],
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

  const actual = result.products.map((product) => product.price);

  const ok =
    actual.length === expected.prices.length &&
    actual.every((price, index) => price === expected.prices[index]);

  if (ok) {
    console.log(`PASS ${expected.file}: [${actual.join(", ")}]`);
  } else {
    failed++;
    console.log(
      `FAIL ${expected.file}: 기대 [${expected.prices.join(", ")}] ` +
        `실제 [${actual.join(", ")}]`,
    );
  }
}

if (failed > 0) {
  console.log(`\n${failed}개 케이스 실패`);
  process.exit(1);
}

console.log("\n가격 마커 회귀 케이스 전부 통과.");
