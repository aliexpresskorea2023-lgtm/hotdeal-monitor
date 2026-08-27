import * as cheerio from "cheerio";
import { stripFalseEndedSignals } from "./status";

export type PpomppuProduct = {
  name: string | null;
  price: number | null;
  currency: "KRW" | "USD" | "JPY" | "CNY" | "EUR" | null;
  priceText: string | null;
  /** 유형 D: 옵션별 최저가~최고가. price와 동시에 쓰지 않는다. */
  priceRange: { min: number; max: number } | null;
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
  /** s.ppomppu.co.kr 로 감싸진 원본(래핑) URL. resolved와 분리해서 보존. */
  rawUrl: string | null;
};

export type PpomppuDeal = {
  id: string;
  source: "ppomppu";
  sourcePostId: string;
  sourceUrl: string;
  /** view.php?id= 의 그 board id (예: pmarket). 쇼핑포럼(social) 제외 판단용. */
  boardId: string | null;
  title: string;
  category: string | null;
  author: string | null;
  /** td.board-contents 에 partner-contents 클래스가 있는 파트너 계정 글. */
  isPartnerPost: boolean;
  /** ISO 8601 (+09:00) 또는 null */
  postedAt: string | null;

  products: PpomppuProduct[];

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
    /** 본문/topTitle 에서 수집한 전체 외부 링크 (원본+복원). 추적용. */
    links: Array<{
      raw: string | null;
      resolved: string | null;
    }>;
  };

  collectedAt: string;
};

type BlockLine = {
  text: string;
  links: Array<{ raw: string | null; resolved: string | null }>;
};

type ParsedPrice = {
  price: number | null;
  currency: PpomppuProduct["currency"];
  priceText: string | null;
  range: { min: number; max: number } | null;
};

/**
 * 뽐뿌(ppomppu.co.kr) 핫딜 게시글 parser
 *
 * 대상: /zboard/view.php?id=...&no=... 형태의 게시글 페이지.
 * (쇼핑포럼 id=social 등 수집 제외 게시판 필터는 크롤러의 역할이다.)
 *
 * 인코딩 주의:
 *   뽐뿌는 EUC-KR 페이지다. 크롤러가 버퍼를 EUC-KR로 디코딩한 뒤
 *   UTF-8 문자열을 이 파서에 넘긴다고 가정한다.
 *
 * 핵심 원칙 (fmkorea.ts와 동일)
 *
 * 1. 원본 유지 — rawUrl(래핑 URL)과 resolved URL을 분리 보존
 * 2. HTML에서 확인되는 값만 정규화
 * 3. 상품명을 임의로 생성하지 않음 (추출 실패 시 null)
 * 4. 상품 페이지를 여기서 fetch하지 않음
 * 5. 여러 상품 글은 본문에 상품 단위 구조가 실제로 확인될 때만 분리
 *
 * 뽐뿌 마크업 특징 (2026-08 실제 페이지 기준)
 *
 * - 제목:        #topTitle h1
 * - 작성자/등록일/조회수/대표링크: .topTitle-mainbox 안 li 들
 *   대표링크 li.topTitle-link 에 class="partner" + span.affiliate-img 가
 *   있으면 제휴(파트너) 링크라는 명시적 신호다.
 * - 본문:        td.board-contents (파트너 글은 partner-contents 클래스 추가)
 * - 본문 종료:   <!--"<--> 마커
 * - 외부링크:    https://s.ppomppu.co.kr?idno=...&target=<base64>&encode=on
 *                로 감싸져 있으며 target을 base64 디코딩하면 실제 URL이다.
 * - 댓글수:      var initialCommentData = {"total_comment":N,...} 스크립트
 * - 카테고리:    <input name="category" value="숫자"> (번호→이름 매핑 필요)
 * - 추천수:      페이지에 노출되지 않음 (AJAX) → 항상 null
 *
 * 다중 상품 패턴 (토스글 등)
 *   <p>상품명</p> <p>가격원</p> <p><a href=래핑>url</a></p> 가 반복된다.
 *
 * 옵션(체감가) 나열 패턴 (라이브 커머스글 등)
 *   "갤럭시 워치9 40mm 블루투스 체감가 👉469,010원" 같은
 *   동일 마커(체감가/혜택가) 가격 라인이 3개 이상 나열된다.
 */
export function parsePpomppuHtml(
  html: string,
  options?: {
    sourceUrl?: string;
    collectedAt?: string;
  },
): PpomppuDeal {
  const $ = cheerio.load(html);

  const sourceUrl = normalizeUrl(
    options?.sourceUrl ??
      $('link[rel="canonical"]').attr("href") ??
      "",
  ) ?? "";

  const sourcePostId = extractPostId(sourceUrl, html);
  const boardId = extractBoardId(sourceUrl, html);

  const title = extractTitle($);
  const storeTag = extractStoreTag(title);
  const category = extractCategory($);
  const author = extractAuthor($);
  const isPartnerPost =
    $("td.board-contents").first().hasClass("partner-contents");

  const postedAt = extractPostedAt($);
  const stats = extractStats($);

  const body = findBody($);
  const blockLines = extractBlockLines($, body);
  const bodyText = blockLines
    .map((line) => line.text)
    .filter(Boolean)
    .join("\n");

  const topTitleLink = extractTopTitleLink($);
  const bodyLinks = collectBodyLinks($, body);

  const allLinks = dedupeLinks([
    ...(topTitleLink ? [topTitleLink] : []),
    ...bodyLinks,
  ]);

  const groups = groupProductSections(blockLines);

  let products: PpomppuProduct[];
  let rawPrice: string | null = null;
  let rawShipping: string | null = null;

  if (groups.length >= 2) {
    /*
     * 다중 상품 모드.
     * 각 그룹은 본문에서 상품명/가격/링크가 실제로 함께
     * 확인된 경우에만 만들어진다. (원칙 5)
     */
    products = groups.map((group) => ({
      name: group.name,
      price: group.price?.price ?? null,
      currency: group.price?.currency ?? null,
      priceText: group.price?.priceText ?? null,
      priceRange: group.price?.range ?? null,
      shipping: null,
      shippingText: null,
      store: storeTag,
      url: group.link?.resolved ?? null,
      urlType: detectUrlType(
        group.link?.resolved ?? null,
        group.link?.raw ?? null,
      ),
      rawUrl: group.link?.raw ?? null,
    }));
  } else {
    const variantLines = findVariantPriceLines(blockLines);

    if (variantLines.length >= 3) {
      /*
       * 옵션/체감가 나열 모드.
       * 상품별 개별 링크가 없으므로 url은 null로 둔다.
       * (게시글 대표 링크를 모든 옵션에 임의로 연결하지 않는다.)
       */
      products = variantLines.map((variant) => ({
        name: variant.name,
        price: variant.price.price,
        currency: variant.price.currency,
        priceText: variant.price.priceText,
        priceRange: variant.price.range,
        shipping: null,
        shippingText: null,
        store: storeTag,
        url: null,
        urlType: "none",
        rawUrl: null,
      }));
    } else {
      /*
       * 단일 상품 모드.
       * 본문에 상품 단위 구조가 없으므로 상품명은 제목 폴백
       * (nameFromTitle)으로 보완한다. 추출 실패 시 null.
       */
      const primaryLink =
        topTitleLink ?? bodyLinks[0] ?? null;

      const priceHit = extractSinglePrice(
        blockLines,
        bodyText,
        title,
      );

      const shippingHit = extractShipping(
        blockLines,
        title,
      );

      rawPrice = priceHit?.priceText ?? null;
      rawShipping = shippingHit?.shippingText ?? null;

      products = [
        {
          name: nameFromTitle(title),
          price: priceHit?.price ?? null,
          currency: priceHit?.currency ?? null,
          priceText: priceHit?.priceText ?? null,
          priceRange: priceHit?.range ?? null,
          shipping: shippingHit?.shipping ?? null,
          shippingText: shippingHit?.shippingText ?? null,
          store: storeTag,
          url: primaryLink?.resolved ?? null,
          urlType: detectUrlType(
            primaryLink?.resolved ?? null,
            primaryLink?.raw ?? null,
          ),
          rawUrl: primaryLink?.raw ?? null,
        },
      ];
    }
  }

  const discount = extractDiscount(blockLines);
  const status = extractStatus(title, bodyText);
  const affiliate = detectAffiliate($, body, topTitleLink !== null);

  return {
    id: `ppomppu-${sourcePostId}`,
    source: "ppomppu",
    sourcePostId,
    sourceUrl,
    boardId,
    title,
    category,
    author,
    isPartnerPost,
    postedAt,
    products,
    status,
    stats,
    discount,

    sourceMeta: {
      affiliate,
      rawUrl: products[0]?.rawUrl ?? null,
      rawPrice,
      rawShipping,
      links: allLinks,
    },

    collectedAt:
      options?.collectedAt ?? new Date().toISOString(),
  };
}

/* =========================================================
 * Title / store tag
 * ======================================================= */

function extractTitle($: cheerio.CheerioAPI): string {
  /*
   * h1 안에 댓글수 스팬(<span id="comment">N</span>)이 들어 있다.
   * (크롤러 수신 HTML 기준. 브라우저 캡처에는 없을 수 있음.)
   * 그대로 text()를 뽑으면 제목 끝에 댓글수가 달라붙으므로
   * 클론에서 제거한다.
   */
  const h1Clone = $("#topTitle h1").first().clone();

  h1Clone.find("span#comment").remove();

  const h1 = cleanText(h1Clone.text());

  if (h1) {
    return h1;
  }

  const og = $('meta[property="og:title"]').attr("content");

  if (og?.trim()) {
    return cleanText(og);
  }

  const titleTag = cleanText($("title").first().text());

  /*
   * <title>은 "뽐뿌::제목" 형태다.
   */
  return titleTag.replace(/^뽐뿌::/, "").trim();
}

/**
 * 뽐뿌 제목의 첫 번째 [...] 태그는 보통 스토어명이다.
 * 예: "[네이버] ...", "[쿠팡] ...", "[CJ ONSTYLE] ..."
 *
 * 단 "[뽐뿌전용 단,48시간]" 같은 마케팅 태그는 스토어가
 * 아니므로 제외한다.
 */
function extractStoreTag(title: string): string | null {
  const match = title.match(/^\s*\[([^\]]+)\]/);

  if (!match?.[1]) {
    return null;
  }

  const tag = cleanText(match[1]);

  if (
    /뽐뿌\s*전용|특가|이벤트|세일|할인|단독/.test(tag)
  ) {
    return null;
  }

  return tag || null;
}

/**
 * 단일 상품 글의 표시용 상품명 폴백.
 *
 * 본문에 상품 단위 구조가 없는 글은 제목이 유일한 이름 신호다.
 * (ruliweb의 제목 규약 파싱과 같은 접근 — 게시글 자신의 제목을
 *  쓰는 것이라 지어낸 값이 아니다.)
 *
 * 정리 규칙:
 *   1. 첫 번째 [...] 태그 제거 — 스토어명이든 마케팅 태그든
 *      상품명은 아니다. ("[지마켓] ...", "[뽐뿌전용 단,48시간] ...")
 *   2. 제목 꼬리의 가격/배송 괄호 제거 — 괄호 안이 가격/배송
 *      토큰으로 설명될 때만. "(6,400원/무료)" 제거,
 *      "(16인치)" "(390일분)"은 상품명 일부로 보존.
 *   3. 괄호 없는 꼬리 가격 표현 제거 ("...냉장고 231만원대~").
 *      원/만 단위 마커가 있을 때만 — "600g" "20구"는 보존.
 *   4. 남는 게 없으면 null.
 *
 * 마케팅 문구("이 가격에 OLED? ...")는 분리할 수 없어 그대로
 * 남는다. 상품 매칭은 URL 기반 product key가 담당하므로
 * 표시용 이름의 노이즈는 허용한다.
 */
function nameFromTitle(title: string): string | null {
  let working = cleanText(title);

  working = working.replace(/^\s*\[[^\]]+\]\s*/, "");

  working = stripTrailingPriceParens(working);

  /*
   * 괄호 없이 꼬리에 붙은 가격 표현.
   * 예: "... 1등급 냉장고 231만원대~" → "... 1등급 냉장고"
   */
  working = working.replace(
    /\s*\d[\d,]*\s*(?:만\s*원|만|원)\s*[대~부터]*\s*$/,
    "",
  );

  working = working
    .replace(/^[\s/·\-]+/, "")
    .replace(/[\s/·\-]+$/, "")
    .trim();

  return working || null;
}

/**
 * 꼬리 괄호 그룹이 가격/배송 토큰이면 제거한다.
 * 여러 괄호가 연속돼 있으면 끝에서부터 반복 제거.
 * 예: "... 20구 (6,400원/네멤무료)" → "... 20구"
 */
function stripTrailingPriceParens(text: string): string {
  let out = text;

  for (;;) {
    const match = out.match(/\(([^()]*)\)\s*$/);

    if (!match?.[1]) {
      break;
    }

    const inner = match[1];

    const looksLikePriceOrShipping =
      /원|만|￦|₩|\$|¥|￥|€|엔|무료|무배|배송|선불|착불|직배|free/i.test(
        inner,
      ) && /\d/.test(inner);

    if (!looksLikePriceOrShipping) {
      break;
    }

    out = out.slice(0, match.index).trimEnd();
  }

  return out;
}

/* =========================================================
 * Body
 * ======================================================= */

function findBody($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  /*
   * 실제 본문은 td.board-contents 부터 <!--"<--> 마커 사이다.
   * cheerio는 주석을 기준으로 자르기 어려우므로, td 선택 후
   * 텍스트 추출 단계에서 마커 뒤 내용을 걸러낸다.
   */
  const body = $("td.board-contents").first();

  if (body.length > 0) {
    return body;
  }

  /*
   * 스킨이 다른 경우를 위한 fallback: JS_ContentMain.
   */
  return $(".JS_ContentMain").first();
}

/**
 * 본문 내 블록 단위 라인 수집.
 *
 * cheerio .text()는 블록 경계를 보존하지 않으므로,
 * 리프 블록 요소(p/div/li/h1~h6/tr)를 문서 순서로 순회하며
 * 각 블록의 텍스트와 그 안에 포함된 링크를 수집한다.
 *
 * 중첩 블록은 자식 리프에서 이미 처리되므로 건너뛴다.
 * (예: div > p 이면 p만 라인으로 사용)
 */
function extractBlockLines(
  $: cheerio.CheerioAPI,
  body: cheerio.Cheerio<any>,
): BlockLine[] {
  const lines: BlockLine[] = [];

  if (body.length === 0) {
    return lines;
  }

  const blockSelector =
    "p, div, li, h1, h2, h3, h4, h5, h6, tr, td";

  body.find(blockSelector).each((_, el) => {
    const $el = $(el);

    /*
     * 블록 자손이 있으면 리프가 아니다.
     * (a는 블록이 아니므로 링크만 감싼 p는 리프로 취급된다.)
     */
    if ($el.find(blockSelector).length > 0) {
      return;
    }

    let text = cleanText($el.text());

    /*
     * <!--"<--> 마커 이후(댓글/추천 버튼 등)가 같은 td 안에
     * 들어오는 일은 없지만, 방어적으로 마커 텍스트를 자른다.
     */
    const markerIndex = text.indexOf('"<');

    if (markerIndex >= 0) {
      text = cleanText(text.slice(0, markerIndex));
    }

    const links: BlockLine["links"] = [];

    $el.find("a").each((__, anchor) => {
      const href = $(anchor).attr("href") ?? null;

      if (!href || href.startsWith("#")) {
        return;
      }

      const link = resolveLink(href, cleanText($(anchor).text()));

      links.push(link);
    });

    if (!text && links.length === 0) {
      return;
    }

    lines.push({ text, links });
  });

  return lines;
}

/* =========================================================
 * Links
 *
 * 뽐뿌의 외부 링크는 s.ppomppu.co.kr 래퍼로 감싸져 있다.
 *   https://s.ppomppu.co.kr?idno=pmarket_303717
 *     &target=aHR0cHM6Ly9uYXZlci5tZS94UmcwMXoydA==&encode=on
 * target 파라미터는 실제 URL의 base64 인코딩이다.
 * ======================================================= */

function resolveLink(
  href: string,
  anchorText: string,
): { raw: string | null; resolved: string | null } {
  const raw = normalizeUrl(href) ?? href.trim() ?? null;

  const targetMatch = href.match(
    /[?&]target=([A-Za-z0-9+/=]+)/,
  );

  if (targetMatch?.[1]) {
    const decoded = decodeBase64(targetMatch[1]);
    const resolved = normalizeUrl(decoded);

    if (resolved) {
      return { raw, resolved };
    }
  }

  /*
   * base64 디코딩 실패 시: 앵커 텍스트에 실제 URL이
   * 그대로 적혀 있는 경우가 많다.
   */
  const textUrl = normalizeUrl(anchorText);

  if (textUrl) {
    return { raw, resolved: textUrl };
  }

  return { raw, resolved: normalizeUrl(href) };
}

function decodeBase64(value: string): string | null {
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(value, "base64").toString("utf-8");
    }

    if (typeof atob === "function") {
      const binary = atob(value);
      const bytes = Uint8Array.from(binary, (char) =>
        char.charCodeAt(0),
      );

      return new TextDecoder("utf-8").decode(bytes);
    }

    return null;
  } catch {
    return null;
  }
}

function extractTopTitleLink(
  $: cheerio.CheerioAPI,
): { raw: string | null; resolved: string | null } | null {
  const li = $("li.topTitle-link").first();

  if (li.length === 0) {
    return null;
  }

  const anchor = li.find("a").first();

  if (anchor.length === 0) {
    return null;
  }

  const href = anchor.attr("href");

  if (!href) {
    return null;
  }

  return resolveLink(href, cleanText(anchor.text()));
}

function collectBodyLinks(
  $: cheerio.CheerioAPI,
  body: cheerio.Cheerio<any>,
): Array<{ raw: string | null; resolved: string | null }> {
  const links: Array<{
    raw: string | null;
    resolved: string | null;
  }> = [];

  if (body.length === 0) {
    return links;
  }

  body.find("a").each((_, anchor) => {
    const href = $(anchor).attr("href") ?? null;

    if (!href || href.startsWith("#")) {
      return;
    }

    links.push(
      resolveLink(href, cleanText($(anchor).text())),
    );
  });

  return links;
}

function dedupeLinks(
  links: Array<{ raw: string | null; resolved: string | null }>,
): Array<{ raw: string | null; resolved: string | null }> {
  const seen = new Set<string>();
  const result: Array<{
    raw: string | null;
    resolved: string | null;
  }> = [];

  for (const link of links) {
    const key = link.resolved ?? link.raw ?? "";

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(link);
  }

  return result;
}

/* =========================================================
 * Multi-product grouping
 *
 * 본문 블록 라인을 순회하며
 *   상품명(텍스트) → 가격(가격 전용 라인) → 링크
 * 패턴이 반복되는 경우에만 복수 상품으로 판단한다.
 *
 * 링크가 여러 개라는 이유만으로 분리하지 않는다. (fmkorea와 동일 원칙)
 * ======================================================= */

type ProductGroup = {
  name: string | null;
  price: ParsedPrice | null;
  link: { raw: string | null; resolved: string | null } | null;
};

/**
 * 가격 마커 — 그룹핑과 단일 가격 추출이 공유한다.
 * "정가/정상가" 계열 원가 마커는 별도 제외 로직에서만 쓴다.
 */
const PRICE_MARKER =
  /공동구매\s*혜택가|공구\s*혜택가|최대\s*혜택가|혜택가|체감가|판매가|할인가|쿠폰\s*가|최종가|구매가/;

/**
 * 라인 전체가 대괄호 하나에 감싸여 있으면 가격 라벨이다.
 * 예: "[공구혜택가 125만]" — 마커 앞 "[공구"는 라벨의 일부이지
 * 상품명이 아니다.
 */
function isBracketLabel(text: string): boolean {
  return /^\[[^\]]*\]$/.test(text.trim());
}

function groupProductSections(
  lines: BlockLine[],
): ProductGroup[] {
  const groups: ProductGroup[] = [];

  let pendingName: string | null = null;
  let pendingPrice: ParsedPrice | null = null;
  /*
   * 가격은 확인됐는데 상품명이 아직 안 나온 상태.
   * 공구(공동구매) 글처럼 가격 라벨이 먼저 오는 패턴:
   *   "[공구혜택가 125만]" → 상품명 라인 → 링크
   * 이 상태의 일반 텍스트 라인은 가격을 리셋하지 않고
   * 상품명 자리를 채운다.
   */
  let awaitingName = false;

  for (const line of lines) {
    /*
     * 링크 라인: 누적된 상품명/가격과 함께 하나의 상품을 이룬다.
     * (텍스트가 URL 문자열이어도 링크 존재를 우선한다.)
     */
    if (line.links.length > 0) {
      if (pendingName || pendingPrice) {
        groups.push({
          name: pendingName,
          price: pendingPrice,
          link: line.links[0],
        });
      }

      pendingName = null;
      pendingPrice = null;
      awaitingName = false;
      continue;
    }

    if (!line.text) {
      continue;
    }

    /*
     * 가격 전용 라인 ("8,990원", "$12.27" 등)
     *
     * 0원 라인은 보통 배송비/혜택 표시이므로 상품 가격으로
     * 보지 않는다. (0원 딜은 드물고, 이 가정이 틀리면 상품
     * 하나가 누락되는 쪽으로 안전하게 실패한다.)
     */
    if (isPriceOnlyLine(line.text)) {
      const parsed = parsePriceText(line.text, {
        requireUnit: false,
      });

      if (parsed.price !== null && parsed.price > 0) {
        pendingPrice = parsed;
      }

      continue;
    }

    /*
     * 마커 가격 라인 — "혜택가 218만원대",
     * "갤럭시 워치9 40mm 블루투스 체감가 👉469,010원"처럼
     * 가격 마커가 붙은 라인은 가격 전용 라인이 아니지만
     * 가격을 담고 있다. 이걸 일반 텍스트(상품명 후보)로만
     * 취급하면 상품명/가격/링크가 실제로 반복되는 글이
     * 그룹핑되지 않아 상품 링크가 통째로 버려진다.
     *
     * - 마커 앞에 텍스트가 있으면 그 부분이 상품명이다
     *   (한 라인에 이름+가격이 같이 쓰는 패턴).
     *   단 라인이 통째로 대괄호 라벨("[공구혜택가 125만]")이면
     *   앞부분은 라벨의 일부라 상품명으로 쓰지 않는다.
     * - 상품명 부분이 없고 이미 받은 상품명이 있으면 그걸
     *   유지한다 (이름/가격/링크가 각각 별도 라인인 패턴).
     * - 상품명 부분이 없고 받은 상품명도 없으면 이름이 뒤에
     *   나오는 패턴 — awaitingName으로 전환한다.
     *
     * 가격은 0 초과만 채택 (가격 전용 라인과 동일 정책).
     */
    const markerMatch = line.text.match(PRICE_MARKER);

    if (markerMatch && markerMatch.index !== undefined) {
      /*
       * 가격 파싱은 마커 뒤 구간만 — 마커 앞 토큰은 상품명
       * 부분이거나 적립금 같은 보조 금액이다.
       */
      const parsed = parsePriceText(
        line.text.slice(markerMatch.index),
      );

      if (
        (parsed.price !== null && parsed.price > 0) ||
        parsed.range !== null
      ) {
        const namePart = cleanText(
          line.text.slice(0, markerMatch.index),
        );

        if (namePart && !isBracketLabel(line.text)) {
          /* 마커 앞에 인라인 상품명. */
          pendingName = namePart;
          awaitingName = false;
        } else if (isBracketLabel(line.text)) {
          /*
           * 대괄호 라벨은 섹션 헤더 — 상품명이 뒤에 오는
           * 공구(공동구매) 형식. 라벨보다 앞서 나온 텍스트는
           * 홍보 문구일 뿐이므로 이름 후보를 비우고 새로 받는다.
           */
          pendingName = null;
          awaitingName = true;
        } else if (!pendingName) {
          /* 마커로 시작하고 받은 이름도 없으면 이름이 뒤에 옴. */
          awaitingName = true;
        }

        pendingPrice = parsed;

        continue;
      }
    }

    /*
     * 일반 텍스트 라인.
     * - 가격 라벨 직후(awaitingName): 첫 텍스트 라인이 상품명.
     *   이어지는 텍스트 라인(스펙/설명)은 이름에 붙이지 않는다.
     * - 그 외: 다음 상품의 상품명 후보 (가격은 리셋).
     */
    if (awaitingName) {
      if (!pendingName) {
        pendingName = line.text;
      }

      continue;
    }

    pendingName = line.text;
    pendingPrice = null;
  }

  /*
   * 가격(0 초과)이 확인된 그룹만 상품으로 센다.
   * 가격이 없는 그룹은 링크 모음일 가능성이 크다.
   */
  return groups.filter(
    (group) =>
      group.price?.price !== null &&
      group.price?.price !== undefined &&
      group.price.price > 0,
  );
}

function isPriceOnlyLine(text: string): boolean {
  return /^[$€£¥₩￦]?\s*[\d,]+(?:\.\d+)?\s*만?\s*(?:원|USD|KRW|JPY|CNY|EUR)?\s*대?$/.test(
    text,
  );
}

/* =========================================================
 * Variant price lines (체감가/혜택가 나열)
 * ======================================================= */

/**
 * "갤럭시 워치9 40mm 블루투스 체감가 👉469,010원" 패턴.
 *
 * 동일 마커(체감가/혜택가)를 가진 가격 라인이 3개 이상이면
 * 옵션별 가격 나열로 보고 상품으로 분리한다.
 */
function findVariantPriceLines(
  lines: BlockLine[],
): Array<{ name: string | null; price: ParsedPrice }> {
  const markerRegex = /(체감가|혜택가)/;

  const candidates: Array<{
    name: string | null;
    price: ParsedPrice;
  }> = [];

  for (const line of lines) {
    if (!line.text || !markerRegex.test(line.text)) {
      continue;
    }

    const markerMatch = line.text.match(markerRegex);

    if (!markerMatch) {
      continue;
    }

    /*
     * 가격은 마커 뒤 구간에서 — 마커 앞은 옵션명/보조 금액이다.
     * 단 라인이 통째로 대괄호 라벨("[공구혜택가 125만]")이면
     * 마커 앞부분은 라벨의 일부라 상품명으로 쓰지 않는다.
     */
    const parsed = parsePriceText(
      line.text.slice(markerMatch.index),
    );

    if (parsed.price === null) {
      continue;
    }

    const name = isBracketLabel(line.text)
      ? null
      : cleanText(line.text.slice(0, markerMatch.index)) ||
        null;

    candidates.push({
      name: name || null,
      price: parsed,
    });
  }

  return candidates;
}

/* =========================================================
 * Single price
 * ======================================================= */

/**
 * 단일 상품 글의 대표 가격 추출.
 *
 * 우선순위:
 * 1. 명시적 마커 라인 (판매가/최대혜택가/할인가/쿠폰가/최종가...)
 *    — "정가/정상가/할인 전 가격" 같은 원가 라인은 제외
 * 2. 본문에 유일한 가격만 있는 경우 그 가격
 * 3. 제목 괄호 안 가격 ("(6,400원/네멤무료)", "(103만)")
 */
function extractSinglePrice(
  lines: BlockLine[],
  bodyText: string,
  title: string,
): ParsedPrice | null {
  const originalMarker =
    /정가|정상가|할인\s*전|원래\s*가|시중가|소비자\s*가/;

  for (const line of lines) {
    if (!line.text) {
      continue;
    }

    const markerMatch = line.text.match(PRICE_MARKER);

    if (!markerMatch) {
      continue;
    }

    if (originalMarker.test(line.text)) {
      continue;
    }

    /*
     * 마커 뒤 구간만 파싱한다. 마커는 라벨이라 가격이 뒤에 오고,
     * 마커 앞 숫자 토큰은 적립금/쿠폰액 같은 보조 정보다.
     * (실사례: "네멤이면 적립금 1,000원정도 있어서 체감가
     *  4천원대" — 전체 라인을 파싱하면 적립금 1,000원이
     *  상품 가격으로 잡힌다.)
     */
    const parsed = parsePriceText(
      line.text.slice(markerMatch.index),
    );

    if (parsed.price !== null) {
      return parsed;
    }
  }

  /*
   * 본문에 가격이 정확히 하나뿐이면 그 가격을 사용한다.
   */
  const allPrices = collectInlinePrices(bodyText);

  if (allPrices.length === 1) {
    return allPrices[0];
  }

  const titlePrice = parseTitlePrice(title);

  if (titlePrice) {
    return titlePrice;
  }

  return null;
}

function collectInlinePrices(text: string): ParsedPrice[] {
  const results: ParsedPrice[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    if (isPriceOnlyLine(line.trim())) {
      const parsed = parsePriceText(line.trim(), {
        requireUnit: false,
      });

      if (parsed.price !== null) {
        results.push(parsed);
      }
    }
  }

  return results;
}

/**
 * 제목의 괄호에서 가격을 추출한다.
 * "(6,400원/네멤무료)" → 6400원
 * "(103만)" → 1,030,000원
 */
function parseTitlePrice(title: string): ParsedPrice | null {
  const parenMatches = title.match(/\(([^)]*)\)/g);

  if (!parenMatches) {
    return null;
  }

  for (const paren of parenMatches) {
    const inner = paren.slice(1, -1);

    for (const segment of inner.split("/")) {
      const parsed = parsePriceText(segment.trim());

      if (parsed.price !== null) {
        return parsed;
      }
    }
  }

  return null;
}

/* =========================================================
 * Shipping
 * ======================================================= */

function extractShipping(
  lines: BlockLine[],
  title: string,
): {
  shipping: number | null;
  shippingText: string | null;
} | null {
  for (const line of lines) {
    if (!line.text) {
      continue;
    }

    if (/무료\s*배송|배송비\s*무료/.test(line.text)) {
      return { shipping: 0, shippingText: line.text };
    }

    const match = line.text.match(
      /배송비\s*[:：]?\s*([\d,]+(?:\.\d+)?)\s*원?/,
    );

    if (match?.[1]) {
      const value = Number(match[1].replace(/,/g, ""));

      if (!Number.isNaN(value)) {
        return { shipping: value, shippingText: line.text };
      }
    }
  }

  /*
   * 제목 괄호의 배송 정보: "(6,400원/네멤무료)" → "네멤무료"
   */
  const parenMatches = title.match(/\(([^)]*)\)/g);

  if (parenMatches) {
    for (const paren of parenMatches) {
      const inner = paren.slice(1, -1);

      for (const segment of inner.split("/")) {
        const trimmed = segment.trim();

        if (/무료/.test(trimmed) && !isPriceOnlyLine(trimmed)) {
          return { shipping: 0, shippingText: trimmed };
        }
      }
    }
  }

  return null;
}

/* =========================================================
 * Price parsing
 * ======================================================= */

/**
 * 텍스트에서 가격을 파싱한다.
 *
 * 지원 형태:
 * - "8,990원" / "12,690 원"
 * - "$12.27"
 * - "103만" / "103만원" / "231만원대" (만 단위)
 * - "10,000원~15,000원" (범위 → range)
 *
 * requireUnit (기본 true):
 *   "갤럭시 워치9 40mm ... 체감가 469,010원" 처럼 라인에
 *   가격 아닌 숫자(모델명/사이즈)가 섞여 있는 경우, 단위가
 *   없는 첫 숫자를 가격으로 오인식하지 않도록 원/만/통화기호
 *   같은 단위가 확인되는 토큰만 가격으로 채택한다.
 *   가격 전용 라인(isPriceOnlyLine 통과 후)처럼 맥락상 단위가
 *   생략될 수 있는 곳은 requireUnit=false로 호출한다.
 */
function parsePriceText(
  text: string | null,
  options?: { requireUnit?: boolean },
): ParsedPrice {
  const empty: ParsedPrice = {
    price: null,
    currency: null,
    priceText: null,
    range: null,
  };

  if (!text) {
    return empty;
  }

  const requireUnit = options?.requireUnit !== false;

  const normalized = cleanText(text);

  /*
   * 범위: "A원 ~ B원" / "A ~ B원"
   */
  const rangeMatch = normalized.match(
    /([\d,]+(?:\.\d+)?)\s*(?:만)?\s*원?\s*[~～]\s*([\d,]+(?:\.\d+)?)\s*(?:만)?\s*원/,
  );

  if (rangeMatch?.[1] && rangeMatch?.[2]) {
    const min = toNumber(rangeMatch[1]);
    const max = toNumber(rangeMatch[2]);

    if (min !== null && max !== null && min !== max) {
      return {
        price: null,
        currency: "KRW",
        priceText: normalized,
        range: { min, max },
      };
    }
  }

  const tokenRegex =
    /([$€£¥₩￦]?\s*[\d,]+(?:\.\d+)?)\s*(만)?\s*(원|USD|KRW|JPY|CNY|EUR)?/g;

  let fallback: ParsedPrice | null = null;

  for (const match of normalized.matchAll(tokenRegex)) {
    const rawNumber = match[1];
    const hasSymbol = /[$€£¥₩￦]/.test(rawNumber);
    const hasMan = match[2] === "만";
    const hasUnit =
      hasSymbol ||
      hasMan ||
      (match[3] !== undefined && match[3] !== "");

    let price = toNumber(rawNumber.replace(/[$€£¥₩￦]/g, ""));

    if (price === null) {
      continue;
    }

    if (hasMan) {
      price = price * 10000;
    }

    const parsed: ParsedPrice = {
      price,
      currency: detectCurrency(normalized, match[3]),
      priceText: match[0].trim(),
      range: null,
    };

    if (hasUnit) {
      /*
       * 단위가 확인된 첫 토큰을 채택한다.
       * (마커 라인의 가격은 보통 라인 끝에 하나만 온다.)
       */
      return parsed;
    }

    if (!fallback) {
      fallback = parsed;
    }
  }

  if (!requireUnit && fallback) {
    return fallback;
  }

  return empty;
}

function toNumber(value: string): number | null {
  const parsed = Number(value.replace(/,/g, ""));

  return Number.isNaN(parsed) ? null : parsed;
}

function detectCurrency(
  text: string,
  unit: string | undefined,
): PpomppuProduct["currency"] {
  if (text.includes("$") || /USD/i.test(text) || unit === "USD") {
    return "USD";
  }

  if (
    text.includes("₩") ||
    text.includes("￦") ||
    text.includes("원") ||
    /KRW/i.test(text) ||
    unit === "원" ||
    unit === "KRW"
  ) {
    return "KRW";
  }

  if (text.includes("¥") || /JPY/i.test(text)) {
    return "JPY";
  }

  if (/CNY/i.test(text)) {
    return "CNY";
  }

  if (text.includes("€") || /EUR/i.test(text)) {
    return "EUR";
  }

  /*
   * 뽐뿌 핫딜의 절대다수는 원화다. 단위가 없지만
   * "만"/"원" 맥락이 없어도 한국 커뮤니티 가격 표기로 본다.
   * (fmkorea의 parsePrice는 null을 반환하지만, 뽐뿌는
   *  제목 "(103만)" 같은 표기가 흔해 KRW를 기본값으로 둔다.)
   */
  return "KRW";
}

/* =========================================================
 * Metadata
 * ======================================================= */

function extractPostId(
  sourceUrl: string,
  html: string,
): string {
  const urlMatch = sourceUrl.match(/[?&]no=(\d+)/);

  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  /*
   * 래핑 링크의 idno 파라미터: idno=pmarket_303717
   */
  const idnoMatch = html.match(/idno=[a-z0-9_]+_(\d{5,})/i);

  if (idnoMatch?.[1]) {
    return idnoMatch[1];
  }

  return "unknown";
}

function extractBoardId(
  sourceUrl: string,
  html: string,
): string | null {
  const urlMatch = sourceUrl.match(/[?&]id=([a-z0-9_]+)/i);

  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  const scriptMatch = html.match(/var\s+id\s*=\s*"([a-z0-9_]+)"/i);

  return scriptMatch?.[1] ?? null;
}

/**
 * 카테고리 번호 → 이름. (2026-08 쇼핑뽐뿌 게시판 셀렉트 기준)
 * 매핑에 없는 번호는 추측하지 않고 null.
 */
const CATEGORY_MAP: Record<string, string> = {
  "1": "기타",
  "5": "패션/뷰티",
  "6": "식품/건강",
  "7": "가전",
  "8": "컴퓨터",
  "10": "거래완료",
  "12": "교육/어학",
  "13": "자동차/용품",
  "14": "중고폰/수리",
};

function extractCategory($: cheerio.CheerioAPI): string | null {
  const value = $('input[name="category"]').first().attr("value");

  if (!value) {
    return null;
  }

  return CATEGORY_MAP[value] ?? null;
}

function extractAuthor($: cheerio.CheerioAPI): string | null {
  const name = cleanText(
    $("li.topTitle-name").first().text(),
  );

  return name || null;
}

/**
 * "등록일 2026-08-26 11:32" → "2026-08-26T11:32:00+09:00"
 */
function extractPostedAt($: cheerio.CheerioAPI): string | null {
  const mainbox = $("ul.topTitle-mainbox").first();

  const text =
    mainbox.length > 0
      ? mainbox.text()
      : $("body").text();

  const match = text.match(
    /등록일\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/,
  );

  if (!match) {
    return null;
  }

  return (
    `${match[1]}-${match[2]}-${match[3]}` +
    `T${match[4]}:${match[5]}:00+09:00`
  );
}

function extractStats(
  $: cheerio.CheerioAPI,
): PpomppuDeal["stats"] {
  const topTitleText = cleanText(
    $("#topTitle").first().text(),
  );

  const viewsMatch = topTitleText.match(
    /조회수\s*([\d,]+)/,
  );

  const views = viewsMatch?.[1]
    ? Number(viewsMatch[1].replace(/,/g, ""))
    : null;

  /*
   * 댓글 수는 initialCommentData JSON에서 가져온다.
   * (댓글 목록은 AJAX로 로드되기 때문에 HTML에 없다.)
   */
  const html = $.html();

  const commentMatch = html?.match(
    /"total_comment"\s*:\s*(\d+)/,
  );

  const comments = commentMatch?.[1]
    ? Number(commentMatch[1])
    : null;

  return {
    views: Number.isNaN(views as number) ? null : views,
    /*
     * 뽐뿌는 추천수를 페이지에 렌더링하지 않는다. (AJAX 로드)
     */
    recommendations: null,
    comments: Number.isNaN(comments as number)
      ? null
      : comments,
  };
}

/* =========================================================
 * Affiliate
 * ======================================================= */

function detectAffiliate(
  $: cheerio.CheerioAPI,
  body: cheerio.Cheerio<any>,
  hasTopTitleLink: boolean,
): boolean {
  /*
   * 1. 대표 링크에 partner 클래스 또는 affiliate-img 아이콘
   */
  const linkLi = $("li.topTitle-link").first();

  if (hasTopTitleLink && linkLi.length > 0) {
    if (
      linkLi.hasClass("partner") ||
      linkLi.find(".affiliate-img").length > 0
    ) {
      return true;
    }
  }

  /*
   * 2. 제휴 활동 공시 문구
   *    - 네이버 쇼핑커넥트: "쇼핑커넥트 활동의 일환으로...수수료를 제공"
   *    - 쿠팡 등: "...파트너스 활동...수수료"
   */
  const bodyText = body.text();

  if (
    /쇼핑커넥트/.test(bodyText) ||
    /파트너스\s*활동/.test(bodyText) ||
    /수수료를?\s*제공\s*받/.test(bodyText)
  ) {
    return true;
  }

  return false;
}

/* =========================================================
 * URL type
 * ======================================================= */

function detectUrlType(
  url: string | null,
  rawUrl: string | null,
): PpomppuProduct["urlType"] {
  if (!url && !rawUrl) {
    return "none";
  }

  const value = `${rawUrl ?? ""} ${url ?? ""}`.toLowerCase();

  if (value.startsWith("javascript:")) {
    return "javascript";
  }

  /*
   * 토스 앱 진입형 딜. (래핑보다 먼저 판정해야
   * s.ppomppu.co.kr 리다이렉트에 묻히지 않는다.)
   */
  if (
    value.includes("toss.shopping") ||
    value.includes("toss.me")
  ) {
    return "app";
  }

  /*
   * s.ppomppu.co.kr 래핑이 풀렸다면(raw ≠ resolved)
   * 뽐뿌 서버를 거치는 리다이렉트다.
   * 제휴 여부는 detectAffiliate가 별도로 판단한다.
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

  if (url.startsWith("//")) {
    url = `https:${url}`;
  }

  if (!/^https?:\/\//i.test(url)) {
    return null;
  }

  return url;
}

/* =========================================================
 * Status
 * ======================================================= */

function extractStatus(
  title: string,
  bodyText: string,
): PpomppuDeal["status"] {
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

function extractDiscount(
  lines: BlockLine[],
): PpomppuDeal["discount"] {
  const bodyText = lines
    .map((line) => line.text)
    .filter(Boolean)
    .join("\n");

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
  ];

  for (const [regex, label] of keywordMap) {
    if (regex.test(bodyText)) {
      type.push(label);
    }
  }

  const discountLines = lines
    .map((line) => line.text)
    .filter(Boolean)
    .filter((line) =>
      /쿠폰|할인|적립|페이|코드|멤버십/.test(line),
    );

  return {
    type: Array.from(new Set(type)),
    codes,
    description: discountLines.join(" / "),
  };
}

function extractDiscountCodes(text: string): string[] {
  const codes = new Set<string>();

  /*
   * fmkorea와 동일하게 "할인코드/쿠폰코드" 명시 패턴만 사용.
   * ("코드" 단독 매치는 오탐이 많아 사용하지 않는다.)
   */
  const patterns = [
    /할인코드\s*[:：]?\s*([A-Z0-9_-]{4,30})/gi,
    /쿠폰코드\s*[:：]?\s*([A-Z0-9_-]{4,30})/gi,
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
 * Helpers
 * ======================================================= */

function cleanText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
