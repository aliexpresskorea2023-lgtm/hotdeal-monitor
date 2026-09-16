import { classifyPostKind, composeItemKind } from "../src/parsers/post-kind";

/*
 * 상품 구성(post_kind) 분류 테스트 (2026-09-16).
 *
 * classifyPostKind는 정밀도 우선 보수 분류다. 검증 방향:
 * (1) TP — 실제 다상품/행사 글은 'bundle'.
 * (2) TN — 제품명 오탐(게임번들·워치페이스)과 일반 단품·세트·
 *     단일 제품군 변형 나열은 'single'.
 * (3) composeItemKind — 출처 중 하나라도 single이면 단품.
 *
 * 표본은 2026-09-16 로컬 DB 전수 스캔에서 눈검증한 실제 제목.
 */

let failed = 0;

const BUNDLE_CASES: string[] = [
  "[지마켓] 에잇세컨즈 간절기 가을 옷 50종 모음 (10,740원)",
  "[G마켓,11번가 등] [ 작업용 완본체 모음집 ] 현 시점 구매할만한 작업용 (가격별상이)",
  "[토스] 오늘의쇼핑 8월 14일 특가 모음",
  "[바른곱창] 히밥도 먹고 반한 곱창 (온라인판매가 최대 50%할인 기획전)",
  "[네이버] 러닝기획전 노스페이스 나이키 국내매장판 캡/선글라스/자켓/쇼츠 15~20%할인",
  "[네이버]프롭스 메가위크 세일",
  "[알리] 알리 쿨-다운 위크 세일 할인 코드 (7/1~7/7)",
  "[알리] 에디파이어 MR3 외 스피커 할인 모음",
  "WACOM CTL-4100WL 외 다수 (106,400원/무료)",
  "[오늘의집] 더 빅토리아 탄산수 500mL*20+20개(21종 중 택2)",
  "[기타] 홈플러스 ~9/16 전단지 (미국 계란 30구 3,490원 외 다수)",
  "[LG그램x넾다세일] 역대급 특가 할인!",
  "[네이버] 12시 선착순 넾다세일 9천억 달성 기념 20% 쿠폰",
  "[CJ] 명절 선물세트 스팸 6호 이외 인기 3종 모음전", // 선물세트+모음전 = 진짜 묶음
  "[네이버] 농수산물 할인 모음 새우/복숭아/옥수수/고구마/감자/당근",
  "[서린컴퓨터] [ 가성비 완본체 기획전 ]CAMPUS PC LAB 4종",
];

const SINGLE_CASES: string[] = [
  // 제품명 오탐 방어 (하드 제외)
  "9850X3D 멀티팩 (귀무자 게임번들 프로모션) (721,000원/무료)", // 프로모션 but 단일 CPU
  "[WearOS] samwatch digital nekhbet 워치페이스 외 5종 (무료)", // 단일 디지털 제품군
  // 일반 단품 / 세트(1 SKU) / 변형 나열
  "[쿠팡] 얼라이브 원스데일리 멀티비타민, 60정, 1개 (18,560원)",
  "[알리] Toocki 240w pps pd3.1 충전케이블 (데이터는 usb2.0사양)",
  "[G마켓] 라이프익스텐션 종합비타민 투퍼데이 V2 120정 2개",
  "[네이버] LG 휘센 오브제컬렉션 13L 제습기 DQ134MWEC (354,930원)",
  "[11번가] LG 트롬 오브제컬렉션 세탁기 건조기세트 FX24ENR-GNG",
  "[광동] 당뇨 전단계라는 이야기를 듣고나니 혈당유산균", // 전단(전단계) 오탐 방어
  "[네이버] 얼라이브 멀티 비타 구미 종합 비타민 선물세트 60구미 3개",
  "[쿠팡] 황금향 초고당도 제주 명절선물세트 1개 2kg",
  "[네이버] 독거미 F108 & F108 PRO 키보드 (37,600~)", // 단일 제품군 변형 = 단품
  "[11번가] 십일절 타임딜 해피콜 플렉스팬 IH 와이드 인덕션 후라이팬 22cm",
  "[쿠팡] 삼성 갤럭시 버즈3 프로 (229,000원/무료)",
  "", // 빈 제목
  null as unknown as string, // null 제목
];

for (const title of BUNDLE_CASES) {
  const got = classifyPostKind({ title });
  if (got !== "bundle") {
    failed++;
    console.log(`FAIL (bundle 기대) ${got}: ${String(title).slice(0, 50)}`);
  } else {
    console.log(`PASS bundle: ${String(title).slice(0, 50)}`);
  }
}

for (const title of SINGLE_CASES) {
  const got = classifyPostKind({ title });
  if (got !== "single") {
    failed++;
    console.log(`FAIL (single 기대) ${got}: ${String(title).slice(0, 50)}`);
  } else {
    console.log(`PASS single: ${String(title).slice(0, 50)}`);
  }
}

// composeItemKind 합성 규칙.
const compose: Array<[Parameters<typeof composeItemKind>[0], string]> = [
  [["single", "single"], "single"],
  [["bundle", "single"], "single"], // 하나라도 single이면 단품
  [["bundle", "bundle"], "bundle"],
  [[], "single"],
];
for (const [input, want] of compose) {
  const got = composeItemKind(input);
  if (got !== want) {
    failed++;
    console.log(`FAIL composeItemKind([${input.join(",")}]) 기대 ${want}, 실제 ${got}`);
  } else {
    console.log(`PASS composeItemKind([${input.join(",")}]) → ${got}`);
  }
}

if (failed > 0) {
  console.log(`\n${failed}개 검증 실패`);
  process.exit(1);
}

console.log("\n상품 구성 분류 케이스 전부 통과.");
