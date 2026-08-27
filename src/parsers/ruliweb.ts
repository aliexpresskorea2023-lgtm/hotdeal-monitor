import * as cheerio from "cheerio";
import { stripFalseEndedSignals } from "./status";

export type RuliwebProduct = {
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
  /** web.ruliweb.com/link.php 로 감싸진 원본(래핑) URL. 직접 링크면 null. */
  rawUrl: string | null;
};

export type RuliwebDeal = {
  id: string;
  source: "ruliweb";
  sourcePostId: string;
  sourceUrl: string;
  /** bbs.ruliweb.com/community/board/<num> 의 board 번호 (예: 1020) */
  boardId: string | null;
  title: string;
  category: string | null;
  /** ISO 8601 (+09:00) 또는 null */
  postedAt: string | null;

  products: RuliwebProduct[];

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
    /** 본문에서 수집한 외부 링크 (원본+복원). 추적용. */
    bodyLinks: Array<{
      raw: string | null;
      resolved: string | null;
    }>;
    /**
     * 본문에 포함된 루리웹 내부 게시글 링크 (모음글, 과거 딜 참조 등).
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

type TitleInfo = {
  store: string | null;
  name: string | null;
  price: number | null;
  currency: RuliwebProduct["currency"];
  priceText: string | null;
  shipping: number | null;
  shippingText: string | null;
};

/**
 * 루리웹(ruliweb.com) 핫딜 게시글 parser
 *
 * 대상: bbs.ruliweb.com/community/board/1020/read/<id>
 * (핫딜/예판 유저게시판. 게시판 필터는 크롤러의 역할이다.)
 *
 * 핵심 원칙 (fmkorea.ts / ppomppu.ts와 동일)
 *
 * 1. 원본 유지 — link.php 래핑 URL과 복원 URL을 분리 보존
 * 2. HTML에서 확인되는 값만 정규화
 * 3. 상품명을 임의로 생성하지 않음 (추출 실패 시 null)
 * 4. 상품 페이지를 여기서 fetch하지 않음
 * 5. 본문에서 상품 단위 구조가 확인되지 않으면 분리하지 않음
 *
 * 루리웹 마크업 특징 (2026-08 실제 페이지 기준)
 *
 * - 제목:        span.subject_inner_text
 *   게시판 규약상 "[쇼핑몰] 상품명 (가격/배송)" 형태.
 *   가격/배송 표기가 괄호 병기 "(46,500원/무료)" 와
 *   슬래시 나열 "/ 10,000원 / 무배" 두 가지로 혼용된다.
 * - 카테고리:    span.category_text ("[상품권]" → "상품권")
 * - 게시글 id:   input.article_id
 * - 대표 URL:    div.source_url 의 "출처 : <a>" — 작성자가
 *   입력한 상품 링크. 외부 링크는 web.ruliweb.com/link.php?ol=...
 *   로 감싸져 있으며 ol 파라미터를 URL 디코딩하면 실제 URL이다.
 *   (링크 수 집계용 자체 게이트웨이로, 제휴 신호는 아님)
 * - 본문:        div.view_content article (itemprop=articleBody)
 * - 등록일:      span.regdate ("2026.08.26 (11:04:13)")
 * - 조회수/추천: .user_view_target 안 span.hit / span.recomd
 * - 댓글수:      input#reply_count
 *
 * fmkorea/뽐뿌와 달리 게시글 폼(hotdeal_table)이 없다.
 * 제목 규약 + 출처 링크가 폼을 대체하므로, 이 둘에서 상품
 * 정보를 추출하고 둘 다 없는 글(공지 등)은 products: []로
 * 안전 실패한다. 1글 = 1딜 규약이므로 본문에서 복수 상품
 * 구조가 확인되지 않는 한 products는 최대 1개다.
 */
export function parseRuliwebHtml(
  html: string,
  options?: {
    sourceUrl?: string;
    collectedAt?: string;
  },
): RuliwebDeal {
  const $ = cheerio.load(html);

  const sourceUrl =
    normalizeUrl(
      options?.sourceUrl ??
        $('input.article_url').val()?.toString() ??
        $('link[rel="canonical"]').attr("href") ??
        "",
    ) ?? "";

  const sourcePostId = extractPostId(sourceUrl, $);
  const boardId = extractBoardId(sourceUrl, $);

  const title = extractTitle($);
  const category = extractCategory($);
  const postedAt = extractPostedAt($);

  const titleInfo = parseTitle(title);

  const sourceLink = extractSourceLink($);
  const body = findArticleBody($);
  const bodyText = cleanTextWithNewlines(
    textWithBlockNewlines(body),
  );

  const { bodyLinks, internalLinks } = collectBodyLinks(
    $,
    body,
    sourcePostId,
  );

  /*
   * 상품 링크는 출처 필드가 우선이다. 작성자가 출처를 남기지
   * 않은 글은 본문 외부 링크가 유일한 구매 경로인 경우가 많다
   * (이미지/내부 게시글 링크는 collectBodyLinks에서 이미 제외).
   * 다만 링크가 2개 이상이면 어느 것이 상품 링크인지 단정할 수
   * 없어 null로 둔다 — 잘못된 링크를 보여주는 것보다 없는 편이
   * 낫다. (원본 유지 원칙: 임의 선택 금지)
   */
  let productLink: {
    rawUrl: string | null;
    resolved: string | null;
  } = sourceLink;

  if (productLink.resolved === null && bodyLinks.length === 1) {
    productLink = {
      rawUrl: bodyLinks[0].raw,
      resolved: bodyLinks[0].resolved,
    };
  }

  const products: RuliwebProduct[] = [];

  /*
   * 제목에 [쇼핑몰] 태그가 있거나, 가격 파싱에 성공했거나,
   * 출처 링크가 있을 때만 딜로 취급한다. 공지글 등 셋 다
   * 없는 글은 products: [] → 크롤러가 스킵한다.
   * (fmkorea의 "폼 미입력 글 스킵" 정책과 동일한 안전 장치)
   */
  const hasDealSignal =
    titleInfo.store !== null ||
    titleInfo.price !== null ||
    sourceLink.resolved !== null;

  if (hasDealSignal) {
    products.push({
      name: titleInfo.name,
      price: titleInfo.price,
      currency: titleInfo.currency,
      priceText: titleInfo.priceText,
      shipping: titleInfo.shipping,
      shippingText: titleInfo.shippingText,
      store: titleInfo.store,
      url: productLink.resolved,
      urlType: detectUrlType(
        productLink.resolved,
        productLink.rawUrl,
      ),
      rawUrl: productLink.rawUrl,
    });
  }

  const stats = extractStats($);
  const discount = extractDiscount(bodyText);
  const status = extractStatus(title, bodyText);

  const affiliate = detectAffiliate(bodyText);

  return {
    id: `ruliweb-${sourcePostId}`,
    source: "ruliweb",
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
      rawUrl: sourceLink.rawUrl,
      rawPrice: titleInfo.priceText,
      rawShipping: titleInfo.shippingText,
      bodyLinks,
      internalLinks,
    },

    collectedAt:
      options?.collectedAt ?? new Date().toISOString(),
  };
}

/* =========================================================
 * Title / category / date
 * ======================================================= */

function extractTitle($: cheerio.CheerioAPI): string {
  const value = cleanText(
    $("span.subject_inner_text").first().text(),
  );

  if (value) {
    return value;
  }

  return cleanText(
    $('h4.subject span[itemprop="headline"]').first().text(),
  );
}

function extractCategory($: cheerio.CheerioAPI): string | null {
  const value = cleanText(
    $("span.category_text").first().text(),
  );

  if (!value) {
    return null;
  }

  const unwrapped = value.replace(/^\[|\]$/g, "").trim();

  return unwrapped || null;
}

function extractPostedAt($: cheerio.CheerioAPI): string | null {
  const value = cleanText($(".regdate").first().text());

  const match = value.match(
    /^(\d{4})\.(\d{2})\.(\d{2})\.?\s*\(?(\d{1,2}):(\d{2})(?::(\d{2}))?/,
  );

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;

  const time = [
    hour.padStart(2, "0"),
    minute,
    second ?? "00",
  ].join(":");

  return `${year}-${month}-${day}T${time}+09:00`;
}

/* =========================================================
 * Title convention
 *
 * "[쇼핑몰] 상품명 (가격/배송)" 규약을 파싱한다.
 * 실측 변형:
 *   (46,500원/무료)        — 괄호 병기
 *   (44,000/2500)          — 단위 생략
 *   / 10,000원 / 무배      — 슬래시 나열
 *   / ￦63,840              — 통화기호
 *   / 9,191 엔              — 외화
 *   1.75만                 — 만 단위 약어 (제목尾部)
 * ======================================================= */

function parseTitle(title: string): TitleInfo {
  const info: TitleInfo = {
    store: null,
    name: null,
    price: null,
    currency: null,
    priceText: null,
    shipping: null,
    shippingText: null,
  };

  let working = cleanText(title);

  const storeMatch = working.match(/^\[([^\]]+)\]\s*/);

  if (storeMatch?.[1]) {
    info.store = storeMatch[1].trim() || null;
    working = working.slice(storeMatch[0].length);
  }

  working = consumeParenGroups(working, info);
  working = consumeSlashSegments(working, info);
  working = consumeTrailingMan(working, info);

  const name = working
    .trim()
    .replace(/^[\s/·\-]+/, "")
    .replace(/[\s/·\-]+$/, "")
    .trim();

  info.name = name || null;

  return info;
}

/**
 * 괄호 그룹을 스캔한다. 그룹 전체가 가격/배송 토큰으로
 * 설명될 때만 소비하고, 아니면 그대로 둔다.
 * 예: (46,500원/무료) → 소비, (390일분) → 보존.
 * 중첩 괄호는 깊이 추적으로 처리한다.
 */
function consumeParenGroups(text: string, info: TitleInfo): string {
  let out = "";
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "(") {
      out += text[i];
      i += 1;
      continue;
    }

    let depth = 0;
    let j = i;

    for (; j < text.length; j += 1) {
      if (text[j] === "(") {
        depth += 1;
      } else if (text[j] === ")") {
        depth -= 1;

        if (depth === 0) {
          break;
        }
      }
    }

    if (depth !== 0) {
      /* 닫히지 않은 괄호: 나머지 전체를 보존. */
      out += text.slice(i);
      break;
    }

    const inner = text.slice(i + 1, j);

    if (tryConsumeParenGroup(inner, info)) {
      /* 소비된 그룹은 이름에서 제거. */
    } else {
      out += text.slice(i, j + 1);
    }

    i = j + 1;
  }

  return out;
}

function tryConsumeParenGroup(inner: string, info: TitleInfo): boolean {
  const segments = inner
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return false;
  }

  let price: { value: number; currency: RuliwebProduct["currency"]; text: string } | null =
    null;
  let shipping: { value: number; text: string } | null = null;

  for (const segment of segments) {
    if (price === null) {
      const parsed = parsePriceToken(segment, true);

      if (parsed.price !== null) {
        price = {
          value: parsed.price,
          currency: parsed.currency,
          text: segment,
        };
        continue;
      }
    }

    const parsedShipping = parseShippingToken(segment);

    if (parsedShipping !== null && shipping === null) {
      shipping = { value: parsedShipping, text: segment };
      continue;
    }

    /* 해석 불가 세그먼트가 있으면 그룹 전체를 보존. */
    return false;
  }

  if (price === null && shipping === null) {
    return false;
  }

  if (price !== null && info.price === null) {
    info.price = price.value;
    info.currency = price.currency;
    info.priceText = price.text;
  }

  if (shipping !== null && info.shipping === null) {
    info.shipping = shipping.value;
    info.shippingText = shipping.text;
  }

  return true;
}

/**
 * 괄호 바깥의 슬래시 세그먼트를 스캔한다.
 * "/ 10,000원 / 무배" 같은 나열형 표기용.
 * 괄호 안의 슬래시(날짜 등)는 건드리지 않는다.
 * 괄호 밖은 모델명 숫자 오인 위험이 있어 단위가 있는
 * 토큰만 가격으로 채택한다.
 */
function consumeSlashSegments(text: string, info: TitleInfo): string {
  if (!text.includes("/")) {
    return text;
  }

  const segments: string[] = [];
  let current = "";
  let depth = 0;

  for (const char of text) {
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    }

    if (char === "/" && depth === 0) {
      segments.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  segments.push(current);

  /* 슬래시가 의미 있게 쓰인 경우만 (세그먼트 2개 이상). */
  if (segments.length < 2) {
    return text;
  }

  const kept: string[] = [];

  for (const rawSegment of segments) {
    const segment = rawSegment.trim();

    if (!segment) {
      continue;
    }

    if (info.price === null) {
      const parsed = parsePriceToken(segment, false);

      if (parsed.price !== null) {
        info.price = parsed.price;
        info.currency = parsed.currency;
        info.priceText = segment;
        continue;
      }
    }

    if (info.shipping === null) {
      const parsedShipping = parseShippingToken(segment);

      if (parsedShipping !== null) {
        info.shipping = parsedShipping;
        info.shippingText = segment;
        continue;
      }
    }

    kept.push(rawSegment);
  }

  return kept.join(" / ");
}

/**
 * 제목 끝의 "1.75만" 같은 만 단위 약어를 소비한다.
 * 숫자 앞에 공백이 있어야 하고("5만상품권" 같은 상품명
 * 오인 방지), 만/만원이 토큰의 마지막이어야 한다.
 */
function consumeTrailingMan(text: string, info: TitleInfo): string {
  if (info.price !== null) {
    return text;
  }

  const match = text.match(
    /^(.*\s)(\d+(?:\.\d+)?)\s*만(?:원)?\s*$/,
  );

  if (!match) {
    return text;
  }

  const value = Number(match[2]) * 10000;

  if (Number.isNaN(value)) {
    return text;
  }

  info.price = value;
  info.currency = "KRW";
  info.priceText = `${match[2]}만`;

  return match[1];
}

/**
 * 세그먼트 하나가 가격 토큰인지 판정한다.
 *
 * allowBareNumber: 괄호 안처럼 맥락이 명확한 곳에서만
 * 단위 없는 순수 숫자("44,000")를 가격으로 인정한다.
 */
function parsePriceToken(
  segment: string,
  allowBareNumber: boolean,
): { price: number | null; currency: RuliwebProduct["currency"] } {
  const text = segment.trim();

  if (!text) {
    return { price: null, currency: null };
  }

  const patterns: Array<{
    regex: RegExp;
    currency: RuliwebProduct["currency"];
    multiplier?: number;
  }> = [
    { regex: /^[$]\s*([\d,]+(?:\.\d+)?)$/, currency: "USD" },
    { regex: /^[€]\s*([\d,]+(?:\.\d+)?)$/, currency: "EUR" },
    { regex: /^[￦₩]\s*([\d,]+(?:\.\d+)?)$/, currency: "KRW" },
    { regex: /^([\d,]+(?:\.\d+)?)\s*원$/, currency: "KRW" },
    { regex: /^([\d,]+(?:\.\d+)?)\s*만원$/, currency: "KRW", multiplier: 10000 },
    { regex: /^([\d,]+(?:\.\d+)?)\s*만$/, currency: "KRW", multiplier: 10000 },
    { regex: /^([\d,]+(?:\.\d+)?)\s*(?:엔|円)$/, currency: "JPY" },
    { regex: /^([\d,]+(?:\.\d+)?)\s*달러$/, currency: "USD" },
  ];

  if (allowBareNumber) {
    patterns.push({
      regex: /^([\d,]+(?:\.\d+)?)$/,
      currency: "KRW",
    });
  }

  for (const { regex, currency, multiplier } of patterns) {
    const match = text.match(regex);

    if (!match?.[1]) {
      continue;
    }

    const value = Number(match[1].replace(/,/g, ""));

    if (Number.isNaN(value)) {
      continue;
    }

    return {
      price: value * (multiplier ?? 1),
      currency,
    };
  }

  return { price: null, currency: null };
}

function parseShippingToken(segment: string): number | null {
  const text = segment.replace(/\s+/g, "");

  if (!text) {
    return null;
  }

  if (/무료배송|배송비무료|무료|무배/.test(text)) {
    return 0;
  }

  const match = text.match(/^([\d,]+(?:\.\d+)?)원?$/);

  if (match?.[1]) {
    const value = Number(match[1].replace(/,/g, ""));

    if (!Number.isNaN(value)) {
      return value;
    }
  }

  return null;
}

/* =========================================================
 * Source link ("출처")
 * ======================================================= */

function extractSourceLink($: cheerio.CheerioAPI): {
  rawUrl: string | null;
  resolved: string | null;
} {
  const anchor = $("div.source_url a").first();

  if (anchor.length === 0) {
    return { rawUrl: null, resolved: null };
  }

  const rawUrl = normalizeUrl(anchor.attr("href") ?? null);

  return {
    rawUrl,
    resolved: unwrapRuliwebLink(rawUrl),
  };
}

/**
 * web.ruliweb.com/link.php?ol=<encoded> 래핑을 푼다.
 * 루리웹은 모든 외부 링크를 이 게이트웨이로 감싼다.
 * (링크 수 집계용이며 제휴 링크라는 신호는 아님)
 */
function unwrapRuliwebLink(url: string | null): string | null {
  const normalized = normalizeUrl(url);

  if (!normalized) {
    return null;
  }

  try {
    const parsed = new URL(normalized);

    const isRuliwebGate =
      parsed.hostname.endsWith("ruliweb.com") &&
      parsed.pathname === "/link.php";

    if (!isRuliwebGate) {
      return normalized;
    }

    const target = parsed.searchParams.get("ol");

    if (!target) {
      return normalized;
    }

    try {
      const decoded = decodeURIComponent(target);
      const inner = normalizeUrl(decoded);

      return inner ?? normalized;
    } catch {
      return normalized;
    }
  } catch {
    return normalized;
  }
}

/* =========================================================
 * Body links
 * ======================================================= */

function findArticleBody($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  const article = $("div.view_content article").first();

  if (article.length > 0) {
    return article;
  }

  return $("div.view_content").first();
}

/**
 * 블록 요소 경계를 줄바꿈으로 바꿔 본문 텍스트를 추출한다.
 * (cheerio .text()만 쓰면 <p>/<br> 경계가 붙어버려
 * 줄 단위 쿠폰 추출이 깨진다. fmkorea.ts와 동일 방식)
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
  $: cheerio.CheerioAPI,
  body: cheerio.Cheerio<any>,
  sourcePostId: string,
): {
  bodyLinks: RuliwebDeal["sourceMeta"]["bodyLinks"];
  internalLinks: RuliwebDeal["sourceMeta"]["internalLinks"];
} {
  const bodyLinks: RuliwebDeal["sourceMeta"]["bodyLinks"] = [];
  const internalLinks: RuliwebDeal["sourceMeta"]["internalLinks"] = [];
  const seen = new Set<string>();

  if (body.length === 0) {
    return { bodyLinks, internalLinks };
  }

  body.find("a[href]").each((_, element) => {
    const href = $(element).attr("href") ?? null;
    const raw = normalizeUrl(href);

    if (!raw) {
      return;
    }

    try {
      const parsed = new URL(raw);
      const hostname = parsed.hostname.toLowerCase();

      /* 본문 이미지 링크는 상품 링크가 아니다. */
      if (/^i\d*\.ruliweb\.com$/.test(hostname)) {
        return;
      }
    } catch {
      return;
    }

    const resolved = unwrapRuliwebLink(raw);

    if (!resolved) {
      return;
    }

    const key = resolved;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    /* 루리웹 내부 게시글 링크 → 모음글 참조 등. */
    if (isRuliwebPostLink(resolved)) {
      const postId = resolved.match(/\/read\/(\d+)/)?.[1];

      if (postId && postId !== sourcePostId) {
        internalLinks.push({
          rawUrl: raw,
          url: resolved,
          text: cleanText($(element).text()).slice(0, 200),
        });
      }

      return;
    }

    bodyLinks.push({ raw, resolved });
  });

  return { bodyLinks, internalLinks };
}

function isRuliwebPostLink(url: string): boolean {
  try {
    const parsed = new URL(url);

    return (
      parsed.hostname.endsWith("ruliweb.com") &&
      /\/read\/\d+/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/* =========================================================
 * URL type / affiliate
 * ======================================================= */

function detectUrlType(
  url: string | null,
  rawUrl: string | null,
): RuliwebProduct["urlType"] {
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
   * link.php 래핑이 풀렸다면(raw ≠ resolved) 루리웹 서버를
   * 거치는 리다이렉트다. 제휴 여부는 detectAffiliate가 별도로
   * 판단한다. (link.php 자체는 제휴 신호가 아님)
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
   * 루리웹 마크업에는 제휴 표시가 없다.
   * 본문에 제휴 활동 공시 문구가 있는 경우만 감지한다.
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

function extractPostId(
  sourceUrl: string,
  $: cheerio.CheerioAPI,
): string {
  const inputId = $('input.article_id').val()?.toString();

  if (inputId && /^\d+$/.test(inputId)) {
    return inputId;
  }

  const urlMatch = sourceUrl.match(/\/read\/(\d+)/);

  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  return "unknown";
}

function extractBoardId(
  sourceUrl: string,
  $: cheerio.CheerioAPI,
): string | null {
  const bbsUrl = $('input.bbs_url').val()?.toString() ?? sourceUrl;

  const match = bbsUrl.match(/\/board\/(\d+)/);

  return match?.[1] ?? null;
}

/* =========================================================
 * Stats
 * ======================================================= */

function extractStats($: cheerio.CheerioAPI): RuliwebDeal["stats"] {
  /*
   * 조회/추천 카운터는 div.user_view 안 .info(작성자 프로필
   * 블록)에 있다. 댓글 영역에도 .info가 있을 수 있어
   * .user_view로 범위를 좁힌다.
   */
  return {
    views: extractStat(
      $(".user_view .info .hit strong").first().text(),
    ),
    recommendations: extractStat(
      $(".user_view .info .recomd strong").first().text(),
    ),
    comments: extractStat($("input#reply_count").val()?.toString() ?? ""),
  };
}

function extractStat(text: string): number | null {
  const match = cleanText(text).match(/^([\d,]+)$/);

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
  title: string,
  bodyText: string,
): RuliwebDeal["status"] {
  /*
   * 댓글/사이드바가 아닌 제목+본문만 스캔한다.
   * 조건부/서술 표현("품절시 종료처리하겠습니다",
   * "품절만 뜨던 ○○이 재입고")은 종료 신호가 아니므로
   * 공통 헬퍼로 제거 후 키워드 판정한다. (src/parsers/status.ts)
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

function extractDiscount(bodyText: string): RuliwebDeal["discount"] {
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
 * 할인 코드를 추출한다.
 *
 * 루리웹 프로모션 글은 한 마커 뒤에 여러 코드가 오는 형태가
 * 일반적이다:
 *   "21달러 이상 구매 시, 3달러 할인코드 : LIEW03 , PLOK03 , KFSL03"
 *
 * 마커(할인코드/쿠폰코드/쿠폰/코드) 이후, 콤마/공백으로만
 * 이어진 대문자 영숫자 토큰 묶음을 끝까지 수집한다.
 * 토큰을 대문자 영숫자로 제한해 한국어 문장이 걸리지 않게 한다.
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
