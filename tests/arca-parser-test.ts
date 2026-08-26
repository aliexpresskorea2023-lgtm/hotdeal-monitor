import fs from "node:fs";
import path from "node:path";
import { parseArcaHtml } from "../src/parsers/arca";
import { normalizeArcaDeal } from "../src/parsers/normalize";

/*
 * 아카라이브 파서 출력 눈 확인용 테스트.
 *
 * fixture를 파싱해서 JSON으로 덤프한다.
 * 스키마 정합성은 schema-validation-test.ts가 담당하고,
 * 여기서는 값 자체가 의도대로 추출됐는지 확인한다.
 *
 * fixture 구성:
 * - 181074117: LIVE 버블(진행), 알리익스프레스, USD 가격($14.15,
 *   exchange 요소), unsafelink 래핑 링크, 본문 할인코드 KR0860
 * - 181059656: close-deal 클래스(종료), 닌텐도, KRW 가격(648,000원),
 *   폼 값 td에도 close-deal 클래스
 * - 181046107: LIVE 버블(진행), 슥닷컴, KRW 가격(372,000원),
 *   배송비 금액형(2,500원), 쿼리스트링 있는 ssg 링크
 */

const fixtures = [
  { file: "arca-181074117.html", no: "181074117" },
  { file: "arca-181059656.html", no: "181059656" },
  { file: "arca-181046107.html", no: "181046107" },
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

  const result = parseArcaHtml(html, {
    sourceUrl: `https://arca.live/b/hotdeal/${fixture.no}`,
  });

  console.log(`\n===== ${fixture.file} =====`);
  console.log(JSON.stringify(result, null, 2));

  console.log("\n----- normalized Deal[] -----");
  console.log(
    JSON.stringify(normalizeArcaDeal(result), null, 2),
  );
}
