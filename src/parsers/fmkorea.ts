import * as cheerio from "cheerio";
import { stripFalseEndedSignals } from "./status";

export type FmkoreaProduct = {
  name: string | null;
  price: number | null;
  currency: "KRW" | "USD" | "JPY" | "CNY" | "EUR" | null;
  priceText: string | null;
  shipping: number | null;
  shippingText: string | null;
  store: string | null;
  url: string | null;
  urlType:
    | "direct"
    | "redirect"
    | "affiliate"
    | "javascript"
    | "app"
    | "none"
    | "unknown";
};

export type FmkoreaDeal = {
  id: string;
  source: "fmkorea";
  sourcePostId: string;
  sourceUrl: string;
  title: string;
  category: string | null;

  /** ISO 8601 (+09:00) 또는 null */
  postedAt: string | null;

  products: FmkoreaProduct[];

  status: "active" | "ended" | "unknown";

  stats: {
    views: number | null;
    recommendations: number | null;
    comments: number | null;
  };

  discount: {
    type: string[];
    codes: string[];
    description: string;
  };

  sourceMeta: {
    affiliate: boolean;
    rawUrl: string | null;
    rawPrice: string | null;
    rawShipping: string | null;

    /**
     * 본문에 포함된 커뮤니티 내부 게시글 링크
     * (모음글, 과거 딜 참조 등).
     *
     * 게시판 규칙상 모음글 링크는 금지지만 실제로 존재한다.
     * 상품 링크가 아니므로 products에는 절대 넣지 않고
     * 여기에만 수집한다. (추후 모음 기능 등의 재료)
     */
    internalLinks: Array<{
      /** 본문에 적힌 그대로의 URL */
      rawUrl: string;
      /** https://www.fmkorea.com/<srl> 정규화 URL */
      url: string;
      /** 링크가 포함된 본문 줄 (참고용 원문) */
      text: string;
    }>;
  };

  collectedAt: string;
};

type HotdealTableData = {
  rawUrl: string | null;
  url: string | null;
  store: string | null;
  product: string | null;

  price: number | null;
  currency: FmkoreaProduct["currency"];
  priceText: string | null;

  shipping: number | null;
  shippingText: string | null;

  affiliate: boolean;
};

/**
 * FMKorea 핫딜 게시글 parser
 *
 * 핵심 원칙
 *
 * 1. 원본 유지
 * 2. HTML에서 확인되는 값만 정규화
 * 3. 상품명을 임의로 생성하지 않음
 * 4. 상품 페이지를 여기서 fetch하지 않음
 * 5. 여러 상품 글은 본문에서 실제로 확인되는 경우에만 분리
 * 6. 상품 페이지 title 조회는 향후 별도 resolver의 fallback
 */
export function parseFmkoreaHtml(
  html: string,
  options?: {
    sourceUrl?: string;
    collectedAt?: string;
  },
): FmkoreaDeal {
  const $ = cheerio.load(html);

    const sourceUrl = normalizeUrl(
    options?.sourceUrl ??
    $('link[rel="canonical"]').attr("href") ??
    "",
) ?? "";

  const sourcePostId =
    extractPostId(sourceUrl, html);

  const title = extractTitle($);
  const category = extractCategory($);
  const postedAt = extractPostedAt($);

  const tableData =
    extractHotdealTable($);

  /*
   * 본문에서 상품 단위 정보가 실제로 발견된 경우에만
   * 복수 상품으로 취급한다.
   *
   * 단순히 링크가 여러 개 있다는 이유만으로
   * 여러 상품으로 분리하지 않는다.
   */
  const bodyProducts =
    extractProductsFromBody($);

  let products: FmkoreaProduct[];

  if (bodyProducts.length > 0) {
    products =
      mergeBodyProductsWithTable(
        bodyProducts,
        tableData,
      );
  } else if (
    tableData.product !== null ||
    tableData.url !== null
  ) {
    products = [
      {
        name: tableData.product,
        price: tableData.price,
        currency: tableData.currency,
        priceText: tableData.priceText,
        shipping: tableData.shipping,
        shippingText: tableData.shippingText,
        store: tableData.store,
        url: tableData.url,
        urlType: detectUrlType(
          tableData.url,
          tableData.rawUrl,
        ),
      },
    ];
  } else {
    products = [];
  }

  const stats = extractStats($);
  const discount = extractDiscount($);
  const status = extractStatus($, title);

  const internalLinks = extractInternalLinks(
    $,
    sourcePostId,
  );

  const affiliate =
    tableData.affiliate ||
    products.some(
      (product) =>
        product.urlType === "affiliate",
    );

  return {
    id: `fmkorea-${sourcePostId}`,
    source: "fmkorea",
    sourcePostId,
    sourceUrl,
    title,
    category,
    postedAt,
    products,
    status,
    stats,
    discount,

    sourceMeta: {
      affiliate,
      rawUrl: tableData.rawUrl,
      rawPrice: tableData.priceText,
      rawShipping: tableData.shippingText,
      internalLinks,
    },

    collectedAt:
      options?.collectedAt ??
      new Date().toISOString(),
  };
}

/* =========================================================
 * Title
 * ======================================================= */

function extractTitle(
  $: cheerio.CheerioAPI,
): string {
  const selectors = [
    "h1.xe_content",
    ".document_title",
    ".read_title",
    "h1.title",
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
  ];

  for (const selector of selectors) {
    const element =
      $(selector).first();

    if (element.length === 0) {
      continue;
    }

    const value =
      selector.startsWith("meta")
        ? element.attr("content")
        : element.text();

    if (value?.trim()) {
      return cleanText(value);
    }
  }

  return "";
}

/* =========================================================
 * Category
 * ======================================================= */

function extractCategory(
  $: cheerio.CheerioAPI,
): string | null {
  const selectors = [
    ".category",
    ".document_category",
    ".board_category",
    ".hotdeal_category",
  ];

  for (const selector of selectors) {
    const value = cleanText(
      $(selector).first().text(),
    );

    if (value) {
      return value;
    }
  }

  return null;
}

/* =========================================================
 * PostedAt
 *
 * 상세 페이지 읽기 헤더:
 *   <div class="rd_hd ...">
 *     <div class="top_area ngeb">
 *       <span class="date m_no">2026.08.26 12:03</span>
 *
 * 목록 위젯의 span.regdate(시간만 표시)와 혼동하지 않도록
 * 읽기 헤더 셀렉터로 제한한다.
 * ======================================================= */

function extractPostedAt(
  $: cheerio.CheerioAPI,
): string | null {
  const selectors = [
    ".rd_hd .date.m_no",
    ".rd_hd .top_area .date",
    ".rd .top_area .date",
  ];

  for (const selector of selectors) {
    const value = cleanText(
      $(selector).first().text(),
    );

    const match = value.match(
      /^(\d{4})\.(\d{2})\.(\d{2})\.?\s+(\d{1,2}):(\d{2})/,
    );

    if (!match) {
      continue;
    }

    const [, year, month, day, hour, minute] =
      match;

    return (
      `${year}-${month}-${day}` +
      `T${hour.padStart(2, "0")}:${minute}:00+09:00`
    );
  }

  return null;
}

/* =========================================================
 * Hotdeal table
 *
 * FMKorea 실제 구조:
 *
 * <table class="hotdeal_table">
 *   <tr>
 *     <th>링크</th>
 *     <td>
 *       <a class="hotdeal_url">...</a>
 *     </td>
 *   </tr>
 *
 *   <tr>
 *     <th>쇼핑몰</th>
 *     <td>...</td>
 *   </tr>
 *
 *   <tr>
 *     <th>상품명</th>
 *     <td>...</td>
 *   </tr>
 *
 *   <tr>
 *     <th>가격</th>
 *     <td>...</td>
 *   </tr>
 *
 *   <tr>
 *     <th>배송</th>
 *     <td>...</td>
 *   </tr>
 * </table>
 * ======================================================= */

function extractHotdealTable(
  $: cheerio.CheerioAPI,
): HotdealTableData {
  const result: HotdealTableData = {
    rawUrl: null,
    url: null,
    store: null,
    product: null,
    price: null,
    currency: null,
    priceText: null,
    shipping: null,
    shippingText: null,
    affiliate: false,
  };

  const table =
    $("table.hotdeal_table").first();

  if (table.length === 0) {
    return result;
  }

  table.find("tr").each((_, row) => {
    const th = cleanText(
      $(row)
        .find("th")
        .first()
        .text(),
    );

    const td =
      $(row)
        .find("td")
        .first();

    if (!th || td.length === 0) {
      return;
    }

    const value = cleanText(
      td.text(),
    );

    if (th === "링크") {
      const anchor =
        td.find("a.hotdeal_url").first();

      if (anchor.length > 0) {
        const href =
          anchor.attr("href") ?? null;

        const text =
          cleanText(anchor.text());

        result.rawUrl =
          href || text || null;

        result.url =
          normalizeUrl(
            href || text || null,
          );

        result.affiliate =
          detectAffiliate(
            td,
            href,
          );
      }

      /*
       * FMKorea는 제휴 링크인 경우 "링크" 헤더 옆에
       * 커미션 안내 툴팁 버튼(.affiliate_info)을 렌더링한다.
       */
      const infoButton =
        $(row).find(".affiliate_info");

      if (infoButton.length > 0) {
        result.affiliate = true;
      }

      return;
    }

    if (th === "쇼핑몰") {
      /*
       * "알리 [포텐 터짐 우대 쇼핑몰, 제휴 링크]" 처럼
       * 쇼핑몰 행 자체에 제휴 여부가 표시되는 경우가 있다.
       * 스토어명을 정제하기 전에 이 신호부터 확인한다.
       */
      if (
        /제휴\s*링크|커미션/.test(value)
      ) {
        result.affiliate = true;
      }

      result.store =
        removeAffiliateText(value);

      return;
    }

    if (th === "상품명") {
      result.product =
        value || null;

      return;
    }

    if (th === "가격") {
      result.priceText =
        value || null;

      const parsed =
        parsePrice(value);

      result.price =
        parsed.price;

      result.currency =
        parsed.currency;

      return;
    }

    /*
     * 실제 펨코 HTML에서는
     * "배송"으로 들어오는 경우와
     * "배송비"인 경우를 모두 허용.
     */
    if (
      th === "배송" ||
      th === "배송비"
    ) {
      result.shippingText =
        value || null;

      result.shipping =
        parseShipping(value);

      return;
    }
  });

  return result;
}

/* =========================================================
 * Affiliate
 * ======================================================= */

function detectAffiliate(
  td: cheerio.Cheerio<any>,
  href: string | null,
): boolean {
  const html =
    td.toString().toLowerCase();

  const hrefText =
    (href ?? "").toLowerCase();

  /*
   * FMKorea 자체가 제휴 링크로 전환할 수 있다는
   * 안내 문구가 존재하는 경우.
   */
  if (
    html.includes("제휴 링크") ||
    html.includes("커미션")
  ) {
    return true;
  }

  if (
    hrefText.includes(
      "link.fmkorea.org",
    )
  ) {
    return true;
  }

  if (
    hrefText.includes("affiliate") ||
    hrefText.includes("partner")
  ) {
    return true;
  }

  return false;
}

/* =========================================================
 * Body products
 *
 * 중요:
 *
 * "링크가 여러 개 있다"
 * =
 * "여러 상품이다"
 *
 * 로 판단하지 않는다.
 *
 * 본문에 상품 단위 구조가 실제로 존재할 때만
 * 복수 상품으로 분리한다.
 *
 * 상품명 / 가격 / URL을 확실하게 연결할 수 없는 경우
 * 임의로 매칭하지 않는다.
 * ======================================================= */

function extractProductsFromBody(
  $: cheerio.CheerioAPI,
): FmkoreaProduct[] {
  const body =
    findArticleBody($);

  if (body.length === 0) {
    return [];
  }

  const text =
    cleanTextWithNewlines(
      textWithBlockNewlines(body),
    );

  const sections =
    splitNumberedProductSections(
      text,
    );

  /*
   * 번호가 붙은 상품 섹션이 없는 경우
   * 복수 상품으로 판단하지 않는다.
   */
  if (sections.length < 2) {
    return [];
  }

  const products: FmkoreaProduct[] = [];

  sections.forEach(
    (section) => {
      const name =
        extractProductNameFromSection(
          section,
        );

      const priceText =
        extractProductPriceText(
          section,
        );

      const parsed =
        parsePrice(priceText);

      const url =
        extractFirstUrl(section);

      /*
       * 가격 또는 URL이 해당 섹션에서 실제로 확인될 때만
       * 상품으로 기록한다.
       *
       * 상품명(첫 줄)만 있는 섹션은 상품이라는 증거가 부족하다.
       * 실제 사례: 할인 받는 방법을 번호로 설명한 글
       * ("1. 장바구니담기 / 2. 홈 -> 코인 -> ...")이
       * 상품으로 오인식되어 hotdeal table의 진짜 상품명을
       * 덮어쓰는 문제가 있었음.
       */
      if (
        !priceText &&
        !url
      ) {
        return;
      }

      products.push({
        name,
        price: parsed.price,
        currency: parsed.currency,
        priceText,
        shipping: null,
        shippingText: null,
        store: null,
        url,
        urlType:
          detectUrlType(
            url,
            null,
          ),
      });
    },
  );

  return products;
}

/*
 * cheerio의 .text()는 <p>, <br>, <div> 등 블록 요소 사이에
 * 아무 구분자도 넣지 않는다.
 *
 *   <p>A</p><p>B</p>  →  .text() 결과: "AB" (줄바꿈도, 공백도 없음)
 *
 * 이 때문에:
 * - splitNumberedProductSections()가 "1. ... 2. ..." 를
 *   서로 다른 줄로 인식하지 못해 다중 상품이 절대 분리되지 않음
 * - extractDiscount()의 문장들이 공백 없이 붙어버림
 *   (예: "가능함할인코드" 처럼 문장 경계가 사라짐)
 *
 * 실제 텍스트를 뽑기 전에 블록 경계에 개행을 명시적으로 삽입한다.
 */
function textWithBlockNewlines(
  el: cheerio.Cheerio<any>,
): string {
  const html = el.html() ?? "";

  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|li|tr|h[1-6])>/gi,
      "\n</$1>",
    );

  const fragment =
    cheerio.load(withBreaks);

  return fragment.root().text();
}

function findArticleBody(
  $: cheerio.CheerioAPI,
): cheerio.Cheerio<any> {
  const selectors = [
    ".rd_body article > .xe_content",
    ".rd_body article .xe_content",
    ".rd_body .xe_content",
    ".document_communication .xe_content",
    ".rd_body",
  ];

  for (const selector of selectors) {
    const element = $(selector).first();

    if (element.length > 0) {
      return element;
    }
  }

  return $();
}

/* =========================================================
 * Numbered product sections
 * ======================================================= */

function splitNumberedProductSections(
  text: string,
): string[] {
  /*
   * ES2018 / dotAll flag를 사용하지 않는다.
   * 현재 프로젝트에서 발생했던
   * "regular expression flag" 오류를 피하기 위함.
   */

  const regex =
    /(?:^|\n)\s*\d+\.\s+[\s\S]*?(?=\n\s*\d+\.\s+|$)/g;

  const matches =
    text.match(regex);

  if (!matches) {
    return [];
  }

  return matches.map(
    (section) =>
      section.trim(),
  );
}

function extractProductNameFromSection(
  section: string,
): string | null {
  const lines =
    section
      .split("\n")
      .map((line) =>
        cleanText(line),
      )
      .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  const firstLine =
    lines[0]
      .replace(
        /^\d+\.\s*/,
        "",
      )
      .trim();

  /*
   * 가격만 있는 첫 줄은 상품명이 아니다.
   */
  if (
    /^(?:[$€£¥₩]\s*)?[\d,]+(?:\.\d+)?\s*(?:원|USD|KRW|JPY|CNY|EUR)?$/i.test(
      firstLine,
    )
  ) {
    return null;
  }

  return firstLine || null;
}

function extractProductPriceText(
  section: string,
): string | null {
  const patterns = [
    /(?:=|가격\s*:?)\s*([$€£¥₩]?\s?[\d,]+(?:\.\d+)?\s*(?:원|USD|KRW|JPY|CNY|EUR)?)/i,

    /([$€£¥₩]\s?[\d,]+(?:\.\d+)?)/i,

    /([\d,]+(?:\.\d+)?\s*원)/i,
  ];

  for (const pattern of patterns) {
    const match =
      section.match(pattern);

    if (match?.[1]) {
      return cleanText(
        match[1],
      );
    }
  }

  return null;
}

/* =========================================================
 * Merge
 * ======================================================= */

function mergeBodyProductsWithTable(
  bodyProducts: FmkoreaProduct[],
  tableData: HotdealTableData,
): FmkoreaProduct[] {
  if (
    bodyProducts.length === 0
  ) {
    return [];
  }

  /*
   * 본문에서 확인한 값은 우선 유지한다.
   *
   * table은 대표 상품에 대한 구조화 정보이므로
   * 본문 상품 정보가 비어 있는 경우에만
   * 보완한다.
   *
   * 절대로 table의 상품명을 다른 상품에 복사하지 않는다.
   */
  return bodyProducts.map(
    (product, index) => {
      if (index !== 0) {
        return product;
      }

      return {
        ...product,

        name:
          product.name ??
          tableData.product,

        price:
          product.price ??
          tableData.price,

        currency:
          product.currency ??
          tableData.currency,

        priceText:
          product.priceText ??
          tableData.priceText,

        shipping:
          product.shipping ??
          tableData.shipping,

        shippingText:
          product.shippingText ??
          tableData.shippingText,

        store:
          product.store ??
          tableData.store,

        url:
          product.url ??
          tableData.url,

        urlType:
          product.url
            ? product.urlType
            : detectUrlType(
                tableData.url,
                tableData.rawUrl,
              ),
      };
    },
  );
}

/* =========================================================
 * URL
 * ======================================================= */

function detectUrlType(
  url: string | null,
  rawUrl: string | null,
): FmkoreaProduct["urlType"] {
  /*
   * URL 자체가 전혀 없는 경우 (앱 진입형 딜, 코인딜 등
   * 인계서에 정리된 "구매 URL 없음" 케이스).
   * "unknown"과 구분해서, 애초에 URL이 없었다는 것을
   * 명확히 표현한다.
   */
  if (!url && !rawUrl) {
    return "none";
  }

  const value =
    `${rawUrl ?? ""} ${url ?? ""}`
      .toLowerCase();

  if (
    value.startsWith("javascript:") ||
    value.includes("javascript:gotolink")
  ) {
    return "javascript";
  }

  if (
    value.includes(
      "link.fmkorea.org",
    ) ||
    value.includes("affiliate") ||
    value.includes("partner")
  ) {
    return "affiliate";
  }

  if (
    value.includes(
      "toss.shopping",
    ) ||
    value.includes("toss.me")
  ) {
    return "app";
  }

  /*
   * rawUrl과 정규화된 url이 서로 다르면
   * (원본이 리다이렉트를 거쳐 실제 URL로 바뀐 경우)
   * 커미션 여부가 확인되지 않은 일반 리다이렉트로 본다.
   */
  if (
    rawUrl &&
    url &&
    rawUrl.trim() !== url.trim()
  ) {
    return "redirect";
  }

  if (url) {
    return "direct";
  }

  return "unknown";
}

function normalizeUrl(
  value: string | null,
): string | null {
  if (!value) {
    return null;
  }

  let url = value.trim();

  /*
   * Markdown 형태가 들어온 경우:
   * [https://example.com](https://example.com)
   *
   * HTML fixture가 Markdown으로 변환된 경우에도
   * 실제 URL만 추출한다.
   */
  const markdownMatch = url.match(
    /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/,
  );

  if (markdownMatch?.[2]) {
    url = markdownMatch[2];
  } else {
    const markdownUrlMatch = url.match(
      /https?:\/\/[^\s)\]]+/i,
    );

    if (markdownUrlMatch?.[0]) {
      url = markdownUrlMatch[0];
    }
  }

  if (url.startsWith("//")) {
    url = `https:${url}`;
  }

  if (!/^https?:\/\//i.test(url)) {
    return null;
  }

  return url;
}

/* =========================================================
 * Post ID
 * ======================================================= */

function extractPostId(
  sourceUrl: string,
  html: string,
): string {
  const urlMatch =
    sourceUrl.match(
      /\/(\d{6,})(?:[/?#]|$)/,
    );

  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  const documentMatch =
    html.match(
      /document_srl[="'\s:]+(\d{6,})/,
    );

  if (documentMatch?.[1]) {
    return documentMatch[1];
  }

  return "unknown";
}

/* =========================================================
 * Price
 * ======================================================= */

function parsePrice(
  value: string | null,
): {
  price: number | null;
  currency: FmkoreaProduct["currency"];
} {
  if (!value) {
    return {
      price: null,
      currency: null,
    };
  }

  const normalized =
    value.trim();

  const match =
    normalized.match(
      /[$€£¥₩]?\s*[\d,]+(?:\.\d+)?/,
    );

  if (!match) {
    return {
      price: null,
      currency: null,
    };
  }

  const price =
    Number(
      match[0]
        .replace(
          /[$€£¥₩,\s]/g,
          "",
        ),
    );

  if (
    Number.isNaN(price)
  ) {
    return {
      price: null,
      currency: null,
    };
  }

  if (
    normalized.includes("$") ||
    /USD/i.test(
      normalized,
    )
  ) {
    return {
      price,
      currency: "USD",
    };
  }

  if (
    normalized.includes("₩") ||
    normalized.includes("￦") ||
    normalized.includes("원") ||
    /KRW/i.test(
      normalized,
    )
  ) {
    return {
      price,
      currency: "KRW",
    };
  }

  if (
    normalized.includes("¥") ||
    /JPY/i.test(
      normalized,
    )
  ) {
    return {
      price,
      currency: "JPY",
    };
  }

  if (/CNY/i.test(normalized)) {
    return {
      price,
      currency: "CNY",
    };
  }

  if (
    normalized.includes("€") ||
    /EUR/i.test(
      normalized,
    )
  ) {
    return {
      price,
      currency: "EUR",
    };
  }

  return {
    price,
    currency: null,
  };
}

/* =========================================================
 * Shipping
 * ======================================================= */

function parseShipping(
  value: string,
): number | null {
  if (!value) {
    return null;
  }

  const normalized =
    value.replace(
      /\s+/g,
      "",
    );

  if (
    normalized.includes("무료") ||
    normalized.includes(
      "무료배송",
    )
  ) {
    return 0;
  }

  const match =
    normalized.match(
      /[\d,]+(?:\.\d+)?/,
    );

  if (!match) {
    return null;
  }

  const valueNumber =
    Number(
      match[0].replace(
        /,/g,
        "",
      ),
    );

  return Number.isNaN(
    valueNumber,
  )
    ? null
    : valueNumber;
}

/* =========================================================
 * Status
 * ======================================================= */

function extractStatus(
  $: cheerio.CheerioAPI,
  title: string,
): FmkoreaDeal["status"] {
  /*
   * 사이트 네이티브 종료 마커. 본문<article> 밖(.rd_body 직하)에
   * 나와서 본문 텍스트 스캔으로는 못 잡는다. 클래스 접미사
   * (var8Y 등)는 세션마다 바뀌므로 접두사로 매치한다.
   */
  const marker = $('div[class*="hotdeal_var"]')
    .map((_, el) => $(el).text())
    .get()
    .join(" ");

  if (/종료/.test(marker)) {
    return "ended";
  }

  /*
   * 페이지 전체(사이드바의 다른 딜 제목, 댓글 등)를 스캔하면
   * 이 글과 무관한 텍스트에서 "종료" 같은 단어가 우연히
   * 매치될 수 있다. 제목 + 본문으로만 범위를 좁힌다.
   */
  const body = findArticleBody($);

  const bodyText =
    body.length > 0
      ? cleanText(body.text())
      : "";

  /*
   * 조건부/서술 표현("품절시 종료처리하겠습니다",
   * "품절만 뜨던 ○○이 재입고")은 종료 신호가 아니므로
   * 공통 헬퍼로 제거 후 키워드 판정한다. (src/parsers/status.ts)
   */
  const combined = stripFalseEndedSignals(
    `${title} ${bodyText}`,
  );

  if (
    /종료|품절|끝났|마감|판매종료|딜종료/i.test(
      combined,
    )
  ) {
    return "ended";
  }

  if (
    /진행중|현재|판매중|구매가능/i.test(
      combined,
    )
  ) {
    return "active";
  }

  return "unknown";
}

/* =========================================================
 * Stats
 * ======================================================= */

function extractStats(
  $: cheerio.CheerioAPI,
): FmkoreaDeal["stats"] {
  /*
   * 실제 마크업: .rd_hd .btm_area.clear .side.fr 안에
   * "조회 수 <b>3946</b>", "추천 수 <b>3</b>", "댓글 <b>2</b>"
   * 형태로 존재한다. (구 selector였던 .rd_head는 실제로
   * 존재하지 않는 클래스였음)
   */
  const documentArea =
    $(".rd_hd .btm_area").first();

  const text =
    documentArea.length > 0
      ? cleanText(documentArea.text())
      : cleanText($(".rd_hd").first().text());

  return {
    views: extractStat(
      text,
      /조회\s*(?:수)?\s*([\d,]+)/,
    ),

    recommendations: extractStat(
      text,
      /추천\s*(?:수)?\s*([\d,]+)/,
    ),

    comments: extractStat(
      text,
      /댓글\s*(?:수)?\s*([\d,]+)/,
    ),
  };
}

function extractStat(
  text: string,
  regex: RegExp,
): number | null {
  const match =
    text.match(regex);

  if (!match?.[1]) {
    return null;
  }

  const value =
    Number(
      match[1].replace(
        /,/g,
        "",
      ),
    );

  return Number.isNaN(
    value,
  )
    ? null
    : value;
}

/* =========================================================
 * Discount
 * ======================================================= */

function extractDiscount(
  $: cheerio.CheerioAPI,
): FmkoreaDeal["discount"] {
  const body = findArticleBody($);

  if (body.length === 0) {
    return {
      type: [],
      codes: [],
      description: "",
    };
  }

  const bodyText = cleanTextWithNewlines(
    textWithBlockNewlines(body),
  );

  const codes = extractDiscountCodes(bodyText);

  const type: string[] = [];

  const keywordMap: Array<
    [RegExp, string]
  > = [
    [/스토어\s*쿠폰/i, "스토어쿠폰"],
    [/상품\s*쿠폰/i, "상품쿠폰"],
    [/프로모션\s*쿠폰/i, "프로모션쿠폰"],
    [/카드\s*할인/i, "카드할인"],
    [/토스\s*페이/i, "토스페이"],
    [/카카오\s*페이/i, "카카오페이"],
    [/네이버\s*페이/i, "네이버페이"],
    [/코인/i, "코인"],
    [/적립/i, "적립"],
    [/할인\s*코드/i, "할인코드"],
  ];

  for (const [regex, label] of keywordMap) {
    if (regex.test(bodyText)) {
      type.push(label);
    }
  }

  /*
   * 본문에 실제로 존재하는 할인 관련 문장만 보존한다.
   *
   * body는 이미 article > xe_content로 제한되어 있으므로
   * 댓글 / 주소복사 / 스크랩 / 페이지 네비게이션 등의
   * UI 텍스트가 들어오지 않는다.
   */
  const discountLines = bodyText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) =>
      /쿠폰|할인|적립|페이|코드|코인/i.test(line),
    );

  return {
    type: Array.from(new Set(type)),
    codes,
    description: discountLines.join(" / "),
  };
}

function extractDiscountCodes(text: string): string[] {
  const codes = new Set<string>();

  const patterns = [
    /할인코드\s*[:：]?\s*([A-Z0-9_-]{4,30})/gi,
    /쿠폰코드\s*[:：]?\s*([A-Z0-9_-]{4,30})/gi,

    /*
     * 실제 게시글에서 자주 쓰이는 형태:
     *   "코드 ALPK07"
     *   "스토어쿠폰 CUBET830"
     *
     * 토큰을 대문자 영숫자 조합으로 제한해서
     * 한국어 문장이 잘못 걸리지 않게 한다.
     * (기존 패턴들이 앞에 오는 형태도 자연스럽게 포함된다)
     */
    /쿠폰\s*[:：]?\s*([A-Z0-9][A-Z0-9_-]{3,29})/gi,
    /코드\s*[:：]?\s*([A-Z0-9][A-Z0-9_-]{3,29})/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const code = match[1]?.trim();

      if (code) {
        codes.add(code);
      }
    }
  }

  return Array.from(codes);
}

/* =========================================================
 * URL helpers
 * ======================================================= */

function isExternalProductUrl(
  url: string,
): boolean {
  try {
    const parsed =
      new URL(url);

    const hostname =
      parsed.hostname.toLowerCase();

    if (
      hostname ===
        "fmkorea.com" ||
      hostname.endsWith(
        ".fmkorea.com",
      )
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function extractFirstUrl(
  section: string,
): string | null {
  const match =
    section.match(
      /https?:\/\/[^\s<>"']+/,
    );

  if (!match) {
    return null;
  }

  return normalizeUrl(
    match[0],
  );
}

/* =========================================================
 * Internal links (모음글 등)
 *
 * 본문에 포함된 커뮤니티 내부 게시글 링크를 수집한다.
 * 상품 링크는 products[]로 가고, 내부 링크는 본문에
 * 섞여 있어도 절대 products에 넣지 않고
 * sourceMeta.internalLinks에만 기록한다.
 * ======================================================= */

function extractInternalLinks(
  $: cheerio.CheerioAPI,
  sourcePostId: string,
): FmkoreaDeal["sourceMeta"]["internalLinks"] {
  const body = findArticleBody($);

  if (body.length === 0) {
    return [];
  }

  const bodyText = cleanTextWithNewlines(
    textWithBlockNewlines(body),
  );

  const found = new Map<
    string,
    { rawUrl: string; url: string; text: string }
  >();

  for (const line of bodyText.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    for (const match of trimmed.matchAll(
      /https?:\/\/(?:www\.|m\.)?fmkorea\.com\/[^\s<>"']+/g,
    )) {
      /*
       * 문장 끝 문장부점이 URL에 달라붙는 경우를
       * 정리한 뒤 파싱한다.
       */
      const rawUrl = match[0].replace(
        /[.,!?)\]]+$/,
        "",
      );

      const srl = extractFmkoreaDocSrl(rawUrl);

      if (!srl) {
        continue;
      }

      // 자기 자신(게시글 자체 링크)은 제외
      if (
        sourcePostId !== "" &&
        srl === sourcePostId
      ) {
        continue;
      }

      const url =
        `https://www.fmkorea.com/${srl}`;

      if (found.has(url)) {
        continue;
      }

      found.set(url, {
        rawUrl,
        url,
        text: trimmed.slice(0, 200),
      });
    }
  }

  return Array.from(found.values());
}

/**
 * fmkorea URL에서 document_srl을 추출한다.
 *
 * - 짧은 형태: https://www.fmkorea.com/10219294014
 * - 긴 형태:   https://www.fmkorea.com/index.php?mid=hotdeal&document_srl=10219294014
 *
 * 게시글 링크 형태가 아니면 null.
 */
function extractFmkoreaDocSrl(
  url: string,
): string | null {
  try {
    const parsed = new URL(url);
    const hostname =
      parsed.hostname.toLowerCase();

    if (
      hostname !== "fmkorea.com" &&
      !hostname.endsWith(".fmkorea.com")
    ) {
      return null;
    }

    const byParam = parsed.searchParams.get(
      "document_srl",
    );

    if (byParam && /^\d{6,}$/.test(byParam)) {
      return byParam;
    }

    const pathMatch = parsed.pathname.match(
      /^\/(\d{6,})(?:\/|$)/,
    );

    if (pathMatch?.[1]) {
      return pathMatch[1];
    }

    return null;
  } catch {
    return null;
  }
}

/* =========================================================
 * Helpers
 * ======================================================= */

function removeAffiliateText(
  value: string,
): string {
  return value
    .replace(
      /\[?포텐\s*터짐\s*우대\s*쇼핑몰[^\]]*\]?/gi,
      "",
    )
    .replace(
      /\[?제휴\s*링크[^\]]*\]?/gi,
      "",
    )
    .replace(
      /\s+/g,
      " ",
    )
    .trim();
}

function cleanText(
  value: string,
): string {
  return value
    .replace(
      /\u00a0/g,
      " ",
    )
    .replace(
      /\s+/g,
      " ",
    )
    .trim();
}

function cleanTextWithNewlines(
  value: string,
): string {
  return value
    .replace(
      /\u00a0/g,
      " ",
    )
    .replace(
      /\r/g,
      "",
    )
    .replace(
      /[ \t]+/g,
      " ",
    )
    .replace(
      /\n\s*\n+/g,
      "\n",
    )
    .trim();
}