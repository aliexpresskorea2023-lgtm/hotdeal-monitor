import * as cheerio from "cheerio";
import { stripFalseEndedSignals } from "./status";

export type QuasarzoneProduct = {
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
   * 퀘이사존 링크 게이트웨이(quasarzone.com/link?link=<base64>)
   * 형태의 원본(래핑) URL. 직접 링크면 null.
   */
  rawUrl: string | null;
};

export type QuasarzoneDeal = {
  id: string;
  source: "quasarzone";
  sourcePostId: string;
  sourceUrl: string;
  /** quasarzone.com/bbs/<board>/views/<id> 의 board 슬러그 (예: qb_saleinfo) */
  boardId: string | null;
  title: string;
  category: string | null;
  /** ISO 8601 (+09:00) 또는 null */
  postedAt: string | null;

  products: QuasarzoneProduct[];

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
    /** 제목 옆 상태 라벨(진행중/종료 등). DOM에 드러난 1차 신호. */
    statusLabel: string | null;
    /**
     * 폼의 기타 행(예: "기타사항 → 리퍼"). 링크/판매처/가격/배송비
     * 외의 th→td 원문. 정형 스키마가 없어 문자열 지도로 보존한다.
     */
    formExtra: Record<string, string>;
    /** 본문에서 수집한 외부 링크 (원본+복원). 추적용. */
    bodyLinks: Array<{
      raw: string | null;
      resolved: string | null;
    }>;
    /**
     * 본문에 포함된 퀘이사존 내부 게시글 링크 (모음글, 과거 딜 참조 등).
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
 * 퀘이사존(quasarzone.com) 핫딜 게시글 parser
 *
 * 대상: quasarzone.com/bbs/qb_saleinfo/views/<id>
 * (핫딜 게시판. 게시판 필터는 크롤러의 역할이다.)
 *
 * 핵심 원칙 (fmkorea.ts / ppomppu.ts / ruliweb.ts와 동일)
 *
 * 1. 원본 유지 — 링크 게이트웨이 래핑 URL과 복원 URL을 분리 보존
 * 2. HTML에서 확인되는 값만 정규화
 * 3. 상품명을 임의로 생성하지 않음 (추출 실패 시 null)
 * 4. 상품 페이지를 여기서 fetch하지 않음
 * 5. 본문에서 상품 단위 구조가 확인되지 않으면 분리하지 않음
 *
 * 퀘이사존 마크업 특징 (2026-08 실측 페이지 기준)
 *
 * - 제목:        h1.title — 안에 상태 라벨 span.label("진행중" 등)이
 *   포함되므로 제거 후 텍스트를 취한다. 제목 머리 "[스토어]" 태그는
 *   판매처 폼 값과 동일하다.
 * - 카테고리:    div.ca_name ("PC/하드웨어" — 게시판 메뉴 카테고리)
 * - 게시글 id:   URL /views/<id> (og:url과 동일)
 * - 딜 정보 폼:  table.market-info-view-table 의 th/td 행:
 *     링크       a[href="javascript:goToLink('<base64>')"]
 *                base64를 디코딩하면 실제 상품 URL.
 *                goToLink()는 quasarzone.com/link?link=<base64>
 *                게이트웨이를 연다(커미션 전환 가능, 사이트 공통).
 *                앵커 텍스트에도 실제 URL이 그대로 적혀 있다.
 *     판매처     스토어 이름 ("기타" 포함)
 *     가격       "￦ 212,500 (KRW)" — 통화기호+금액+(통화코드)
 *     배송비/직배 "무료" 또는 금액
 * - 본문:        textarea#org_contents 에 원본 HTML이 서버 렌더링된다.
 *   화면에 보이는 div#new_contents는 JS가 textarea를 복사해
 *   채우는 것이므로, 정적 HTML에서는 textarea를 읽어야 한다.
 *   (JS 렌더링 불필요 — 크롤러 입장에서 중요한 단순화 지점)
 * - 등록일:      헤더 .util-area 안 span.date ("2026.08.25 15:52")
 * - 조회수:      .util-area span.count em.view
 * - 댓글수:      .util-area span.count em.reply
 * - 추천수:      span#boardGoodCount
 * - 상태:        h1.title 안 span.label ("진행중"/"종료" 등)이
 *   1차 신호. 라벨이 없으면 공통 가드 적용 키워드 판정 폴백.
 *
 * 핫딜 폼(링크/판매처/가격/배송비)이 있는 글만 딜로 취급하고,
 * 폼이 없는 글(공지 등)은 products: []로 안전 실패한다.
 * 폼에 링크 행이 하나뿐인 1글 = 1딜 규약이므로 products는
 * 최대 1개다. 본문 속 추가 링크는 추적용으로만 수집한다.
 *
 * 제휴 참고: 링크 게이트웨이에 대한 커미션 공시 툴팁은 모든
 * 글에 붙는 사이트 템플릿이다. 게시글 단위 affiliate 판정은
 * 본문 공시 문구 기준으로만 한다. (fmkorea policy와 동일)
 */
export function parseQuasarzoneHtml(
  html: string,
  options?: {
    sourceUrl?: string;
    collectedAt?: string;
  },
): QuasarzoneDeal {
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

  const form = extractMarketInfoForm($);

  const bodyHtml = extractBodyHtml($);
  const body = cheerio.load(bodyHtml);
  const bodyText = cleanTextWithNewlines(
    textWithBlockNewlines(body.root()),
  );

  const products: QuasarzoneProduct[] = [];

  /*
   * 핫딜 폼(market-info-view-table)이 있을 때만 딜로 취급한다.
   * 공지글 등 폼이 없는 글은 products: [] → 크롤러가 스킵한다.
   * (fmkorea의 "폼 미입력 글 스킵" 정책과 동일한 안전 장치)
   */
  if (form !== null) {
    const link = form.link;

    /*
     * 퀘이사존 내부 게시판 링크(규정 글의 예시 링크, 다른 글·목록
     * 검색 링크 등)는 구매 링크가 아니므로 링크 없음으로 본다.
     */
    const resolvedUrl =
      link?.resolved && !isQuasarzoneInternalUrl(link.resolved)
        ? link.resolved
        : null;

    /*
     * 소수점 KRW 교정: 원화는 소수 단위가 없으므로 "￦ 6.82"는
     * 작성자가 외화 금액을 통화 기본값(KRW)으로 넣은 흔적이다.
     * 제목·본문·스토어 증거로 통화를 고치고, 증거가 없으면 유지.
     */
    const priceValue = form.price?.value ?? null;
    const currency = correctDecimalKrwCurrency(
      priceValue,
      form.price?.currency ?? null,
      form.store,
      title,
      bodyText,
    );

    products.push({
      name: productNameFromTitle(title),
      price: priceValue,
      currency,
      priceText: form.price?.text ?? null,
      shipping: form.shipping?.value ?? null,
      shippingText: form.shipping?.text ?? null,
      store: form.store ?? storeTagFromTitle(title),
      url: resolvedUrl,
      urlType: detectUrlType(resolvedUrl, link?.rawUrl ?? null),
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
    id: `quasarzone-${sourcePostId}`,
    source: "quasarzone",
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
  /*
   * 퀘이사존은 게시글 뷰 템플릿을 v2로 전환 중이다. 일부 글은
   * 옛 `h1.title`, 일부는 새 `h1.v2-view-head__title`로 렌더된다
   * (2026-09 실측: 같은 글도 크롤 시점에 따라 두 템플릿 중 하나로
   * 서빙됨). 옛 셀렉터만 찾으면 v2 글의 제목·상품명이 빈 값이 되어
   * 딜이 이름 없이 저장된다. 두 셀렉터를 모두 보고, 둘 다 없으면
   * 두 템플릿에 공통으로 존재하는 og:title로 폴백한다.
   */
  const heading = $("h1.title, h1.v2-view-head__title").first();

  if (heading.length > 0) {
    /* 상태 라벨(진행중/종료)은 제목 텍스트가 아니다. */
    const clone = heading.clone();
    clone.find("span.label").remove();

    const text = cleanText(clone.text());

    if (text) {
      return text;
    }
  }

  /* og:title 폴백 — 두 템플릿 모두에 깨끗한 제목이 들어 있다. */
  return cleanText(
    $('meta[property="og:title"]').attr("content") ?? "",
  );
}

/** 제목 머리 "[스토어]" 태그를 제거한 상품명을 만든다. */
function productNameFromTitle(title: string): string | null {
  const name = title.replace(/^\[[^\]]+\]\s*/, "").trim();

  return name || null;
}

function storeTagFromTitle(title: string): string | null {
  const match = title.match(/^\[([^\]]+)\]/);

  return match?.[1]?.trim() || null;
}

function extractCategory($: cheerio.CheerioAPI): string | null {
  /*
   * 게시판 카테고리(예: "생활/식품")는 옛 템플릿의 div.ca_name에만
   * 있다. v2 템플릿에는 카테고리 마크업이 아예 없다(2026-09 실측).
   * v2 글에서는 null이 되며 이는 의도된 동작이다 — category는
   * nullable이고 표시 계층에서 taxonomy.normalizeCategory가
   * community+title로 보완한다.
   */
  const value = cleanText($("div.ca_name").first().text());

  return value || null;
}

function extractStatusLabel($: cheerio.CheerioAPI): string | null {
  /* 상태 라벨은 옛 템플릿 h1.title, v2 템플릿 h1.v2-view-head__title
   * 안에 span.label("진행중"/"종료" 등)로 들어 있다. 둘 다 본다. */
  const value = cleanText(
    $("h1.title span.label, h1.v2-view-head__title span.label")
      .first()
      .text(),
  );

  return value || null;
}

function extractPostedAt($: cheerio.CheerioAPI): string | null {
  /*
   * 등록일 추출은 템플릿별로 출처가 다르다.
   * 1) 옛 템플릿: .market-info-view-wrap .util-area span.date
   *    ("2026.08.25 15:52")
   * 2) v2 템플릿: JSON-LD datePublished ("2026-07-01T19:26:36+09:00")
   *    — 년도까지 포함된 전체 ISO라 가장 신뢰 높다.
   * 3) v2 폴백: span.v2-view-head__time ("07.01 19:26") — 년도 없음.
   */
  const value = cleanText(
    $(".market-info-view-wrap .util-area span.date")
      .first()
      .text(),
  );

  const match = value.match(
    /^(\d{4})\.(\d{2})\.(\d{2})\.?\s*(?:(\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );

  if (match) {
    const [, year, month, day, hour, minute, second] = match;

    const time = [
      (hour ?? "00").padStart(2, "0"),
      minute ?? "00",
      second ?? "00",
    ].join(":");

    return `${year}-${month}-${day}T${time}+09:00`;
  }

  const jsonLd = extractJsonLdDatePublished($);

  if (jsonLd) {
    return jsonLd;
  }

  return parseV2HeadTime(cleanText($(".v2-view-head__time").first().text()));
}

/**
 * JSON-LD(script[type="application/ld+json"])의 datePublished를
 * 추출한다. v2 템플릿에는 년도 포함 전체 ISO가 들어 있다.
 * 값은 "+09:00" 오프셋 ISO 형태일 때만 그대로 쓴다(정규화 보증).
 */
function extractJsonLdDatePublished(
  $: cheerio.CheerioAPI,
): string | null {
  let result: string | null = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    if (result !== null) {
      return;
    }

    const text = $(el).html() ?? "";
    const match = text.match(/"datePublished"\s*:\s*"([^"]+)"/);
    const iso = match?.[1];

    if (
      iso &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        iso,
      )
    ) {
      result = iso;
    }
  });

  return result;
}

/**
 * v2 헤더 시각("07.01 19:26")은 년도가 없다. 현재 년도로 조합하되,
 * 결과가 미래(지금 + 1일 초과)면 작년 글로 보고 년도를 내린다.
 * 핫딜 게시판 특성상 등록일은 항상 최근 과거라는 전제가 안전하다.
 */
function parseV2HeadTime(text: string): string | null {
  const match = text.match(
    /^(\d{1,2})\.(\d{1,2})\.?\s+(?:(\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );

  if (!match) {
    return null;
  }

  const [, mm, dd, hour, minute, second] = match;
  const month = mm.padStart(2, "0");
  const day = dd.padStart(2, "0");
  const time = [
    (hour ?? "00").padStart(2, "0"),
    minute ?? "00",
    second ?? "00",
  ].join(":");

  const now = new Date();
  let year = now.getFullYear();

  const candidate = new Date(`${year}-${month}-${day}T${time}+09:00`);
  const limit = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  if (!Number.isNaN(candidate.getTime()) && candidate > limit) {
    year -= 1;
  }

  return `${year}-${month}-${day}T${time}+09:00`;
}

/* =========================================================
 * 핫딜 정보 폼 (market-info-view-table)
 *
 * th 텍스트로 행을 식별한다:
 *   링크 / 판매처 / 가격 / 배송비(직배)
 * ======================================================= */

type MarketForm = {
  link: { rawUrl: string | null; resolved: string | null } | null;
  store: string | null;
  price: {
    value: number | null;
    currency: QuasarzoneProduct["currency"];
    text: string | null;
  } | null;
  shipping: {
    value: number | null;
    text: string | null;
  } | null;
  /** 링크/판매처/가격/배송비로 식별되지 않은 나머지 행. */
  extra: Record<string, string>;
};

function extractMarketInfoForm(
  $: cheerio.CheerioAPI,
): MarketForm | null {
  const table = $("table.market-info-view-table").first();

  if (table.length === 0) {
    return null;
  }

  const form: MarketForm = {
    link: null,
    store: null,
    price: null,
    shipping: null,
    extra: {},
  };

  table.find("tr").each((_, row) => {
    const th = rowThText($(row));
    const td = $(row).find("td").first();

    if (!th || td.length === 0) {
      return;
    }

    if (th.startsWith("링크")) {
      form.link = extractFormLink(td);
      return;
    }

    if (th.startsWith("판매처")) {
      form.store = cleanText(td.text()) || null;
      return;
    }

    if (th.startsWith("가격")) {
      const text = cleanText(td.text());

      if (text) {
        form.price = { ...parsePriceCell(text), text };
      }
      return;
    }

    if (th.startsWith("배송")) {
      const text = cleanText(td.text());

      if (text) {
        form.shipping = {
          value: parseShippingCell(text),
          text,
        };
      }
      return;
    }

    /* 기타사항 등 미분류 행 — 원문 보존. */
    const value = cleanText(td.text());

    if (value) {
      form.extra[th] = value;
    }
  });

  return form;
}

/**
 * 행의 th 라벨 텍스트를 취한다. 링크 행 th에는 커미션 툴팁
 * (div.common-tooltip + style/script)이 딸려 있어 제거 후 읽는다.
 */
function rowThText(row: cheerio.Cheerio<any>): string {
  const th = row.find("th").first();

  if (th.length === 0) {
    return "";
  }

  const clone = th.clone();
  clone.find(".common-tooltip, style, script, img").remove();

  return cleanText(clone.text());
}

/**
 * 링크 행 앵커를 해석한다.
 *
 * href는 javascript:goToLink('<base64>') 형태이고, base64를
 * 디코딩하면 실제 상품 URL이다. goToLink()가 실제로 여는
 * quasarzone.com/link?link=<base64> 게이트웨이를 래핑 URL로
 * 보존한다. 앵커 텍스트에도 실제 URL이 적혀 있어 디코딩
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

  const wrapped = matchGoToLink(href);

  if (wrapped !== null) {
    const decoded = decodeBase64Url(wrapped);

    if (decoded !== null) {
      return {
        rawUrl: `https://quasarzone.com/link?link=${wrapped}`,
        resolved: decoded,
      };
    }
  }

  /* 일반 http 링크거나, 디코딩 실패 시 앵커 텍스트 폴백. */
  const directUrl = normalizeUrl(href);

  if (directUrl) {
    return { rawUrl: null, resolved: directUrl };
  }

  const textUrl = normalizeUrl(anchorText);

  if (textUrl) {
    return {
      rawUrl: wrapped
        ? `https://quasarzone.com/link?link=${wrapped}`
        : null,
      resolved: textUrl,
    };
  }

  return { rawUrl: null, resolved: null };
}

function matchGoToLink(href: string): string | null {
  const match = href.match(/goToLink\(\s*'([^']+)'\s*\)/);

  return match?.[1] ?? null;
}

/**
 * "￦ 212,500 (KRW)" 형태의 가격 셀을 파싱한다.
 * 통화코드 괄호 > 통화기호 > 단위어(원/엔/달러) 순으로
 * 통화를 판정하고, 아무 신호가 없으면 통화를 null로 둔다.
 */
function parsePriceCell(text: string): {
  value: number | null;
  currency: QuasarzoneProduct["currency"];
} {
  let currency: QuasarzoneProduct["currency"] = null;
  let working = text.trim();

  const codeMatch = working.match(
    /\((KRW|USD|JPY|CNY|EUR|GBP)\)\s*$/,
  );

  if (codeMatch?.[1]) {
    const code = codeMatch[1];

    /*
     * GBP는 parser-native product 통화 유니온 밖이라
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

    working = working.slice(0, codeMatch.index).trim();
  }

  const numberMatch = working.match(
    /([\d,]+(?:\.\d+)?)/,
  );

  if (!numberMatch?.[1]) {
    return { value: null, currency: null };
  }

  const value = Number(numberMatch[1].replace(/,/g, ""));

  if (Number.isNaN(value)) {
    return { value: null, currency: null };
  }

  if (currency === null) {
    if (/[￦₩]/.test(working) || /원\s*$/.test(working)) {
      currency = "KRW";
    } else if (/[$]/.test(working) || /달러\s*$/.test(working)) {
      currency = "USD";
    } else if (/[€]/.test(working)) {
      currency = "EUR";
    } else if (/(엔|円)\s*$/.test(working)) {
      currency = "JPY";
    }
  }

  return { value, currency };
}

/** 퀘이사존 내부 게시판 URL이면 상품 링크가 아니다. */
function isQuasarzoneInternalUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?quasarzone\.com\/bbs\//i.test(url);
}

/**
 * 소수점 KRW 금액의 통화 교정.
 *
 * 원화 표기에 소수점이 붙으면(예: "￦ 6.82") 작성자가 외화 금액을
 * 통화 선택 기본값인 KRW로 제출한 것이다 — 원화에는 소수 단위가
 * 없다. 제목·본문의 통화 언급을 1순위 증거로, 스토어를 2순위
 * 증거로 통화를 바로잡고, 증거가 없으면 원문을 보존한다
 * (추측 교정 금지).
 */
function correctDecimalKrwCurrency(
  price: number | null,
  currency: QuasarzoneProduct["currency"],
  store: string | null,
  title: string,
  bodyText: string,
): QuasarzoneProduct["currency"] {
  if (currency !== "KRW" || price === null || Number.isInteger(price)) {
    return currency;
  }

  const evidence = `${title}\n${bodyText}`;

  if (/달러|USD|\$\s?\d/i.test(evidence)) return "USD";
  if (/위안|元|CNY/i.test(evidence)) return "CNY";
  if (/¥|JPY|엔화/.test(evidence)) return "JPY";
  if (/€|EUR|유로/.test(evidence)) return "EUR";

  /* 알리익스프레스 국제 리스팅 기준 통화는 USD. */
  if (store && /알리/.test(store)) return "USD";

  return currency;
}

function parseShippingCell(text: string): number | null {
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

  /* "직배", "착불" 등 수치화 불가 → null (원문은 rawShipping에 보존) */
  return null;
}

/* =========================================================
 * Body
 *
 * 원본 본문은 textarea#org_contents에 서버 렌더링된다.
 * div#new_contents는 JS 복사 대상이라 정적 HTML에서는 비어 있다.
 * ======================================================= */

function extractBodyHtml($: cheerio.CheerioAPI): string {
  const textarea = $("textarea#org_contents").first();

  if (textarea.length > 0) {
    const value = textarea.text();

    if (value.trim()) {
      return value;
    }
  }

  /* JS 렌더링된 스냅샷(동적 캡처) 폴백. */
  return $("div.view-content").first().html() ?? "";
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
  bodyLinks: QuasarzoneDeal["sourceMeta"]["bodyLinks"];
  internalLinks: QuasarzoneDeal["sourceMeta"]["internalLinks"];
} {
  const bodyLinks: QuasarzoneDeal["sourceMeta"]["bodyLinks"] = [];
  const internalLinks: QuasarzoneDeal["sourceMeta"]["internalLinks"] = [];
  const seen = new Set<string>();

  body("a[href]").each((_, element) => {
    const href = body(element).attr("href") ?? "";
    const text = cleanText(body(element).text());

    /* 본문 이미지 호스트는 상품 링크가 아니다. */
    const imageHost = href.match(/^https?:\/\/([^/]+)/)?.[1];

    if (imageHost && /^img\d*\.quasarzone\.com$/.test(imageHost)) {
      return;
    }

    const wrapped = matchGoToLink(href);
    const rawUrl =
      wrapped !== null
        ? `https://quasarzone.com/link?link=${wrapped}`
        : normalizeUrl(href);

    let resolved: string | null = null;

    if (wrapped !== null) {
      resolved = decodeBase64Url(wrapped) ?? normalizeUrl(text);
    } else {
      resolved = normalizeUrl(href);
    }

    if (!resolved && !rawUrl) {
      return;
    }

    const key = resolved ?? rawUrl ?? "";

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    /* 퀘이사존 내부 게시글 링크 → 모음글 참조 등. */
    if (resolved && isQuasarzonePostLink(resolved)) {
      const postId = resolved.match(/\/views\/(\d+)/)?.[1];

      if (postId && postId !== sourcePostId) {
        internalLinks.push({
          rawUrl: rawUrl ?? resolved,
          url: resolved,
          text: text.slice(0, 200),
        });
      }

      return;
    }

    bodyLinks.push({ raw: rawUrl, resolved });
  });

  return { bodyLinks, internalLinks };
}

function isQuasarzonePostLink(url: string): boolean {
  try {
    const parsed = new URL(url);

    return (
      parsed.hostname.endsWith("quasarzone.com") &&
      /\/bbs\/[^/]+\/views\/\d+/.test(parsed.pathname)
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
): QuasarzoneProduct["urlType"] {
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
   * 게이트웨이 래핑이 풀렸다면(raw ≠ resolved) 퀘이사존 서버를
   * 거치는 리다이렉트다. 제휴 여부는 detectAffiliate가 별도로
   * 판단한다. (사이트 공통 커미션 툴팁은 게시글 단위 신호가 아님)
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
   * 링크 게이트웨이 커미션 툴팁은 사이트 템플릿(모든 글 공통)이라
   * 게시글 단위 제휴 신호로 쓰지 않는다. 본문에 제휴 활동 공시
   * 문구가 있는 경우만 감지한다. (다른 파서와 기준 동일)
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
  const match = sourceUrl.match(/\/views\/(\d+)/);

  return match?.[1] ?? "unknown";
}

function extractBoardId(sourceUrl: string): string | null {
  const match = sourceUrl.match(/\/bbs\/([A-Za-z0-9_]+)\//);

  return match?.[1] ?? null;
}

/* =========================================================
 * Stats
 * ======================================================= */

function extractStats($: cheerio.CheerioAPI): QuasarzoneDeal["stats"] {
  /*
   * 추천수는 span#boardGoodCount가 두 템플릿 공통이라 그대로 쓴다.
   * 조회/댓글은 옛 템플릿(.util-area span.count em.view/em.reply)에
   * 없으면 v2 헤더(.v2-view-head__meta의 "조회 9,324"/"댓글 12"
   * 텍스트)에서 폴백으로 뽑는다.
   */
  return {
    views:
      extractStat($(".util-area span.count em.view").first().text()) ??
      extractV2Stat($, "조회"),
    recommendations: extractStat(
      $("span#boardGoodCount").first().text(),
    ),
    comments:
      extractStat($(".util-area span.count em.reply").first().text()) ??
      extractV2Stat($, "댓글"),
  };
}

/**
 * v2 헤더 메타(.v2-view-head__meta의 span.v2-meta)에서 라벨
 * ("조회"/"댓글")로 항목을 찾아 숫자를 파싱한다. 콤마는 제거한다.
 */
function extractV2Stat(
  $: cheerio.CheerioAPI,
  label: string,
): number | null {
  let result: number | null = null;

  $(".v2-view-head__meta span.v2-meta").each((_, el) => {
    if (result !== null) {
      return;
    }

    const text = cleanText($(el).text());

    if (!text.includes(label)) {
      return;
    }

    const match = text.match(/([\d,]+)/);

    if (match?.[1]) {
      const value = Number(match[1].replace(/,/g, ""));

      if (!Number.isNaN(value)) {
        result = value;
      }
    }
  });

  return result;
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
  statusLabel: string | null,
  title: string,
  bodyText: string,
): QuasarzoneDeal["status"] {
  /*
   * 1차: DOM 상태 라벨. 퀘이사존은 작성자가 딜 상태를
   * 라벨로 명시한다(진행중/종료 등). 키워드 오분류가
   * 끼어들 여지가 없는 가장 신뢰 높은 신호다.
   */
  if (statusLabel) {
    if (/종료|품절|매진|끝/.test(statusLabel)) {
      return "ended";
    }

    if (/진행|판매/.test(statusLabel)) {
      return "active";
    }
  }

  /*
   * 2차(폴백): 라벨이 없는 페이지를 위한 키워드 판정.
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

function extractDiscount(
  bodyText: string,
): QuasarzoneDeal["discount"] {
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
 * 할인 코드를 추출한다. (ruliweb.ts와 동일 방식)
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

/**
 * base64 디코딩 후 유효한 URL이면 반환한다.
 * (ppomppu.ts의 target 래핑과 동일한 원리)
 */
function decodeBase64Url(value: string): string | null {
  const decoded = decodeBase64(value);

  if (decoded === null) {
    return null;
  }

  return normalizeUrl(decoded);
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
