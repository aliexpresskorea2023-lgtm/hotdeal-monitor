import fs from "node:fs";
import path from "node:path";
import { parseQuasarzoneHtml } from "../src/parsers/quasarzone";
import { normalizeQuasarzoneDeal } from "../src/parsers/normalize";

/*
 * 퀘이사존 파서 출력 눈 확인용 테스트.
 *
 * fixture를 파싱해서 JSON으로 덤프한다.
 * 스키마 정합성은 schema-validation-test.ts가 담당하고,
 * 여기서는 값 자체가 의도대로 추출됐는지 확인한다.
 *
 * fixture 구성:
 * - 1981697: 단일 상품, 폼(링크/판매처/가격/배송비),
 *   goToLink base64 래핑 링크, 상태 라벨 "진행중"
 * - 1981955: 종료 라벨(label done), 배송비 금액형(2,500),
 *   기타사항=리퍼 추가 행
 * - 1981594: 알리 스토어, ￦…원 가격, "무료 / 직배가능",
 *   본문 할인코드 2개, aliexpress item URL
 * - 1980739: 인기 라벨(label mint — 상태 신호 아님),
 *   USD 가격($ 43.32), 본문 할인코드
 */

const fixtures = [
  { file: "quasarzone-1981697.html", no: "1981697" },
  { file: "quasarzone-1981955.html", no: "1981955" },
  { file: "quasarzone-1981594.html", no: "1981594" },
  { file: "quasarzone-1980739.html", no: "1980739" },
];

for (const fixture of fixtures) {
  const html = fs.readFileSync(
    path.join(
      process.cwd(),
      "tests",
      "fixtures",
      fixture.file,
    ),
    "utf-8",
  );

  const result = parseQuasarzoneHtml(html, {
    sourceUrl: `https://quasarzone.com/bbs/qb_saleinfo/views/${fixture.no}`,
  });

  console.log(`\n===== ${fixture.file} =====`);
  console.log(JSON.stringify(result, null, 2));

  console.log("\n----- normalized Deal[] -----");
  console.log(
    JSON.stringify(normalizeQuasarzoneDeal(result), null, 2),
  );
}
