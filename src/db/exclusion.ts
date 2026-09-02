/*
 * 무형·비핫딜 아이템 제외 규칙 (2026-08-27 정책 확정).
 *
 * 수집·적재·노출 공통으로 쓰는 단일 판정. 적용 지점:
 * - 인제스트 (scripts/ingest-crawls.ts): 제외 딜은 적재하지 않음.
 *   그 게시글의 남은 상품이 0개면 products_count=0 → 워커 동결.
 * - 뷰 (src/db/queries.ts): 기존 적재 잔여분 방어 필터.
 * - 정리 (scripts/purge-excluded.ts): 기존 DB 행 일괄 제거.
 *
 * 제외 대상 (사용자 확정): 상품권·기프티콘, 소프트웨어(게임 포함),
 * 포인트·래플·응모, 프로모션·이벤트 홍보글, 라이브방송 홍보글,
 * 항공권·여행·숙박·이용권 등 실물 아닌 무형, 0원 딜(무료 배포).
 *
 * 2026-09-02 추가(사용자 확정): 마트 전단, 통신사 할인(T데이 등),
 * 라이브방송 혜택 요약(라방 정리/총정리/5원). 개별 규칙 주석 참조.
 *
 * 실물 게임 하드웨어(콘솔·주변기기)는 제외하지 않는다 —
 * 그래서 통합 분류에서 게임/하드웨어를 게임/SW와 분리했다.
 *
 * 키워드 규칙은 오탐 방지를 위해 실데이터 대조로 좁혔다:
 * "이벤트"/"라이브" 단독은 실물 딜 제목에도 등장하므로 금지
 * (예: 삼성 워치 딜의 "라이브 구매시 + 포인트").
 */

import {
  normalizeCategory,
  type NormCategory,
} from "./taxonomy";

/** 무형이라 통째로 제외하는 통합 카테고리. */
export const EXCLUDED_NORM_CATEGORIES: ReadonlySet<NormCategory> = new Set<NormCategory>(
  ["게임/SW", "상품권/쿠폰", "포인트/래플"],
);

/**
 * 프로모션·이벤트·라이브 홍보·게시판 안내 글 판정.
 * 실물 딜 제목에 흔히 등장하는 단어(이벤트/라이브/적립 단독 등)는
 * 쓰지 않고, 홍보글에서만 관찰된 조합만 쓴다.
 */
const PROMO_TITLE =
  /소문내기|관심고객|출석|퀴즈|응모|종합 ?차트|적립 ?차트|쇼핑라이브|라이브 ?예고|방송 ?예정|오늘.{0,6}방송|멤버십 ?데이|게시판 규정|공지사항|필독|선착순 ?(쿠폰|멤버십|적립|이벤트)|다운로드 ?쿠폰|쿠폰 ?정리/;

/**
 * 소프트웨어(단품 판매) 판정.
 * 게임/SW 네이티브 카테고리가 없는 커뮤니티(arca "PC" 등)에서
 * 소프트웨어가 실물 하드웨어 분류로 새어 들어오는 것을 잡는다.
 * "정품" 단독은 CPU "멀티팩 정품" 같은 실물 수식어로 쓰이므로
 * 금지하고, "정품 키"/"라이센스"처럼 소프트웨어 판매 신호만 쓴다.
 * "윈도우" 단독도 금지 — 노트북 딜의 "윈도우11 포함"이 있으므로
 * 버전 번호가 붙은 형태만 매치한다.
 */
const SOFTWARE_TITLE =
  /윈도우 ?1[01]|windows ?1[01]|microsoft ?365|office ?365|한글 ?20\d{2}|adobe|photoshop|일러스트레이터|애프터 ?이펙트|라이센스|licence|license|정품 ?키|게임 ?패스|game ?pass|노턴|카스퍼스키|소프트웨어/i;

/**
 * 렌탈(약정·월 과금) 딜 판정 — 사용자 확정(2026-08-27): 렌탈은
 * 월별 요금 표기라 핫딜 가격 비교가 무의미하므로 무조건 제외.
 * 실측 누수: 다나와×아정당 TV 렌탈 홍보글(뽐뿌 303702)에서
 * 월 요금 파편이 딜 가격으로 적재된 사례.
 */
const RENTAL_TITLE = /렌탈|렌털/;

/**
 * 항공권·여행·이용권류 판정.
 * "여행" 단독은 여행용품(캐리어 등) 실물을 잡으므로 쓰지 않는다.
 * 실측 누수 케이스(2026-08-27)를 반영해 세 가지를 보강:
 * - 항공사명 단독(이스타항공·제주항공 등) — 제목에 "항공권"이
 *   없어도 항공사명은 무형 신호다.
 * - 하이픈 경로 단독("인천-오사카") — 날짜가 없거나 제목 앞에
 *   있어도("0903-0905 인천-도쿄") 경로 자체가 항공권 딜이다.
 * - 월일 날짜 범위("9월8일~10일") — 기존 \d{3,4} 범위가 못 잡는다.
 */
const TRAVEL_TITLE =
  /항공권|왕복|편도|숙박권?|호텔 ?예약|렌터카|렌트카|이용권|입장권|이스타항공|제주항공|진에어|티웨이|에어서울|에어부산|에어프레미아|대한항공|아시아나|(인천|부산|청주|제주|김포|김해|대구|무안|여수|원주|광주|서울)\s*[-~–]\s*[가-힣A-Za-z]{2,12}|(인천|부산|청주|제주|김포|김해|대구|무안|여수|원주|광주|서울)\s*[-~–]?\s*[가-힣A-Za-z]{2,12}\s+\d{3,4}\s*[-~–]\s*\d{3,4}|\d{1,2}\s*월\s*\d{1,2}\s*일?\s*[-~–]\s*\d{1,2}\s*일?/;

/**
 * 마트 전단 판정 — 2026-09-02 추가.
 * 대형마트 주간 전단지("홈플러스 8/27~9/2 전단지", "이번주 전단")는
 * 복수 상품을 한 게시글에 나열한 홍보물이라 단일 딜로 취급 불가.
 * "전단"은 핫딜 게시판 컨텍스트에서 거의 마트 전단지 의미지만
 * "전단계"(당뇨 전단계 등 의학 용어) 오탐이 실측 1건 있어
 * negative lookahead로 제외한다.
 */
const MART_FLYER_TITLE = /전단(?!계)/;

/**
 * 통신사 할인 프로모션 데이 판정 — 2026-09-02 추가.
 * T데이/KT데이/U+데이 등 캐리어 브랜드 데이 — 던킨·폴바셋·할리스 등
 * 여러 브랜드 할인 묶음이라 단일 상품 아님.
 * 오탐 방지: "티멤버십"/"KT멤버십" 단독은 실물 딜의 가격 조건으로
 * 자주 등장하므로 제외([11번가] 삼다수 티멤버십 등). "데이"가 붙은
 * 형태만 매치한다.
 * 실측 매칭: "[T멤버십] T데이, 던킨&폴 바셋 음료 50% 할인 외",
 * "[T멤버십] 이번주 T데이 혜택 (9/2)", "SKT T데이(8.12) 백억커피 100원".
 */
const TELECOM_TITLE =
  /통신사 ?(할인|혜택|이벤트|프로모션|멤버십)|(SKT|KT|LG ?U\+|U\+|유플러스|T|티) ?데이|(SKT|KT|LGU\+|유플러스).{0,6}(멤버십 ?데이|프로모션|이벤트|할인 ?쿠폰)/;

/**
 * 라이브방송 혜택 요약 판정 — 2026-09-02 추가.
 * 라방/라이브방송을 "정리·총정리·모음·예고" 형태로 묶은 글은
 * 복수 상품 혜택 나열이라 단일 딜이 아니다.
 * "라방 N원"(네이버페이 라방 5원 이벤트)도 상품 없는 홍보.
 * 오탐 방지: "라이브 혜택가 93만원"(갤럭시26 실물 딜)처럼 실물
 * 가격 수식어로 쓰인 경우는 잡지 않는다 — 정리/총정리/모음/예고
 * 키워드가 있어야 매칭.
 */
const LIVE_BENEFIT_TITLE =
  /(라방|라이브 ?방송|쇼핑 ?라이브|라이브).{0,15}(총정리|정리|모음|예고)|라방\s*\d+\s*원/;

export interface ExclusionInput {
  /** 게시글 소속 커뮤니티 (네이티브 카테고리 매핑용) */
  community: string;
  /** 네이티브 카테고리 (없으면 null) */
  category: string | null;
  /** 게시글 제목 */
  title: string;
  /** 딜 가격 (없으면 null — null은 제외하지 않음) */
  price: number | null;
}

export interface ExclusionResult {
  excluded: boolean;
  /** 제외 사유: 기록·디버깅용 */
  reason:
    | "category"
    | "zero-price"
    | "promo-title"
    | "software-title"
    | "rental-title"
    | "travel-title"
    | "mart-flyer-title"
    | "telecom-title"
    | "live-benefit-title"
    | null;
  categoryNorm: NormCategory;
}

/** 단일 딜 단위 제외 판정. */
export function checkExclusion(input: ExclusionInput): ExclusionResult {
  const categoryNorm = normalizeCategory(
    input.community,
    input.category,
    input.title,
  );

  if (EXCLUDED_NORM_CATEGORIES.has(categoryNorm)) {
    return { excluded: true, reason: "category", categoryNorm };
  }

  if (input.price === 0) {
    return { excluded: true, reason: "zero-price", categoryNorm };
  }

  if (PROMO_TITLE.test(input.title)) {
    return { excluded: true, reason: "promo-title", categoryNorm };
  }

  if (SOFTWARE_TITLE.test(input.title)) {
    return { excluded: true, reason: "software-title", categoryNorm };
  }

  if (RENTAL_TITLE.test(input.title)) {
    return { excluded: true, reason: "rental-title", categoryNorm };
  }

  if (TRAVEL_TITLE.test(input.title)) {
    return { excluded: true, reason: "travel-title", categoryNorm };
  }

  if (MART_FLYER_TITLE.test(input.title)) {
    return { excluded: true, reason: "mart-flyer-title", categoryNorm };
  }

  if (TELECOM_TITLE.test(input.title)) {
    return { excluded: true, reason: "telecom-title", categoryNorm };
  }

  if (LIVE_BENEFIT_TITLE.test(input.title)) {
    return { excluded: true, reason: "live-benefit-title", categoryNorm };
  }

  return { excluded: false, reason: null, categoryNorm };
}
