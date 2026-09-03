/**
 * 네이버 카페 검색 API 응답 → Deal 변환.
 *
 * API는 제목/스니펫/카페글 링크만 제공하므로, 가격·스토어 추출은
 * 제목+description 텍스트에 의존한다. 구매 URL은 카페 글 링크 itself —
 * 사용자는 카페 글에서 전체 정보(구매 링크 등)를 확인한다.
 *
 * 설계 원칙:
 * - 스니펫에서 확인되는 정보만 추출 (추측 금지)
 * - 가격 없으면 dealPrice=null (정가 노출 방지)
 * - 제외 규칙(checkExclusion)은 호출부가 담당
 */

import type { Community, Currency, UrlType, DealStatus } from "./types";

/* ── 타입 ─────────────────────────────────────── */

export interface NaverCafeApiItem {
  title: string;
  link: string;
  description: string;
  cafename: string;
  cafeurl: string;
}

export interface NaverCafeDeal {
  id: string;
  source: "naver_cafe";
  sourcePostId: string;
  sourceUrl: string;
  title: string;
  category: null;
  postedAt: string | null;
  products: {
    name: null;
    price: number | null;
    currency: Currency | null;
    priceText: string | null;
    shipping: null;
    shippingText: null;
    store: string | null;
    url: null;
    urlType: "none";
  }[];
  status: DealStatus;
  stats: { views: null; recommendations: null; comments: null };
  discount: {
    type: string[];
    codes: string[];
    stackable: string[][];
    alternatives: string[][];
    description: string;
  };
  sourceMeta: {
    affiliate: false;
    rawUrl: null;
    cafeName: string;
    cafeUrl: string;
    rawPrice: string | null;
    rawShipping: null;
    originalProductUrl: null;
  };
  collectedAt: string;
}

/* ── 헬퍼 ─────────────────────────────────────── */

/** HTML 엔티티 디코딩 (API가 description/title에 엔티티를 보낼 수 있음). */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/** 텍스트에서 첫 번째 한국어 가격 추출 (만원/억원 단위 포함). */
export function extractPriceFromText(text: string): number | null {
  // 만원 단위: "12.8만원", "128만원"
  const manMatch = text.match(/(\d+(?:\.\d+)?)\s*만원/);
  if (manMatch) return Math.round(parseFloat(manMatch[1]) * 10_000);

  // 억원 단위: "128만원" 이전에 "1.2억" 등
  const eokMatch = text.match(/(\d+(?:\.\d+)?)\s*억원/);
  if (eokMatch) return Math.round(parseFloat(eokMatch[1]) * 100_000_000);

  // 일반 원화: ₩, ￦, "원" 접미사, 또는 3자리 이상 쉼표 숫자
  const patterns = [
    /[₩￦]\s*([\d,]+(?:\.\d+)?)/,
    /([\d,]+(?:\.\d+)?)\s*원(?!\s*달러|USD)/,
    /(?<![\d.])([\d]{1,3}(?:,\d{3})+(?:\.\d+)?)(?!\s*(달러|USD|위안|엔|EUR|달러))/,
  ];

  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const num = parseFloat(m[1].replace(/,/g, ""));
      if (num > 0 && num < 100_000_000) return Math.round(num);
    }
  }
  return null;
}

/** 통화 판정 — 텍스트 증거 기반. */
export function detectCurrency(
  text: string,
  storeName: string,
): Currency | null {
  if (/\$|달러|USD/i.test(text)) return "USD";
  if (/¥|엔(?!버|드)|JPY/i.test(text)) return "JPY";
  if (/元|위안|CNY/i.test(text)) return "CNY";
  if (/€|유로|EUR/i.test(text)) return "EUR";

  // 스토어 이름으로 추정 (해외 직구 사이트)
  const usdStores = ["아마존", "Amazon", "아마존닷컴"];
  const jpyStores = ["라쿠텐", "야후재팬", "Amazon.co.jp"];
  const cnyStores = ["타오바오", "알리1688", "1688"];

  if (usdStores.some((s) => storeName.includes(s))) return "USD";
  if (jpyStores.some((s) => storeName.includes(s))) return "JPY";
  if (cnyStores.some((s) => storeName.includes(s))) return "CNY";

  return null;
}

/** 네이버 카페 글 URL에서 고유 post ID 추출. */
function extractPostId(url: string): string {
  // cafe.naver.com/ArticleRead.nhn?articleId=123&clubId=456
  try {
    const u = new URL(url);
    const articleId = u.searchParams.get("articleId");
    const clubId = u.searchParams.get("clubId");
    if (articleId && clubId) return `${clubId}_${articleId}`;
  } catch {
    // fallback to full URL
  }
  return url;
}

/** 게시 시각 파싱 (API date가 "YYYYMMDD" 또는 "YYYY-MM-DD"等形式). */
function parsePostDate(dateStr: string, today: Date): string | null {
  if (!dateStr) return null;

  // "YYYYMMDD" → "YYYY-MM-DD"
  const digits = dateStr.replace(/-/g, "");
  if (/^\d{8}$/.test(digits)) {
    const y = digits.slice(0, 4);
    const m = digits.slice(4, 6);
    const d = digits.slice(6, 8);
    return `${y}-${m}-${d}T00:00:00+09:00`;
  }

  // 이미 ISO 형식이면 그대로
  if (dateStr.includes("T")) return dateStr;

  return null;
}

/* ── 메인 파서 ────────────────────────────────── */

/** API 응답 항목 하나를 NaverCafeDeal로 변환. */
export function parseNaverCafeItem(
  item: NaverCafeApiItem,
  collectedAt: string,
): NaverCafeDeal {
  const title = decodeHtmlEntities(
    item.title.replace(/<[^>]*>/g, "").trim(),
  );
  const description = decodeHtmlEntities(
    (item.description || "").replace(/<[^>]*>/g, "").trim(),
  );
  const cafeName = decodeHtmlEntities(item.cafename || "");
  const cafeUrl = item.cafeurl || "";
  const postUrl = item.link || "";
  const postId = extractPostId(postUrl);

  // 가격: 제목에서만 추출.
  // 맘카페 후기글은 본문에 가격을 부수적으로 언급하는 경우가 많아
  // ("36,000원을 더 냈지만" 등) description 추출은 오탐을 유발한다.
  // 핫딜 공지글은 제목에 가격을 명시하는 패턴 ("200개 48,000원" 등).
  const combinedText = `${title} ${description}`;
  const price = extractPriceFromText(title);

  // 통화: 텍스트 증거 → 스토어 추정 → 기본 KRW
  const detected = detectCurrency(combinedText, cafeName);
  const currency: Currency | null = detected ?? (price !== null ? "KRW" : null);

  // 가격 텍스트 (원본 보존)
  const priceText = price !== null ? `${price.toLocaleString()}원` : "";

  return {
    id: `naver_cafe-${postId}`,
    source: "naver_cafe",
    sourcePostId: postId,
    sourceUrl: postUrl,
    title,
    category: null,
    postedAt: null, // API에서 제공하지 않음
    products: [
      {
        name: null, // 스니펫에서 상품명을 신뢰할 수 있게 분리 불가
        price,
        currency,
        priceText,
        shipping: null,
        shippingText: null,
        store: cafeName || null,
        url: null,
        urlType: "none" as const,
      },
    ],
    status: "unknown" as const, // 스니펫만으로는 종료 여부 판정 불가
    stats: { views: null, recommendations: null, comments: null },
    discount: {
      type: [],
      codes: [],
      stackable: [],
      alternatives: [],
      description: "",
    },
    sourceMeta: {
      affiliate: false as const,
      rawUrl: null,
      cafeName,
      cafeUrl,
      rawPrice: price !== null ? String(price) : null,
      rawShipping: null,
      originalProductUrl: null,
    },
    collectedAt,
  };
}

/** API 응답 전체 처리 — 중복 제거 포함. */
export function parseNaverCafeResponse(
  items: NaverCafeApiItem[],
  collectedAt: string,
): NaverCafeDeal[] {
  const seen = new Set<string>();
  const deals: NaverCafeDeal[] = [];

  for (const item of items) {
    if (!item.link) continue;
    const postId = extractPostId(item.link);
    if (seen.has(postId)) continue;
    seen.add(postId);
    deals.push(parseNaverCafeItem(item, collectedAt));
  }

  return deals;
}
