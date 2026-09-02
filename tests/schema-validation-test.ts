import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { parseFmkoreaHtml } from "../src/parsers/fmkorea";
import { parsePpomppuHtml } from "../src/parsers/ppomppu";
import { parseRuliwebHtml } from "../src/parsers/ruliweb";
import { parseQuasarzoneHtml } from "../src/parsers/quasarzone";
import { parseArcaHtml } from "../src/parsers/arca";
import {
  normalizeArcaDeal,
  normalizePpomppuDeal,
  normalizeQuasarzoneDeal,
} from "../src/parsers/normalize";

/*
 * 파서 출력이 실제로 hotdeal.schema_v2.0.json을 통과하는지 검증한다.
 *
 * 이 테스트가 있으면, enum 값이 스키마와 어긋나는 실수
 * (예: parser는 "expired"를 반환하는데 스키마는 "ended"만 허용)를
 * console.log로 결과를 눈으로 확인하지 않아도 바로 잡아낼 수 있다.
 */

const ajv = new Ajv2020({ allErrors: true, strict: false });

const schemaPath = path.join(
  process.cwd(),
  "data",
  "schema",
  "hotdeal.schema_v2.0.json",
);

const schema = JSON.parse(
  fs.readFileSync(schemaPath, "utf-8"),
);

const validate = ajv.compile(schema);

function check(label: string, data: unknown): boolean {
  const valid = validate(data);

  if (valid) {
    console.log(`PASS  ${label}`);
    return true;
  }

  console.log(`FAIL  ${label}`);
  console.log(JSON.stringify(validate.errors, null, 2));
  return false;
}

let allPassed = true;

// 1. 실제 fixture로 파싱한 단일 상품 딜
const singleHtml = fs.readFileSync(
  path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "fmkorea-10256359178.html",
  ),
  "utf-8",
);

const singleResult = parseFmkoreaHtml(singleHtml, {
  sourceUrl: "https://www.fmkorea.com/10256359178",
});

allPassed =
  check("single-product fixture", singleResult) && allPassed;

// 2. 다중 상품 fixture
const multiHtml = fs.readFileSync(
  path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "fmkorea-multiproduct-10244835315.html",
  ),
  "utf-8",
);

const multiResult = parseFmkoreaHtml(multiHtml, {
  sourceUrl: "https://www.fmkorea.com/10244835315",
});

allPassed =
  check("multi-product fixture", multiResult) && allPassed;

// 2-1. 라이브에서 발견된 함정 케이스:
// 번호 매김 "할인 받는 방법" 설명이 상품으로 오인식되던 글.
// (수정 후: hotdeal table 기반 단일 상품 + 코드 2개 추출)
const aliHtml = fs.readFileSync(
  path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "fmkorea-10256348563.html",
  ),
  "utf-8",
);

const aliResult = parseFmkoreaHtml(aliHtml, {
  sourceUrl: "https://www.fmkorea.com/10256348563",
});

allPassed =
  check(
    "live aliexpress fixture (how-to trap)",
    aliResult,
  ) && allPassed;

/*
 * 값 수준 회귀 방지:
 * 이 fixture는 과거에 본문 번호 목록("1. 장바구니담기 ...")이
 * 상품으로 분리되며 table 상품명을 덮어쓰던 사례다.
 */
const aliProduct = aliResult.products[0];

const aliAssertions: Array<[string, boolean]> = [
  [
    "ali fixture: 상품 1개만 유지",
    aliResult.products.length === 1,
  ],
  [
    "ali fixture: table 상품명 보존",
    aliProduct?.name ===
      "ALLDOCUBE iPlay80 mini Pro LTE 태블릿",
  ],
  [
    "ali fixture: 할인 코드 추출",
    aliResult.discount.codes.includes("ALPK07") &&
      aliResult.discount.codes.includes("CUBET830"),
  ],
  [
    "ali fixture: 모음글 내부 링크 수집",
    aliResult.sourceMeta.internalLinks.length === 1 &&
      aliResult.sourceMeta.internalLinks[0]?.url ===
        "https://www.fmkorea.com/10219294014",
  ],
];

for (const [label, ok] of aliAssertions) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  allPassed = ok && allPassed;
}

// 3. 뽐뿌 fixture 8종 (303716/303718/303717-live는 크롤러 수신 캡처)
const ppomppuFixtures = [
  { file: "ppomppu-303717.html", no: "303717" },
  { file: "ppomppu-303709.html", no: "303709" },
  { file: "ppomppu-303693.html", no: "303693" },
  { file: "ppomppu-303711.html", no: "303711" },
  { file: "ppomppu-303705.html", no: "303705" },
  { file: "ppomppu-303716.html", no: "303716" },
  { file: "ppomppu-303718.html", no: "303718" },
  { file: "ppomppu-303717-live.html", no: "303717-live" },
];

const ppomppuResults: Record<
  string,
  ReturnType<typeof parsePpomppuHtml>
> = {};

for (const fixture of ppomppuFixtures) {
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

  ppomppuResults[fixture.no] = result;

  allPassed =
    check(`ppomppu fixture ${fixture.no}`, result) &&
    allPassed;
}

/*
 * 값 수준 회귀 방지 (뽐뿌):
 * 단일 상품 글의 제목 폴백 상품명(스토어 태그/꼬리 가격 제거),
 * 크롤러 수신 HTML의 h1 내 댓글수 스팬 제거, 다중 상품/옵션
 * 나열 분리를 고정한다.
 */
const eggs = ppomppuResults["303717"];
const tossBundle = ppomppuResults["303709"];
const acerLaptop = ppomppuResults["303693"];
const galaxyWatch = ppomppuResults["303711"];
const lgFridge = ppomppuResults["303705"];
const lenovoLive = ppomppuResults["303716"];
const gamjatangLive = ppomppuResults["303718"];
const eggsLive = ppomppuResults["303717-live"];

const ppomppuAssertions: Array<[string, boolean]> = [
  // 303717: 단일 상품 — 제목 폴백 + 꼬리 가격 괄호 제거
  [
    "ppomppu 303717: 제목 폴백 상품명 (스토어 태그 + 가격 괄호 제거)",
    eggs.products[0]?.name ===
      "국내산 난각번호1번 유정란 무항생제 자연방목 계란 20구",
  ],
  [
    "ppomppu 303717: 가격/배송 파싱 (6,400원 / 네멤무료→0)",
    eggs.products[0]?.price === 6400 &&
      eggs.products[0]?.shipping === 0 &&
      eggs.products[0]?.store === "네이버",
  ],

  // 303709: 복수 상품 스킵 정책 (2026-09-02)
  // 뽐뿌 복수 상품 게시글은 파서 복잡화·DB 필드 혼선 방지를 위해
  // products=[]로 스킵한다. normalize → Deal[] 비어 ingest가
  // products_count=0으로 워커 동결.
  [
    "ppomppu 303709: 복수 상품 감지 → products=[] (스킵 정책)",
    tossBundle.products.length === 0 &&
      normalizePpomppuDeal(tossBundle).length === 0,
  ],

  // 303693: 복수 구매 링크 (쿠팡+G마켓) → 스킵 (2026-09-02 구조적 감지)
  [
    "ppomppu 303693: 복수 링크 감지 → products=[] (스킵 정책)",
    acerLaptop.products.length === 0 &&
      normalizePpomppuDeal(acerLaptop).length === 0,
  ],

  // 303711: 옵션/체감가 나열도 복수 상품으로 간주 → 스킵 (2026-09-02)
  [
    "ppomppu 303711: 옵션 나열(체감가 3개 이상) → products=[] (스킵 정책)",
    galaxyWatch.products.length === 0 &&
      normalizePpomppuDeal(galaxyWatch).length === 0,
  ],

  // 303705: 괄호 없는 꼬리 가격 표현 제거
  [
    "ppomppu 303705: 꼬리 가격 '231만원대~' 제거",
    lgFridge.products[0]?.name ===
      "8/30(일) 21:00 LG 디오스 AI 오브제 5도어 원매직 1등급 냉장고" &&
      lgFridge.products[0]?.price === 2310000,
  ],

  // 303716 (라이브): 지마켓 단일 상품
  [
    "ppomppu 303716: 라이브 딜 제목 폴백 (마케팅 문구는 보존)",
    lenovoLive.products[0]?.name ===
      "이 가격에 OLED? 레노버가 작정하고 만든 아이디어패드 슬림3" &&
      lenovoLive.products[0]?.price === 670000 &&
      lenovoLive.products[0]?.store === "지마켓",
  ],

  // 303718 (라이브): 자유형 본문 — 가격은 null로 안전하게 실패
  [
    "ppomppu 303718: 본문 가격 서술 없으면 price null (지어내지 않음)",
    gamjatangLive.products[0]?.price === null &&
      gamjatangLive.products[0]?.store === "옥션",
  ],

  // 303717-live (라이브): h1 내 댓글수 스팬 제거 + 확정 종료 신호
  [
    "ppomppu 303717-live: 제목에서 댓글수 스팬 제거 (끝에 숫자 안 붙음)",
    eggsLive.title ===
      "[네이버] 난각번호1번 유정란 20구 / 한돈 목살 냉장 1kg" &&
      eggsLive.stats.comments === 4,
  ],
  [
    "ppomppu 303717-live: 확정 종료 서술 → ended (조건부 서술 공존에도)",
    eggsLive.status === "ended",
  ],
];

for (const [label, ok] of ppomppuAssertions) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  allPassed = ok && allPassed;
}

// 4. 루리웹 fixture 6종
const ruliwebFixtures = [
  { file: "ruliweb-106654.html", no: "106654" },
  { file: "ruliweb-106377.html", no: "106377" },
  { file: "ruliweb-106652.html", no: "106652" },
  { file: "ruliweb-106658.html", no: "106658" },
  { file: "ruliweb-106648.html", no: "106648" },
  { file: "ruliweb-106634.html", no: "106634" },
];

const ruliwebResults: Record<
  string,
  ReturnType<typeof parseRuliwebHtml>
> = {};

for (const fixture of ruliwebFixtures) {
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

  ruliwebResults[fixture.no] = result;

  allPassed =
    check(`ruliweb fixture ${fixture.no}`, result) &&
    allPassed;
}

/*
 * 값 수준 회귀 방지 (루리웹):
 * 제목 규약 "[쇼핑몰] 상품명 (가격/배송)" 파싱, link.php 언래핑,
 * 프로모션 글 쿠폰 클러스터 추출을 고정한다.
 */
const cultureland = ruliwebResults["106654"];
const aliPromo = ruliwebResults["106377"];
const psnSale = ruliwebResults["106652"];
const coupangSnack = ruliwebResults["106658"];
const daewonShop = ruliwebResults["106648"];
const crimsonDesert = ruliwebResults["106634"];

const ruliwebAssertions: Array<[string, boolean]> = [
  // 106654: 괄호 병기형 "(46,500원/무료)"
  [
    "ruliweb 106654: 제목에서 스토어/상품명 분리",
    cultureland.products[0]?.store === "네이버" &&
      cultureland.products[0]?.name === "컬쳐랜드 5만상품권",
  ],
  [
    "ruliweb 106654: 가격/배송 파싱 (46,500원/무료)",
    cultureland.products[0]?.price === 46500 &&
      cultureland.products[0]?.shipping === 0,
  ],
  [
    "ruliweb 106654: 직접 링크(래핑 없음) → direct",
    cultureland.products[0]?.url ===
      "https://m.brand.naver.com/cultureland_gift/products/13727608590" &&
      cultureland.products[0]?.urlType === "direct",
  ],
  [
    "ruliweb 106654: postedAt ISO 변환",
    cultureland.postedAt === "2026-08-26T11:04:13+09:00",
  ],
  [
    "ruliweb 106654: stats (조회/추천/댓글)",
    cultureland.stats.views === 6414 &&
      cultureland.stats.recommendations === 14 &&
      cultureland.stats.comments === 14,
  ],
  [
    "ruliweb 106654: 조건부 종료 표현은 ended 오분류 금지",
    cultureland.status !== "ended",
  ],

  // 106377: 프로모션 모음글 — 가격 없음, 쿠폰 클러스터
  [
    "ruliweb 106377: 스토어 태그 + 가격 null 허용",
    aliPromo.products[0]?.store === "알리익스프레스" &&
      aliPromo.products[0]?.price === null,
  ],
  [
    "ruliweb 106377: 쿠폰 클러스터 추출 (마커 뒤 복수 코드)",
    aliPromo.discount.codes.includes("LIEW03") &&
      aliPromo.discount.codes.includes("PLOK03") &&
      aliPromo.discount.codes.includes("ALIPICK50") &&
      aliPromo.discount.codes.includes("IFP8A7FS"),
  ],

  // 106652: 가격 없는 세일 글 + 빈 본문 안전 처리
  [
    "ruliweb 106652: 가격 null + 직접 링크 유지",
    psnSale.products[0]?.price === null &&
      psnSale.products[0]?.url ===
        "https://store.playstation.com/ko-kr/category/5012feca-0aab-417c-8eec-0825cb3e4cb8/1",
  ],

  // 106658: link.php 래핑 언래핑 (쿠팡)
  [
    "ruliweb 106658: link.php 언래핑 → 쿠팡 상품 URL",
    coupangSnack.products[0]?.url ===
      "https://www.coupang.com/vp/products/8289313119?itemId=3756044249",
  ],
  [
    "ruliweb 106658: 래핑 존재 → redirect + rawUrl 보존",
    coupangSnack.products[0]?.urlType === "redirect" &&
      (coupangSnack.products[0]?.rawUrl ?? "").includes(
        "link.php",
      ),
  ],
  [
    "ruliweb 106658: 상품명/가격 (괄호형)",
    coupangSnack.products[0]?.name ===
      "고래밥 볶음양념맛 46g 4개" &&
      coupangSnack.products[0]?.price === 2620,
  ],

  // 106648: 슬래시 나열형 "/ 10,000원 / 무배" + HTML 엔티티
  [
    "ruliweb 106648: 슬래시 나열형 가격/배송",
    daewonShop.products[0]?.price === 10000 &&
      daewonShop.products[0]?.shipping === 0,
  ],
  [
    "ruliweb 106648: 엔티티 디코딩 상품명",
    daewonShop.products[0]?.name ===
      "닌텐도&컴파일하트 균일가",
  ],

  // 106634: 통화기호(￦) + 슬래시형
  [
    "ruliweb 106634: ￦ 가격 파싱",
    crimsonDesert.products[0]?.price === 63840 &&
      crimsonDesert.products[0]?.currency === "KRW",
  ],
  [
    "ruliweb 106634: 상품명에 할인율 토큰 보존",
    crimsonDesert.products[0]?.name ===
      "붉은사막 첫 할인 -20%",
  ],
];

for (const [label, ok] of ruliwebAssertions) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  allPassed = ok && allPassed;
}

// 5. 퀘이사존 fixture 4종
const quasarzoneFixtures = [
  { file: "quasarzone-1981697.html", no: "1981697" },
  { file: "quasarzone-1981955.html", no: "1981955" },
  { file: "quasarzone-1981594.html", no: "1981594" },
  { file: "quasarzone-1980739.html", no: "1980739" },
  // v2 뷰 템플릿(h1.v2-view-head__title) — 제목/등록일/스탯 셀렉터 폴백 검증
  { file: "quasarzone-v2-1966305.html", no: "1966305" },
];

const quasarzoneResults: Record<
  string,
  ReturnType<typeof parseQuasarzoneHtml>
> = {};

for (const fixture of quasarzoneFixtures) {
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

  quasarzoneResults[fixture.no] = result;

  allPassed =
    check(`quasarzone fixture ${fixture.no}`, result) &&
    allPassed;
}

/*
 * 값 수준 회귀 방지 (퀘이사존):
 * 핫딜 폼(market-info-view-table) 파싱, goToLink base64 언래핑,
 * 상태 라벨 우선 판정, textarea 본문 추출을 고정한다.
 */
const quasarzoneResult = quasarzoneResults["1981697"];
const qzProduct = quasarzoneResult.products[0];
const qzDeals = normalizeQuasarzoneDeal(quasarzoneResult);

const quasarzoneAssertions: Array<[string, boolean]> = [
  [
    "quasarzone 1981697: 상품 1개만 추출 (1글=1딜)",
    quasarzoneResult.products.length === 1,
  ],
  [
    "quasarzone 1981697: 제목에서 [스토어] 태그 분리",
    qzProduct?.store === "기타" &&
      qzProduct?.name ===
        "마닉 실버스톤 SST-FLP03W 레트로 미니타워 케이스 예약판매",
  ],
  [
    "quasarzone 1981697: 가격/배송 파싱 (￦ 212,500 / 무료)",
    qzProduct?.price === 212500 &&
      qzProduct?.currency === "KRW" &&
      qzProduct?.shipping === 0,
  ],
  [
    "quasarzone 1981697: goToLink base64 언래핑 → 상품 URL",
    qzProduct?.url ===
      "https://www.compuzone.co.kr/product/product_detail.htm?ProductNo=1376664&BigDivNo=4&MediumDivNo=1147&DivNo=2751",
  ],
  [
    "quasarzone 1981697: 게이트웨이 래핑 → redirect + rawUrl 보존",
    qzProduct?.urlType === "redirect" &&
      (qzProduct?.rawUrl ?? "").startsWith(
        "https://quasarzone.com/link?link=",
      ),
  ],
  [
    "quasarzone 1981697: 상태 라벨(진행중) → active",
    quasarzoneResult.status === "active" &&
      quasarzoneResult.sourceMeta.statusLabel === "진행중",
  ],
  [
    "quasarzone 1981697: postedAt ISO 변환",
    quasarzoneResult.postedAt === "2026-08-25T15:52:00+09:00",
  ],
  [
    "quasarzone 1981697: stats (조회/추천/댓글)",
    quasarzoneResult.stats.views === 2546 &&
      quasarzoneResult.stats.recommendations === 5 &&
      quasarzoneResult.stats.comments === 15,
  ],
  [
    "quasarzone 1981697: 카테고리(ca_name) 추출",
    quasarzoneResult.category === "PC/하드웨어",
  ],
  [
    "quasarzone 1981697: 본문(textarea)에서 할인 서술 수집",
    quasarzoneResult.discount.description.includes(
      "컴퓨존 단독 할인",
    ),
  ],
  [
    "quasarzone 1981697: normalize → Deal 1개 + community 반영",
    qzDeals.length === 1 &&
      qzDeals[0]?.sourcePost.community === "quasarzone" &&
      qzDeals[0]?.purchase.productUrl === qzProduct?.url,
  ],

  // 1981955: 종료 라벨 + 배송비 금액형 + 기타사항(리퍼) 행
  [
    "quasarzone 1981955: 종료 라벨(label done) → ended",
    quasarzoneResults["1981955"].status === "ended" &&
      quasarzoneResults["1981955"].sourceMeta.statusLabel === "종료",
  ],
  [
    "quasarzone 1981955: 배송비 금액형(2,500) 파싱",
    quasarzoneResults["1981955"].products[0]?.shipping === 2500,
  ],
  [
    "quasarzone 1981955: 기타사항=리퍼 행 보존",
    quasarzoneResults["1981955"].sourceMeta.formExtra["기타사항"] ===
      "리퍼",
  ],
  [
    "quasarzone 1981955: 링크 언래핑 → 판매처 사이트 URL",
    quasarzoneResults["1981955"].products[0]?.url ===
      "https://www.seorinexpress.com/goods/goods_list.php?cateCd=027001",
  ],

  // 1981594: 알리 스토어 + ￦…원 가격 + 쿠폰 2개 + item URL
  [
    "quasarzone 1981594: 알리 스토어 + ￦…원 가격",
    quasarzoneResults["1981594"].products[0]?.store === "알리" &&
      quasarzoneResults["1981594"].products[0]?.price === 64755 &&
      quasarzoneResults["1981594"].products[0]?.currency === "KRW",
  ],
  [
    "quasarzone 1981594: '무료 / 직배가능' → 배송비 0 + 원문 보존",
    quasarzoneResults["1981594"].products[0]?.shipping === 0 &&
      quasarzoneResults["1981594"].products[0]?.shippingText ===
        "무료 / 직배가능",
  ],
  [
    "quasarzone 1981594: 본문 할인코드 2개 추출",
    quasarzoneResults["1981594"].discount.codes.includes("ADAYCB31") &&
      quasarzoneResults["1981594"].discount.codes.includes(
        "YOUCHEN8866",
      ),
  ],
  [
    "quasarzone 1981594: aliexpress item URL + itemId 추출",
    quasarzoneResults["1981594"].products[0]?.url?.includes(
      "/item/1005008865854288.html",
    ) === true &&
      normalizeQuasarzoneDeal(quasarzoneResults["1981594"])[0]?.purchase
        .itemId === "1005008865854288",
  ],

  // 1980739: 인기 라벨(상태 아님) + USD 가격 + 쿠폰
  [
    "quasarzone 1980739: 인기 라벨은 상태 신호 아님 → ended 오분류 금지",
    quasarzoneResults["1980739"].status !== "ended" &&
      quasarzoneResults["1980739"].sourceMeta.statusLabel === "인기",
  ],
  [
    "quasarzone 1980739: USD 가격 파싱 ($ 43.32)",
    quasarzoneResults["1980739"].products[0]?.price === 43.32 &&
      quasarzoneResults["1980739"].products[0]?.currency === "USD",
  ],
  [
    "quasarzone 1980739: 본문 할인코드 추출 + itemId",
    quasarzoneResults["1980739"].discount.codes.includes("FUDU2KR27") &&
      normalizeQuasarzoneDeal(quasarzoneResults["1980739"])[0]?.purchase
        .itemId === "1005012808698478",
  ],

  // 1966305: v2 뷰 템플릿(h1.v2-view-head__title) — 빈 상품명 재발 방지 회귀
  [
    "quasarzone v2 1966305: v2 템플릿에서도 제목 추출 (빈 제목 금지)",
    quasarzoneResults["1966305"].title ===
      "[지마켓] ASUS 지포스 RTX 5060 LP BRK OC D7 8GB 인텍앤컴퍼니",
  ],
  [
    "quasarzone v2 1966305: 상품명/[스토어] 태그 분리 (빈 상품명 금지)",
    quasarzoneResults["1966305"].products[0]?.name ===
      "ASUS 지포스 RTX 5060 LP BRK OC D7 8GB 인텍앤컴퍼니" &&
      quasarzoneResults["1966305"].products[0]?.store === "지마켓",
  ],
  [
    "quasarzone v2 1966305: 등록일은 JSON-LD datePublished (초 포함 ISO)",
    quasarzoneResults["1966305"].postedAt === "2026-07-01T19:26:36+09:00",
  ],
  [
    "quasarzone v2 1966305: 상태라벨(v2 h1 span.label done) → ended",
    quasarzoneResults["1966305"].status === "ended" &&
      quasarzoneResults["1966305"].sourceMeta.statusLabel === "종료",
  ],
  [
    "quasarzone v2 1966305: stats v2-meta 폴백 (조회/추천/댓글)",
    quasarzoneResults["1966305"].stats.views === 9324 &&
      quasarzoneResults["1966305"].stats.recommendations === 12 &&
      quasarzoneResults["1966305"].stats.comments === 12,
  ],
  [
    "quasarzone v2 1966305: v2에는 ca_name 없음 → category null (의도)",
    quasarzoneResults["1966305"].category === null,
  ],
  [
    "quasarzone v2 1966305: 폼 가격/URL은 템플릿 무관 정상 파싱",
    quasarzoneResults["1966305"].products[0]?.price === 467400 &&
      quasarzoneResults["1966305"].products[0]?.currency === "KRW" &&
      quasarzoneResults["1966305"].products[0]?.url ===
        "https://item.gmarket.co.kr/Item?goodsCode=4125623356",
  ],
];

for (const [label, ok] of quasarzoneAssertions) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  allPassed = ok && allPassed;
}

// 6. 아카라이브 fixture 4종
const arcaFixtures = [
  { file: "arca-181074117.html", no: "181074117" },
  { file: "arca-181059656.html", no: "181059656" },
  { file: "arca-181046107.html", no: "181046107" },
  // 크롤러 수신(Chrome 지문 HTTP) 캡처 — 한국어 stats 라벨 케이스
  { file: "arca-181084175.html", no: "181084175" },
];

const arcaResults: Record<
  string,
  ReturnType<typeof parseArcaHtml>
> = {};

for (const fixture of arcaFixtures) {
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

  arcaResults[fixture.no] = result;

  allPassed =
    check(`arca fixture ${fixture.no}`, result) && allPassed;
}

/*
 * 값 수준 회귀 방지 (아카라이브):
 * 핫딜 폼(article-options) 파싱, unsafelink 언래핑,
 * close-deal/LIVE 상태 신호, UTC→KST 등록일 변환을 고정한다.
 */
const arcaResult = arcaResults["181074117"];
const arcaProduct = arcaResult.products[0];
const arcaDeals = normalizeArcaDeal(arcaResult);

const arcaAssertions: Array<[string, boolean]> = [
  [
    "arca 181074117: 상품 1개만 추출 (1글=1딜)",
    arcaResult.products.length === 1,
  ],
  [
    "arca 181074117: 폼 상품명 우선 채택 (제목 괄호 제거 불필요)",
    arcaProduct?.name === "유그린 삼성 갤럭시용 스마트태그 카드형",
  ],
  [
    "arca 181074117: exchange 요소 → USD 가격 ($14.15 / 무료)",
    arcaProduct?.price === 14.15 &&
      arcaProduct?.currency === "USD" &&
      arcaProduct?.shipping === 0,
  ],
  [
    "arca 181074117: unsafelink 언래핑 → aliexpress item URL",
    arcaProduct?.url ===
      "https://ko.aliexpress.com/item/1005009452856211.html",
  ],
  [
    "arca 181074117: 래핑 URL 보존 → redirect + rawUrl",
    arcaProduct?.urlType === "redirect" &&
      (arcaProduct?.rawUrl ?? "").startsWith(
        "https://unsafelink.com/",
      ),
  ],
  [
    "arca 181074117: LIVE 버블 → active + statusLabel",
    arcaResult.status === "active" &&
      arcaResult.sourceMeta.statusLabel === "LIVE",
  ],
  [
    "arca 181074117: UTC datetime → +09:00 변환",
    arcaResult.postedAt === "2026-08-26T14:17:02+09:00",
  ],
  [
    "arca 181074117: stats (Like/Comment/Views)",
    arcaResult.stats.views === 1943 &&
      arcaResult.stats.recommendations === 0 &&
      arcaResult.stats.comments === 4,
  ],
  [
    "arca 181074117: 카테고리 배지 추출",
    arcaResult.category === "전자제품",
  ],
  [
    "arca 181074117: 본문 할인코드 추출 (KR0860)",
    arcaResult.discount.codes.includes("KR0860"),
  ],
  [
    "arca 181074117: normalize → Deal 1개 + itemId 반영",
    arcaDeals.length === 1 &&
      arcaDeals[0]?.sourcePost.community === "arca" &&
      arcaDeals[0]?.purchase.itemId === "1005009452856211",
  ],

  // 181059656: close-deal 종료 신호 + KRW 가격
  [
    "arca 181059656: close-deal 클래스 → ended",
    arcaResults["181059656"].status === "ended" &&
      arcaResults["181059656"].sourceMeta.statusLabel ===
        "close-deal",
  ],
  [
    "arca 181059656: KRW 가격 파싱 (648,000원 / 무료)",
    arcaResults["181059656"].products[0]?.price === 648000 &&
      arcaResults["181059656"].products[0]?.currency === "KRW" &&
      arcaResults["181059656"].products[0]?.shipping === 0,
  ],
  [
    "arca 181059656: 닌텐도 스토어 + 상품명",
    arcaResults["181059656"].products[0]?.store === "닌텐도" &&
      arcaResults["181059656"].products[0]?.name ===
        "닌텐도 스위치 2",
  ],
  [
    "arca 181059656: 링크 언래핑 → store.nintendo.co.kr",
    arcaResults["181059656"].products[0]?.url ===
      "https://store.nintendo.co.kr/beeskb6aakor",
  ],

  // 181046107: 배송비 금액형 + 쿼리스트링 URL + 날짜 경계 변환
  [
    "arca 181046107: 배송비 금액형(2,500원) 파싱",
    arcaResults["181046107"].products[0]?.shipping === 2500 &&
      arcaResults["181046107"].products[0]?.price === 372000,
  ],
  [
    "arca 181046107: ssg 쿼리스트링 URL 온전 보존",
    arcaResults["181046107"].products[0]?.url ===
      "https://m.ssg.com/item/itemView.ssg?itemId=1000859345075&ckwhere=share_app&siteNo=7024&rightBadgeCd=&salestrNo=6005",
  ],
  [
    "arca 181046107: UTC 날짜 경계 → KST 익일 변환",
    arcaResults["181046107"].postedAt ===
      "2026-08-26T07:11:18+09:00",
  ],
  [
    "arca 181046107: SSG URL → itemId 추출 (m.ssg.com?itemId=)",
    normalizeArcaDeal(arcaResults["181046107"])[0]?.purchase
      .itemId === "1000859345075",
  ],

  // 181084175 (크롤러 수신): 한국어 stats 라벨 + 제목 괄호 폴백
  [
    "arca 181084175: 한국어 stats 라벨 파싱 (조회수/추천/댓글)",
    arcaResults["181084175"].stats.views === 698 &&
      arcaResults["181084175"].stats.recommendations === 1 &&
      arcaResults["181084175"].stats.comments === 3,
  ],
  [
    "arca 181084175: 제목 괄호 제거 상품명 폴백 + 가격/스토어",
    arcaResults["181084175"].products[0]?.name ===
      "고메 소바바 황금홀릭 순살 375G 3개 + 황민현 포토카드 4종" &&
      arcaResults["181084175"].products[0]?.price === 18900 &&
      arcaResults["181084175"].products[0]?.store === "지마켓",
  ],
  [
    "arca 181084175: LIVE + UTC→KST + gmarket URL",
    arcaResults["181084175"].status === "active" &&
      arcaResults["181084175"].postedAt ===
        "2026-08-26T16:05:29+09:00" &&
      arcaResults["181084175"].products[0]?.url ===
        "https://item.gmarket.co.kr/Item?goodscode=4745022467",
  ],
];

for (const [label, ok] of arcaAssertions) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  allPassed = ok && allPassed;
}

// 7. mock v0.2 데이터셋 전체
const mockPath = path.join(
  process.cwd(),
  "data",
  "mock",
  "hotdeal_mock_dataset_v0.2.json",
);

const mockData = JSON.parse(
  fs.readFileSync(mockPath, "utf-8"),
);

for (const [index, deal] of mockData.entries()) {
  allPassed =
    check(`mock v0.2 [${index}] (${deal.id})`, deal) &&
    allPassed;
}

if (!allPassed) {
  console.log("\n하나 이상의 데이터가 스키마를 통과하지 못했습니다.");
  process.exit(1);
}

console.log("\n모든 데이터가 schema v2.0을 통과했습니다.");
