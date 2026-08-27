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
  /소문내기|관심고객|출석|퀴즈|응모|종합 ?차트|적립 ?차트|쇼핑라이브|라이브 ?예고|방송 ?예정|오늘.{0,6}방송|멤버십 ?데이|게시판 규정|공지사항|필독|선착순 ?(쿠폰|멤버십|적립|이벤트)/;

/**
 * 항공권·여행·이용권류 판정.
 * "여행" 단독은 여행용품(캐리어 등) 실물을 잡으므로 쓰지 않는다.
 * 출발지-도착지+날짜 패턴("인천-도쿄 0903-0905")도 함께 쓴다.
 */
const TRAVEL_TITLE =
  /항공권|왕복|편도|숙박권?|호텔 ?예약|렌터카|렌트카|이용권|입장권|(인천|부산|청주|제주|김포|김해|대구|무안|여수|원주|광주|서울)\s*[-~–]?\s*[가-힣A-Za-z]{2,12}\s+\d{3,4}\s*[-~–]\s*\d{3,4}/;

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
    | "travel-title"
    | null;
  categoryNorm: NormCategory;
}

/** 단일 딜 단위 제외 판정. */
export function checkExclusion(input: ExclusionInput): ExclusionResult {
  const categoryNorm = normalizeCategory(input.community, input.category);

  if (EXCLUDED_NORM_CATEGORIES.has(categoryNorm)) {
    return { excluded: true, reason: "category", categoryNorm };
  }

  if (input.price === 0) {
    return { excluded: true, reason: "zero-price", categoryNorm };
  }

  if (PROMO_TITLE.test(input.title)) {
    return { excluded: true, reason: "promo-title", categoryNorm };
  }

  if (TRAVEL_TITLE.test(input.title)) {
    return { excluded: true, reason: "travel-title", categoryNorm };
  }

  return { excluded: false, reason: null, categoryNorm };
}
