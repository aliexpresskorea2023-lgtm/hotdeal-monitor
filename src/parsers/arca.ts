import * as cheerio from "cheerio";
import { stripFalseEndedSignals } from "./status";

export type ArcaProduct = {
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
  /**
   * unsafelink.com 래핑 형태의 원본 URL.
   * (아카라이브는 모든 외부 링크를 https://unsafelink.com/<실제URL>
   * 로 감싼다.) 직접 링크면 null.
   */
  rawUrl: string | null;
};

export type ArcaDeal = {
  id: string;
  source: "arca";
  sourcePostId: string;
  sourceUrl: string;
  /** arca.live/b/<board>/<id> 의 board 슬러그 (예: hotdeal) */
  boardId: string | null;
  title: string;
  category: string | null;
  /** ISO 8601 (+09:00) 또는 null */
  postedAt: string | null;

  products: ArcaProduct[];

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
     * DOM에 드러난 1차 상태 신호.
     * 종료 글은 제목 div에 close-deal 클래스, 진행 글은
     * "LIVE" 버블(span.bubble.live)이 붙는다. 둘 다 없으면 null.
     */
    statusLabel: string | null;
    /**
     * 폼의 기타 행. 링크/쇼핑몰/상품명/가격/배송비 외의
     * 라벨→값 원문. 정형 스키마가 없어 문자열 지도로 보존한다.
     */
    formExtra: Record<string, string>;
    /** 본문에서 수집한 외부 링크 (원본+복원). 추적용. */
    bodyLinks: Array<{
      raw: string | null;
      resolved: string | null;
    }>;
    /**
     * 본문에 포함된 아카라이브 내부 게시글 링크 (모음글, 과거 딜 참조 등).
     * 상품 링크가 아니므로 products에는 절대 넣지 않는다.
     */
    internalLinks: Array<{
      rawUrl: string;
      url: string;
      text: string;
    }>;
  };

  collectedAt: string;
};

/**
 * 아카라이브(arca.live) 핫딜 채널 parser
 *
 * 대상: arca.live/b/hotdeal/<id>
 * (핫딜 채널. 채널 필터는 크롤러의 역할이다.)
 *
 * 핵심 원칙 (fmkorea.ts / ppomppu.ts / ruliweb.ts / quasarzone.ts와 동일)
 *
 * 1. 원본 유지 — unsafelink 래핑 URL과 복원 URL을 분리 보존
 * 2. HTML에서 확인되는 값만 정규화
 * 3. 상품명을 임의로 생성하지 않음 (추출 실패 시 null)
 * 4. 상품 페이지를 여기서 fetch하지 않음
 * 5. 본문에서 상품 단위 구조가 확인되지 않으면 분리하지 않음
 *
 * 아카라이브 마크업 특징 (2026-08 실측 페이지 기준)
 *
 * - 제목:        div.title-row div.title — 안에 카테고리 배지
 *   span.badge.category-badge가 포함되므로 제거 후 텍스트를 취한다.
 *   제목 규약은 "상품명 (가격/배송)".
 * - 상태 신호:   종료 글은 제목 div 클래스에 close-deal이 붙고
 *   폼 값 td들도 close-deal 클래스를 가진다. 진행 글은 제목 위에
 *   span.bubble.live("LIVE") 버블이 붙는다. 이 클래스/버블이
 *   1차 신호이고, 없으면 공통 가드 적용 키워드 판정 폴백.
 * - 카테고리:    span.badge.category-badge ("전자제품" 등, 채널 내 분류)
 * - 게시글 id:   URL /b/<board>/<id> (og:url과 동일)
 * - 딜 정보 폼:  table.article-options 의 tr 행. td.displayName 안
 *   첫 span이 라벨:
 *     링크       a[href="https://unsafelink.com/<실제URL>"]
 *                모든 외부 링크는 unsafelink.com 프리픽스로 감싸진다.
 *                앵커 텍스트에도 실제 URL이 그대로 적혀 있다.
 *                라벨 옆 bi-info 툴팁(제휴 커미션 공시)은 모든 글에
 *                붙는 사이트 템플릿이라 제휴 신호로 쓰지 않는다.
 *     쇼핑몰     스토어 이름
 *     상품명     작성자가 입력한 상품명 (가장 신뢰 높은 이름 소스)
 *     가격       "$14.15" / "648,000원" — exchange 요소
 *                (<exchange data-currency data-value>)가 있으면
 *                사이트가 생성한 정형 값이라 우선 채택한다.
 *     배송비     "무료" 또는 금액 (exchange 요소 동일 규칙)
 * - 본문:        div.fr-view.article-content (서버 렌더링, 댓글 미포함)
 * - 등록일:      div.article-info.article-info-section 안 첫 time 요소의
 *   datetime 속성. UTC ISO 형식(2026-08-26T02:25:06.000Z)이라
 *   +09:00 변환이 필요하다. (댓글에도 time 요소가 많아 범위 한정 필수)
 * - 조회/추천/댓글: 같은 섹션의 span.head("Views"/"Like"/"Comment"
 *   또는 한국어 "조회수"/"추천"/"댓글") 다음 형제 span.body 값.
 *   라벨 언어는 요청의 Accept-Language에 따라 달라진다.
 *
 * 핫딜 폼(링크/쇼핑몰/상품명/가격/배송비)이 있는 글만 딜로 취급하고,
 * 폼이 없는 글(공지 등)은 products: []로 안전 실패한다.
 * 폼 기준 1글 = 1딜 규약이므로 products는 최대 1개다.
 * 본문 속 추가 링크는 추적용으로만 수집한다.
 *
 * 접근 참고(2026-08 실측): Cloudflare "Just a moment" 챌린지는
 * TLS/HTTP2 지문 기반이라 일반 curl·헤드리스는 막히지만, Chrome
 * 지문 모방 클라이언트(curl_cffi impersonate="chrome" 류)는
 * 목록·상세 모두 200 통과. 수집 시 Chrome 지문 클라이언트 +
 * 보수적 스로틀 필수.
 */
export function parseArcaHtml(
  html: string,
  options?: {
    sourceUrl?: string;
    collectedAt?: string;
  },
): ArcaDeal {
  const $ = cheerio.load(html);

  const sourceUrl =
    normalizeUrl(
      options?.sourceUrl ??
        $('meta[property="og:url"]').attr("content") ??
        $('link[rel="canonical"]').attr("href") ??
        "",
    ) ?? "";

  const sourcePostId = extractPostId(sourceUrl);
  const boardId = extractBoardId(sourceUrl);

  const title = extractTitle($);
  const category = extractCategory($);
  const postedAt = extractPostedAt($);

  const statusLabel = extractStatusLabel($);

  const form = extractOptionsForm($);

  const bodyHtml = extractBodyHtml($);
  const body = cheerio.load(bodyHtml);
  const bodyText = cleanTextWithNewlines(
    textWithBlockNewlines(body.root()),
  );

  const products: ArcaProduct[] = [];

  /*
   * 핫딜 폼(article-options)이 있을 때만 딜로 취급한다.
   * 공지글 등 폼이 없는 글은 products: [] → 크롤러가 스킵한다.
   * (fmkorea의 "폼 미입력 글 스킵" 정책과 동일한 안전 장치)
   */
  if (form !== null) {
    const link = form.link;

    products.push({
      /* 폼 상품명이 1차 소스. 없으면 제목에서 가격 괄호를 제거한 폴백. */
      name: form.name ?? productNameFromTitle(title),
      price: form.price?.value ?? null,
      currency: form.price?.currency ?? null,
      priceText: form.price?.text ?? null,
      shipping: form.shipping?.value ?? null,
      shippingText: form.shipping?.text ?? null,
      store: form.store ?? null,
      url: link?.resolved ?? null,
      urlType: detectUrlType(link?.resolved ?? null, link?.rawUrl ?? null),
      rawUrl: link?.rawUrl ?? null,
    });
  }

  const stats = extractStats($);
  const discount = extractDiscount(bodyText);
  const status = extractStatus(statusLabel, title, bodyText);

  const { bodyLinks, internalLinks } = collectBodyLinks(
    body,
    sourcePostId,
  );

  const affiliate = detectAffiliate(bodyText);

  return {
    id: `arca-${sourcePostId}`,
    source: "arca",
    sourcePostId,
    sourceUrl,
    boardId,
    title,
    category,
    postedAt,
    products,
    status,
    stats,
    discount,

    sourceMeta: {
      affiliate,
      rawUrl: form?.link?.rawUrl ?? null,
      rawPrice: form?.price?.text ?? null,
      rawShipping: form?.shipping?.text ?? null,
      statusLabel,
      formExtra: form?.extra ?? {},
      bodyLinks,
      internalLinks,
    },

    collectedAt:
      options?.collectedAt ?? new Date().toISOString(),
  };
}

/* =========================================================
 * Title / category / date / status label
 * ======================================================= */

function extractTitle($: cheerio.CheerioAPI): string {
  const heading = $("div.title-row div.title").first();

  if (heading.length === 0) {
    return "";
  }

  /* 카테고리 배지는 제목 텍스트가 아니다. */
  const clone = heading.clone();
  clone.find("span.badge").remove();

  return cleanText(clone.text());
}

/**
 * 제목의 후미 "(가격/배송)" 괄호를 제거한 상품명 폴백.
 * (1차 소스는 폼의 상품명 행이다.)
 * 괄호 내용이 가격/배송 신호를 포함할 때만 제거한다 —
 * 상품명의 일부인 괄호를 깎지 않기 위해서다.
 */
function productNameFromTitle(title: string): string | null {
  let name = title.trim();

  for (;;) {
    const match = name.match(/\s*\(([^()]*)\)\s*$/);

    if (!match?.[1]) {
      break;
    }

    const inner = match[1];
    const looksLikeDealMeta =
      /무료|무배|직배|착불/.test(inner) ||
      /[\d,]+(?:\.\d+)?\s*원/.test(inner) ||
      /[$￥￦]\s*[\d,]+(?:\.\d+)?/.test(inner) ||
      /[\d,]+(?:\.\d+)?\s*(달러|엔|유로)/.test(inner);

    if (!looksLikeDealMeta) {
      break;
    }

    name = name.slice(0, match.index).trim();
  }

  return name || null;
}

function extractCategory($: cheerio.CheerioAPI): string | null {
  const value = cleanText(
    $("div.title-row span.badge.category-badge").first().text(),
  );

  return value || null;
}

/**
 * DOM 1차 상태 신호를 취한다.
 * - 제목 div 클래스에 close-deal → "close-deal" (종료)
 * - span.bubble.live("LIVE") → "LIVE" (진행)
 * 사이트가 글 상태에 따라 붙이는 클래스라 키워드 판정보다 신뢰가 높다.
 */
function extractStatusLabel($: cheerio.CheerioAPI): string | null {
  const titleEl = $("div.title-row div.title").first();

  if (titleEl.length > 0 && hasClassToken(titleEl, "close-deal")) {
    return "close-deal";
  }

  const live = $("span.bubble.live").first();

  if (live.length > 0) {
    return "LIVE";
  }

  return null;
}

function hasClassToken(
  el: cheerio.Cheerio<any>,
  token: string,
): boolean {
  const classes = (el.attr("class") ?? "").split(/\s+/);

  return classes.includes(token);
}

/**
 * 등록일은 UTC ISO(datetime 속성)로 온다. +09:00 문자열로
 * 결정론 변환한다. (Date 파싱에 현지 타임존이 개입하지 않도록
 * 산술로 처리한다.)
 */
function extractPostedAt($: cheerio.CheerioAPI): string | null {
  const datetime = $("div.article-info time")
    .first()
    .attr("datetime");

  if (!datetime) {
    return null;
  }

  return utcIsoToKst(datetime);
}

function utcIsoToKst(value: string): string | null {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/,
  );

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;

  const shifted = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ) +
      9 * 3600 * 1000,
  );

  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    `${shifted.getUTCFullYear()}-` +
    `${pad(shifted.getUTCMonth() + 1)}-` +
    `${pad(shifted.getUTCDate())}T` +
    `${pad(shifted.getUTCHours())}:` +
    `${pad(shifted.getUTCMinutes())}:` +
    `${pad(shifted.getUTCSeconds())}+09:00`
  );
}

/* =========================================================
 * 핫딜 정보 폼 (article-options)
 *
 * td.displayName 안 span 라벨로 행을 식별한다:
 *   링크 / 쇼핑몰 / 상품명 / 가격 / 배송비
 * ======================================================= */

type OptionsForm = {
  link: { rawUrl: string | null; resolved: string | null } | null;
  store: string | null;
  name: string | null;
  price: {
    value: number | null;
    currency: ArcaProduct["currency"];
    text: string | null;
  } | null;
  shipping: {
    value: number | null;
    text: string | null;
  } | null;
  /** 링크/쇼핑몰/상품명/가격/배송비로 식별되지 않은 나머지 행. */
  extra: Record<string, string>;
};

function extractOptionsForm($: cheerio.CheerioAPI): OptionsForm | null {
  const table = $("table.article-options").first();

  if (table.length === 0) {
    return null;
  }

  const form: OptionsForm = {
    link: null,
    store: null,
    name: null,
    price: null,
    shipping: null,
    extra: {},
  };

  table.find("tr").each((_, row) => {
    const label = rowLabelText($(row));
    const td = $(row).find("td").not(".displayName").first();

    if (!label || td.length === 0) {
      return;
    }

    if (label.startsWith("링크")) {
      form.link = extractFormLink(td);
      return;
    }

    if (label.startsWith("쇼핑몰")) {
      form.store = cleanText(td.text()) || null;
      return;
    }

    if (label.startsWith("상품명")) {
      form.name = cleanText(td.text()) || null;
      return;
    }

    if (label.startsWith("가격")) {
      const text = valueText(td);

      if (text) {
        form.price = { ...parsePriceCell(td), text };
      }
      return;
    }

    if (label.startsWith("배송")) {
      const text = valueText(td);

      if (text) {
        form.shipping = {
          value: parseShippingCell(td, text),
          text,
        };
      }
      return;
    }

    /* 미분류 행 — 원문 보존. */
    const value = cleanText(td.text());

    if (value) {
      form.extra[label] = value;
    }
  });

  return form;
}

/**
 * 행의 라벨(td.displayName) 텍스트를 취한다. 제휴 커미션 툴팁
 * (span.bi-info)은 라벨 텍스트가 아니므로 제거 후 읽는다.
 */
function rowLabelText(row: cheerio.Cheerio<any>): string {
  const cell = row.find("td.displayName").first();

  if (cell.length === 0) {
    return "";
  }

  const clone = cell.clone();
  clone.find(".bi-info, .tooltip, script, style").remove();

  return cleanText(clone.text());
}

/** exchange 요소는 값이 없는 커스텀 태그지만 안전하게 제거한다. */
function valueText(td: cheerio.Cheerio<any>): string {
  const clone = td.clone();
  clone.find("exchange, script, style").remove();

  return cleanText(clone.text());
}

/**
 * 링크 행 앵커를 해석한다.
 *
 * href는 https://unsafelink.com/<실제URL> 래핑 형태다.
 * 프리픽스를 벗기면 실제 상품 URL이고, 래핑 URL을 원본으로
 * 보존한다. 앵커 텍스트에도 실제 URL이 적혀 있어 언래핑
 * 실패 시 폴백으로 쓴다.
 */
function extractFormLink(
  td: cheerio.Cheerio<any>,
): { rawUrl: string | null; resolved: string | null } {
  const anchor = td.find("a").first();

  if (anchor.length === 0) {
    return { rawUrl: null, resolved: null };
  }

  const href = anchor.attr("href") ?? "";
  const anchorText = cleanText(anchor.text());

  const unwrapped = unwrapUnsafelink(href);

  if (unwrapped !== null) {
    return {
      rawUrl: normalizeUrl(href),
      resolved: unwrapped,
    };
  }

  /* 래핑이 아니거나 언래핑 실패 — 일반 링크/앵커 텍스트 폴백. */
  const directUrl = normalizeUrl(href);

  if (directUrl) {
    return { rawUrl: null, resolved: directUrl };
  }

  const textUrl = normalizeUrl(anchorText);

  if (textUrl) {
    return { rawUrl: null, resolved: textUrl };
  }

  return { rawUrl: null, resolved: null };
}

const UNSAFELINK_PREFIX = "https://unsafelink.com/";

/**
 * unsafelink.com 프리픽스 래핑을 벗긴다.
 * 래핑이 아니거나 내부가 유효한 http(s) URL이 아니면 null.
 */
function unwrapUnsafelink(href: string): string | null {
  if (!href.startsWith(UNSAFELINK_PREFIX)) {
    return null;
  }

  return normalizeUrl(href.slice(UNSAFELINK_PREFIX.length));
}

/**
 * 가격 셀을 파싱한다. exchange 요소(data-currency/data-value)가
 * 있으면 사이트가 생성한 정형 값이라 우선 채택하고, 없으면
 * 텍스트에서 통화기호/단위어로 판정한다.
 * 아무 신호가 없으면 통화를 null로 둔다.
 */
function parsePriceCell(td: cheerio.Cheerio<any>): {
  value: number | null;
  currency: ArcaProduct["currency"];
} {
  const exchange = td.find("exchange").first();

  if (exchange.length > 0) {
    const value = parseNumberToken(exchange.attr("data-value"));
    const code = (exchange.attr("data-currency") ?? "").trim();

    let currency: ArcaProduct["currency"] = null;

    /*
     * parser-native product 통화 유니온 밖의 코드(예: GBP)는
     * 통화 미확정(null)으로 둔다. 원문은 priceText에 보존된다.
     */
    if (
      code === "KRW" ||
      code === "USD" ||
      code === "JPY" ||
      code === "CNY" ||
      code === "EUR"
    ) {
      currency = code;
    }

    if (value !== null) {
      return { value, currency };
    }
  }

  return parsePriceText(valueText(td));
}

function parsePriceText(text: string): {
  value: number | null;
  currency: ArcaProduct["currency"];
} {
  const working = text.trim();

  const numberMatch = working.match(/([\d,]+(?:\.\d+)?)/);

  if (!numberMatch?.[1]) {
    return { value: null, currency: null };
  }

  const value = Number(numberMatch[1].replace(/,/g, ""));

  if (Number.isNaN(value)) {
    return { value: null, currency: null };
  }

  let currency: ArcaProduct["currency"] = null;

  if (/[￦₩]/.test(working) || /원\s*$/.test(working)) {
    currency = "KRW";
  } else if (/[$]/.test(working) || /달러\s*$/.test(working)) {
    currency = "USD";
  } else if (/[€]/.test(working) || /유로\s*$/.test(working)) {
    currency = "EUR";
  } else if (/(엔|円)\s*$/.test(working)) {
    currency = "JPY";
  }

  return { value, currency };
}

/**
 * 배송비 셀을 파싱한다. exchange 요소의 data-value(수치)가
 * 있으면 우선하고, 없으면 텍스트 판정.
 * "직배", "착불" 등 수치화 불가 → null (원문은 shippingText에 보존)
 */
function parseShippingCell(
  td: cheerio.Cheerio<any>,
  text: string,
): number | null {
  const exchange = td.find("exchange").first();

  if (exchange.length > 0) {
    const value = parseNumberToken(exchange.attr("data-value"));

    if (value !== null && value >= 0) {
      return value;
    }
  }

  const compact = text.replace(/\s+/g, "");

  if (/무료배송|배송비무료|무료|무배/.test(compact)) {
    return 0;
  }

  const match = compact.match(/^([\d,]+(?:\.\d+)?)원?$/);

  if (match?.[1]) {
    const value = Number(match[1].replace(/,/g, ""));

    if (!Number.isNaN(value)) {
      return value;
    }
  }

  return null;
}

function parseNumberToken(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const number = Number(value.replace(/,/g, ""));

  return Number.isNaN(number) ? null : number;
}

/* =========================================================
 * Body
 * ======================================================= */

function extractBodyHtml($: cheerio.CheerioAPI): string {
  /* fr-view 본문은 서버 렌더링이며 댓글을 포함하지 않는다. */
  return $("div.fr-view.article-content").first().html() ?? "";
}

/**
 * 블록 요소 경계를 줄바꿈으로 바꿔 본문 텍스트를 추출한다.
 * (cheerio .text()만 쓰면 <p>/<br> 경계가 붙어버려
 * 줄 단위 쿠폰 추출이 깨진다. 다른 파서와 동일 방식)
 */
function textWithBlockNewlines(
  el: cheerio.Cheerio<any>,
): string {
  if (el.length === 0) {
    return "";
  }

  const html = el.html() ?? "";

  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|li|tr|h[1-6])>/gi,
      "\n</$1>",
    );

  const fragment = cheerio.load(withBreaks);

  return fragment.root().text();
}

function collectBodyLinks(
  body: cheerio.CheerioAPI,
  sourcePostId: string,
): {
  bodyLinks: ArcaDeal["sourceMeta"]["bodyLinks"];
  internalLinks: ArcaDeal["sourceMeta"]["internalLinks"];
} {
  const bodyLinks: ArcaDeal["sourceMeta"]["bodyLinks"] = [];
  const internalLinks: ArcaDeal["sourceMeta"]["internalLinks"] = [];
  const seen = new Set<string>();

  body("a[href]").each((_, element) => {
    const href = body(element).attr("href") ?? "";
    const text = cleanText(body(element).text());

    /*
     * 내부 게시글 링크: 절대 URL(arca.live/b/<board>/<id>)과
     * 상대 URL(/b/<board>/<id>) 모두. 자기 글/댓글 앵커는 제외.
     */
    const internal = matchArcaPostLink(href);

    if (internal !== null) {
      if (internal.postId !== sourcePostId) {
        const key = internal.url;

        if (!seen.has(key)) {
          seen.add(key);

          internalLinks.push({
            rawUrl: href,
            url: internal.url,
            text: text.slice(0, 200),
          });
        }
      }

      return;
    }

    const rawUrl = normalizeUrl(href);
    const resolved = unwrapUnsafelink(href) ?? rawUrl;

    if (!resolved && !rawUrl) {
      return;
    }

    const key = resolved ?? rawUrl ?? "";

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    bodyLinks.push({ raw: rawUrl, resolved });
  });

  return { bodyLinks, internalLinks };
}

/**
 * 아카라이브 게시글 링크를 식별한다.
 * (절대/상대 URL + fragment/query 제거. 댓글 앵커는 같은 글 id라
 * postId 비교에서 자연스럽게 제외된다.)
 */
function matchArcaPostLink(
  href: string,
): { url: string; postId: string } | null {
  const match = href.match(
    /^(?:https?:\/\/arca\.live)?\/b\/([^/?#]+)\/(\d+)/,
  );

  if (!match) {
    return null;
  }

  return {
    url: `https://arca.live/b/${match[1]}/${match[2]}`,
    postId: match[2],
  };
}

/* =========================================================
 * URL type / affiliate
 * ======================================================= */

function detectUrlType(
  url: string | null,
  rawUrl: string | null,
): ArcaProduct["urlType"] {
  if (!url && !rawUrl) {
    return "none";
  }

  const value = `${rawUrl ?? ""} ${url ?? ""}`.toLowerCase();

  if (value.startsWith("javascript:")) {
    return "javascript";
  }

  if (
    value.includes("toss.shopping") ||
    value.includes("toss.me")
  ) {
    return "app";
  }

  /*
   * unsafelink 래핑이 풀렸다면(raw ≠ resolved) 아카라이브의
   * 외부 링크 게이트웨이를 거치는 리다이렉트다. 제휴 여부는
   * detectAffiliate가 별도로 판단한다.
   * (bi-info 커미션 툴팁은 사이트 템플릿이라 게시글 단위 신호가 아님)
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

function detectAffiliate(bodyText: string): boolean {
  /*
   * 링크 행 bi-info 툴팁("제휴 링크로 전환될 수 있으며...")은 모든
   * 글에 붙는 사이트 템플릿이라 게시글 단위 제휴 신호로 쓰지 않는다.
   * 본문에 제휴 활동 공시 문구가 있는 경우만 감지한다.
   * (다른 파서와 기준 동일)
   */
  return (
    /쇼핑커넥트/.test(bodyText) ||
    /파트너스\s*활동/.test(bodyText) ||
    /수수료를?\s*제공\s*받/.test(bodyText)
  );
}

/* =========================================================
 * IDs
 * ======================================================= */

function extractPostId(sourceUrl: string): string {
  const match = sourceUrl.match(/\/b\/[^/]+\/(\d+)/);

  return match?.[1] ?? "unknown";
}

function extractBoardId(sourceUrl: string): string | null {
  const match = sourceUrl.match(/\/b\/([^/]+)\/\d+/);

  return match?.[1] ?? null;
}

/* =========================================================
 * Stats
 * ======================================================= */

function extractStats($: cheerio.CheerioAPI): ArcaDeal["stats"] {
  const stats: ArcaDeal["stats"] = {
    views: null,
    recommendations: null,
    comments: null,
  };

  /*
   * Like/Dislike/Comment/Views는 article-info-section의
   * span.head + 다음 형제 span.body 쌍이다. 본문/댓글 영역에도
   * 숫자가 많아 이 섹션으로 범위를 한정한다.
   *
   * 라벨은 언어에 따라 다르다 — 브라우저 캡처(영어 UI)는
   * "Views"/"Like"/"Comment", 크롤러 수신(ko Accept-Language)은
   * "조회수"/"추천"/"댓글". 둘 다 허용. ("비추천"은 추천과
   * 다른 문자열이라 매칭되지 않아 자연스럽게 무시된다.)
   */
  const section = $(
    "div.article-info.article-info-section",
  ).first();

  section.find("span.head").each((_, head) => {
    const label = cleanText($(head).text()).toLowerCase();
    const bodyText = cleanText(
      $(head).next("span.body").text(),
    );

    if (label === "views" || label === "조회수") {
      stats.views = extractStat(bodyText);
    } else if (label === "like" || label === "추천") {
      stats.recommendations = extractStat(bodyText);
    } else if (label === "comment" || label === "댓글") {
      stats.comments = extractStat(bodyText);
    }
  });

  return stats;
}

function extractStat(text: string): number | null {
  const match = text.match(/^([\d,]+)$/);

  if (!match?.[1]) {
    return null;
  }

  const value = Number(match[1].replace(/,/g, ""));

  return Number.isNaN(value) ? null : value;
}

/* =========================================================
 * Status
 * ======================================================= */

function extractStatus(
  statusLabel: string | null,
  title: string,
  bodyText: string,
): ArcaDeal["status"] {
  /*
   * 1차: DOM 상태 신호. 아카라이브는 종료 글에 close-deal
   * 클래스, 진행 글에 LIVE 버블을 붙인다. 키워드 오분류가
   * 끼어들 여지가 없는 가장 신뢰 높은 신호다.
   */
  if (statusLabel === "close-deal") {
    return "ended";
  }

  if (statusLabel === "LIVE") {
    return "active";
  }

  /*
   * 2차(폴백): 신호가 없는 페이지를 위한 키워드 판정.
   * 조건부/서술 표현("품절시 종료", "품절만 뜨던")은
   * 공통 가드로 제거 후 판정한다. (src/parsers/status.ts)
   */
  const combined = stripFalseEndedSignals(
    `${title} ${bodyText}`,
  );

  if (/종료|품절|끝났|마감|판매\s*종료|딜\s*종료/.test(combined)) {
    return "ended";
  }

  if (/진행\s*중|판매\s*중|구매\s*가능/.test(combined)) {
    return "active";
  }

  return "unknown";
}

/* =========================================================
 * Discount
 * ======================================================= */

function extractDiscount(bodyText: string): ArcaDeal["discount"] {
  if (!bodyText) {
    return { type: [], codes: [], description: "" };
  }

  const codes = extractDiscountCodes(bodyText);

  const type: string[] = [];

  const keywordMap: Array<[RegExp, string]> = [
    [/스토어\s*쿠폰/i, "스토어쿠폰"],
    [/상품\s*쿠폰/i, "상품쿠폰"],
    [/프로모션\s*쿠폰/i, "프로모션쿠폰"],
    [/카드\s*(할인|청구)/i, "카드할인"],
    [/토스\s*페이/i, "토스페이"],
    [/카카오\s*페이/i, "카카오페이"],
    [/네이버\s*페이/i, "네이버페이"],
    [/멤버십/i, "멤버십"],
    [/적립/i, "적립"],
    [/할인\s*코드/i, "할인코드"],
    [/쿠폰/i, "쿠폰"],
    [/결제\s*할인/i, "결제할인"],
  ];

  for (const [regex, label] of keywordMap) {
    if (regex.test(bodyText)) {
      type.push(label);
    }
  }

  const discountLines = bodyText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /쿠폰|할인|적립|페이|코드|코인/i.test(line));

  return {
    type: Array.from(new Set(type)),
    codes,
    description: discountLines.join(" / ").slice(0, 500),
  };
}

/**
 * 할인 코드를 추출한다. (ruliweb.ts/quasarzone.ts와 동일 방식)
 * 마커(할인코드/쿠폰코드/쿠폰/코드) 이후, 콤마/공백으로만
 * 이어진 대문자 영숫자 토큰 묶음을 끝까지 수집한다.
 */
function extractDiscountCodes(text: string): string[] {
  const codes = new Set<string>();

  const marker = /(할인\s*코드|쿠폰\s*코드|쿠폰|코드)\s*[:：]?\s*/gi;

  for (const line of text.split("\n")) {
    for (const match of line.matchAll(marker)) {
      const tail = line.slice((match.index ?? 0) + match[0].length);

      const cluster = tail.match(
        /^[A-Z0-9][A-Z0-9_-]{3,29}(?:[\s,]+[A-Z0-9][A-Z0-9_-]{3,29})*/,
      );

      if (!cluster) {
        continue;
      }

      for (const code of cluster[0].split(/[\s,]+/)) {
        if (code) {
          codes.add(code);
        }
      }
    }
  }

  return Array.from(codes);
}

/* =========================================================
 * URL / text helpers
 * ======================================================= */

function normalizeUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }

  let url = value.trim();

  if (url.startsWith("//")) {
    url = `https:${url}`;
  }

  if (!/^https?:\/\//i.test(url)) {
    return null;
  }

  return url;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanTextWithNewlines(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, lines) => {
      if (line) {
        return true;
      }

      /* 연속 빈 줄은 하나로 축소. */
      return index > 0 && lines[index - 1].trim() !== "";
    })
    .join("\n");
}
