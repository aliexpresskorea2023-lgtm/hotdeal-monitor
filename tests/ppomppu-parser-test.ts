import fs from "node:fs";
import path from "node:path";
import { parsePpomppuHtml } from "../src/parsers/ppomppu";

/*
 * 뽐뿌 파서 출력 눈 확인용 테스트.
 *
 * 5개 fixture를 파싱해서 JSON으로 덤프한다.
 * 스키마 정합성은 schema-validation-test.ts가 담당하고,
 * 여기서는 값 자체가 의도대로 추출됐는지 확인한다.
 *
 * fixture 구성:
 * - 303717: 일반 단일 상품 (네이버 계란, 쇼핑커넥트 제휴 공시)
 * - 303709: 다중 상품 (토스 7개, toss.shopping 앱 링크)
 * - 303693: 쿠팡 SmartEditor 마크업, 최대혜택가
 * - 303711: 체감가 변형 5개 (라이브커머스형)
 * - 303705: 할인 전 가격(취소선)과 판매가 공존
 * - 303707: 마커 앞 적립금 토큰 회귀 (제목 5,400원이 정답)
 * - 303702: 렌탈 다중 상품, 마커(카드 할인가) 뒤 가격 채택
 */

const fixtures = [
  { file: "ppomppu-303717.html", no: "303717" },
  { file: "ppomppu-303709.html", no: "303709" },
  { file: "ppomppu-303693.html", no: "303693" },
  { file: "ppomppu-303711.html", no: "303711" },
  { file: "ppomppu-303705.html", no: "303705" },
  { file: "ppomppu-303707.html", no: "303707" },
  { file: "ppomppu-303702.html", no: "303702" },
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

  const result = parsePpomppuHtml(html, {
    sourceUrl: `https://www.ppomppu.co.kr/zboard/view.php?id=pmarket&no=${fixture.no}`,
  });

  console.log(`\n===== ${fixture.file} =====`);
  console.log(JSON.stringify(result, null, 2));
}
