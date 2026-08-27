/*
 * 통합 분류 체계 (taxonomy).
 *
 * 커뮤니티마다 다른 네이티브 카테고리명을 프로젝트 공통의
 * 상위 카테고리로 매핑하고, 스토어 표기 별칭을 정규화한다.
 * 프론트 필터(카테고리 탭·쇼핑 카테고리 칩)의 기준이 된다.
 *
 * 매핑 원칙:
 * - 네이티브 분류를 있는 그대로 믿되, 애매한 결합 카테고리는
 *   실제 표본(제목) 확인 후 다수 쪽으로 붙인다.
 *   (fmkorea "모바일/상품권"은 표본상 상품권·기프티콘이 다수라
 *   상품권/쿠폰으로, ruliweb "PC/가전"은 PC 부품·모니터가 다수라
 *   PC/하드웨어로 매핑 — 2026-08-27 표본 확인)
 * - 매핑 없는 값은 전부 "기타".
 *
 * 무형 제외 정책 (2026-08-27): 게임/SW·상품권/쿠폰·포인트/래플은
 * 무형 아이템이라 수집·노출에서 제외한다. 매핑 자체는 유지해서
 * 제외 판정(exclusion.ts)이 네이티브명 대신 통합명으로 하게 한다.
 * 게임"하드웨어"(콘솔·주변기기)는 실물이므로 게임/SW와 분리해
 * 노출 카테고리로 유지한다.
 */

/** 화면에 노출하는 카테고리 (무형 제외). */
export const CATEGORIES = [
  "PC/하드웨어",
  "게임/하드웨어",
  "노트북/모바일",
  "가전/TV",
  "생활/식품",
  "패션/뷰티",
  "기타",
] as const;

/** 노출 카테고리 + 무형(제외 대상) 카테고리를 아우르는 전체 집합. */
export const ALL_NORM_CATEGORIES = [
  ...CATEGORIES,
  "게임/SW",
  "상품권/쿠폰",
  "포인트/래플",
] as const;

export type NormCategory = (typeof ALL_NORM_CATEGORIES)[number];

/** 커뮤니티 네이티브 카테고리 → 통합 카테고리 */
const CATEGORY_MAP: Record<string, Record<string, NormCategory>> = {
  arca: {
    식품: "생활/식품",
    생활용품: "생활/식품",
    전자제품: "가전/TV",
    상품권: "상품권/쿠폰",
    "상품권/쿠폰": "상품권/쿠폰",
    PC: "PC/하드웨어",
    "PC/하드웨어": "PC/하드웨어",
    SW: "게임/SW",
    "SW/게임": "게임/SW",
    의류: "패션/뷰티",
    응모: "포인트/래플",
    기타: "기타",
  },
  fmkorea: {
    먹거리: "생활/식품",
    PC제품: "PC/하드웨어",
    생활용품: "생활/식품",
    패키지: "상품권/쿠폰",
    "패키지/이용권": "상품권/쿠폰",
    "모바일/상품권": "상품권/쿠폰",
    의류: "패션/뷰티",
    화장품: "패션/뷰티",
    가전제품: "가전/TV",
    "SW/게임": "게임/SW",
    세일정보: "기타",
    기타: "기타",
  },
  ppomppu: {
    가전: "가전/TV",
    컴퓨터: "PC/하드웨어",
    "식품/건강": "생활/식품",
    기타: "기타",
    거래완료: "기타",
    "패션/뷰티": "패션/뷰티",
    의류: "패션/뷰티",
    미용: "패션/뷰티",
  },
  quasarzone: {
    "PC/하드웨어": "PC/하드웨어",
    "게임/SW": "게임/SW",
    "노트북/모바일": "노트북/모바일",
    "가전/TV": "가전/TV",
    "생활/식품": "생활/식품",
    "패션/뷰티": "패션/뷰티",
    "상품권/쿠폰": "상품권/쿠폰",
    "포인트/래플": "포인트/래플",
    기타: "기타",
  },
  ruliweb: {
    "게임S/W": "게임/SW",
    "게임H/W": "게임/하드웨어",
    음식: "생활/식품",
    생활용품: "생활/식품",
    상품권: "상품권/쿠폰",
    "PC/가전": "PC/하드웨어",
    휴대폰: "노트북/모바일",
    취미용품: "기타",
  },
};

/*
 * 제목 기반 재분류 (2026-08-27).
 * 네이티브 분류가 없어 "기타"로 떨어진 딜 중 제목에 명확한
 * 상품 신호가 있으면 재분류한다. 실측 오분류 케이스로 규칙을
 * 만들었다: 보조배터리가 기타로, 샴푸/바디워시가 기타로 가던
 * 문제. "기타" 결론일 때만 적용하므로 네이티브 분류를 믿는
 * 원칙은 유지된다. 순서 민감 — 첫 매치만 채택.
 */
const TITLE_CATEGORY_RULES: [RegExp, NormCategory][] = [
  [
    /보조배터리|충전기|충전베이스|케이블|이어폰|헤드폰|이어버즈|스마트워치|갤럭시 ?워치|아이패드|갤럭시 ?탭|태블릿|휴대폰|스마트폰|거치대|보호필름|강화유리/,
    "노트북/모바일",
  ],
  [
    /샴푸|바디워시|트리트먼트|로션|토너|세럼|앰플|미백|페이셜|클렌징|선스틱|선크림|향수|립스틱|립밤|파운데이션|쿠션|마스크팩|양말|속옷|런닝|티셔츠|후드|패딩|운동화|슬리퍼/,
    "패션/뷰티",
  ],
  [
    /세제|섬유유연제|물티슈|미용티슈|화장지|키친타월|치약|칫솔|가글|리스테린|방향제|탈취제|곰팡이|김치|국밥|탕|생수|커피|콜라|음료|주스|만두|핫도그|불고기|과자|라면|즉석밥|올리브/,
    "생활/식품",
  ],
];

export function normalizeCategory(
  community: string,
  raw: string | null,
  title?: string | null,
): NormCategory {
  const base = !raw ? "기타" : CATEGORY_MAP[community]?.[raw] ?? "기타";

  if (base !== "기타" || !title) return base;

  for (const [pattern, category] of TITLE_CATEGORY_RULES) {
    if (pattern.test(title)) return category;
  }

  return base;
}

/**
 * 스토어 필터 고정 순서 (2026-08-27 사용자 지정).
 * "기타"는 목록 밖 모든 스토어를 묶는 캐치올이라 별도 상수.
 */
export const STORE_FILTERS = [
  "알리익스프레스",
  "쿠팡",
  "네이버",
  "토스",
  "11번가",
  "지마켓",
  "옥션",
  "SSG",
  "카카오톡딜",
  "오늘의집",
  "무신사",
  "컬리",
  "롯데온",
  "다나와",
  "아마존",
  "타오바오",
  "테무",
] as const;

export type StoreFilter = (typeof STORE_FILTERS)[number];

export const OTHER_STORE_FILTER = "기타";

/** 칩 렌더링용 로고 경로 (public/store-logos/). */
export const STORE_FILTER_LOGOS: Record<string, string> = {
  전체: "/store-logos/all.png",
  알리익스프레스: "/store-logos/aliexpress.jpeg",
  쿠팡: "/store-logos/coupang.png",
  네이버: "/store-logos/naver.png",
  토스: "/store-logos/toss.png",
  "11번가": "/store-logos/11st.jpeg",
  지마켓: "/store-logos/gmarket.jpeg",
  옥션: "/store-logos/auction.png",
  SSG: "/store-logos/ssg.png",
  카카오톡딜: "/store-logos/kakaodeal.png",
  오늘의집: "/store-logos/ohouse.png",
  무신사: "/store-logos/musinsa.png",
  컬리: "/store-logos/kurly.png",
  롯데온: "/store-logos/lotteon.png",
  다나와: "/store-logos/danawa.jpeg",
  아마존: "/store-logos/amazon.jpg",
  타오바오: "/store-logos/taobao.png",
  테무: "/store-logos/temu.jpeg",
  기타: "/store-logos/etc.png",
};

const STORE_FILTER_SET: ReadonlySet<string> = new Set(STORE_FILTERS);

/** 고정 목록 밖 스토어면 "기타" 캐치올 대상. */
export function isOtherStore(storeNorm: string): boolean {
  return !STORE_FILTER_SET.has(storeNorm);
}

/** 스토어 표기 별칭 → 대표 표기(필터 라벨과 동일). null/빈 값은 "기타". */
const STORE_ALIASES: Record<string, string> = {
  지마켓: "지마켓",
  G마켓: "지마켓",
  GMARKET: "지마켓",
  옥션: "옥션",
  SSG: "SSG",
  네이버: "네이버",
  네이버스토어: "네이버",
  네이버쇼핑: "네이버",
  네이버페이: "네이버",
  네이버항공권: "네이버",
  네이버항공: "네이버",
  알리: "알리익스프레스",
  알리익스프레스: "알리익스프레스",
  "알리 타임딜": "알리익스프레스",
  알리익스프레스타임딜: "알리익스프레스",
  "알리 코인딜": "알리익스프레스",
  카카오: "카카오톡딜",
  카카오톡: "카카오톡딜",
  "카카오 톡딜": "카카오톡딜",
  톡딜: "카카오톡딜",
  쿠팡: "쿠팡",
  쿠팡와우: "쿠팡",
  쿠팡로켓직구: "쿠팡",
  토스: "토스",
  토스쇼핑: "토스",
  "11번가": "11번가",
  오늘의집: "오늘의집",
  무신사: "무신사",
  컬리: "컬리",
  롯데온: "롯데온",
  다나와: "다나와",
  "다나와 x 아정당": "다나와",
  "다나와×아정당": "다나와",
  아마존: "아마존",
  일마존: "아마존",
  타오바오: "타오바오",
  테무: "테무",
};

export function normalizeStore(raw: string | null): string {
  if (!raw) return OTHER_STORE_FILTER;

  const trimmed = raw.trim();

  if (!trimmed) return OTHER_STORE_FILTER;

  return STORE_ALIASES[trimmed] ?? trimmed;
}
