import fs from "node:fs";
import path from "node:path";
import { parseRuliwebHtml } from "../src/parsers/ruliweb";

/*
 * 루리웹 파서 출력 눈 확인용 테스트.
 *
 * 6개 fixture를 파싱해서 JSON으로 덤프한다.
 * 스키마 정합성은 schema-validation-test.ts가 담당하고,
 * 여기서는 값 자체가 의도대로 추출됐는지 확인한다.
 *
 * fixture 구성:
 * - 106654: 단일 상품, 괄호형 "(46,500원/무료)", 직접 출처 링크
 * - 106377: 알리익스프레스 기획전 모음글 (관리자 글, 쿠폰 나열)
 * - 106652: 가격 없는 세일 글, 빈 본문
 * - 106658: 쿠팡 상품, link.php 래핑 링크
 * - 106648: 슬래시 나열형 "/ 10,000원 / 무배"
 * - 106634: 통화기호(￦) 가격, 스팀 직접 링크
 */

const fixtures = [
  { file: "ruliweb-106654.html", no: "106654" },
  { file: "ruliweb-106377.html", no: "106377" },
  { file: "ruliweb-106652.html", no: "106652" },
  { file: "ruliweb-106658.html", no: "106658" },
  { file: "ruliweb-106648.html", no: "106648" },
  { file: "ruliweb-106634.html", no: "106634" },
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

  const result = parseRuliwebHtml(html, {
    sourceUrl: `https://bbs.ruliweb.com/community/board/1020/read/${fixture.no}`,
  });

  console.log(`\n===== ${fixture.file} =====`);
  console.log(JSON.stringify(result, null, 2));
}
