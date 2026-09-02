import type { FmkoreaDeal, FmkoreaProduct } from "./fmkorea";
import type { PpomppuDeal, PpomppuProduct } from "./ppomppu";
import type { RuliwebDeal, RuliwebProduct } from "./ruliweb";
import type {
  QuasarzoneDeal,
  QuasarzoneProduct,
} from "./quasarzone";
import type { ArcaDeal, ArcaProduct } from "./arca";
import type { Deal, Product } from "./types";

/**
 * 커뮤니티별 parser(FmkoreaDeal 등 parser-native 타입)의 출력을
 * 중앙 스키마(types.ts의 Deal[])로 변환한다.
 *
 * 원칙:
 * - parser가 확인하지 못한 값은 여기서도 추론하지 않고 null/기본값을 둔다.
 * - 게시글 1개 = Deal 여러 개 (상품 단위)로 펼친다.
 */
export function normalizeFmkoreaDeal(
  post: FmkoreaDeal,
): Deal[] {
  if (post.products.length === 0) {
    return [];
  }

  return post.products.map((product, index) =>
    toDeal(post, product, index),
  );
}

function toDeal(
  post: FmkoreaDeal,
  product: FmkoreaProduct,
  index: number,
): Deal {
  return {
    dealId: `${post.id}-${index}`,

    sourcePost: {
      community: "fmkorea",
      postId: post.sourcePostId,
      postUrl: post.sourceUrl,
      title: post.title,
      postedAt: post.postedAt,
      status: post.status,
      stats: post.stats,
      affiliate: {
        enabled: post.sourceMeta.affiliate,
        rawUrl: post.sourceMeta.rawUrl,
      },
    },

    product: toProduct(post, product),

    price: {
      dealPrice: product.price,
      priceRange: null,
      currency: product.currency ?? "KRW",
      priceText: product.priceText ?? "",
      estimatedKrw: null,
      shipping: product.shipping,
      shippingText: product.shippingText,
      condition: "normal",
    },

    discount: {
      types: post.discount.type,
      codes: post.discount.codes,
      stackable: [],
      alternatives: [],
      description: post.discount.description,
    },

    purchase: {
      productUrl: product.url,
      urlType: product.urlType,
      itemId: extractItemId(product.url),
    },

    sourceMeta: {
      rawPrice: post.sourceMeta.rawPrice,
      rawShipping: post.sourceMeta.rawShipping,
      originalProductUrl: product.url,
    },

    hotScore: {
      level: "unknown",
      score: null,
    },

    priceHistory: {
      lowestPrice: null,
      lowestPriceCurrency: null,
      lowestPriceKrwAtRecord: null,
      currentVsLowest: "unknown",
    },

    collectedAt: post.collectedAt,
  };
}

function toProduct(
  post: FmkoreaDeal,
  product: FmkoreaProduct,
): Product {
  return {
    name: product.name,
    normalizedName: null,
    category: post.category,
    store: product.store,
    productId: extractItemId(product.url),
  };
}

/**
 * 알려진 쇼핑몰 item URL에서 상품 ID를 추출한다.
 *
 * - AliExpress: https://ko.aliexpress.com/item/1005011542564312.html -> "1005011542564312"
 * - Coupang:    https://www.coupang.com/vp/products/123456789/...    -> "123456789"
 *
 * 다른 쇼핑몰 URL이거나 패턴이 없으면 null.
 * (상품 페이지를 실제로 fetch하지 않는다는 원칙 유지 — URL 문자열만 본다.)
 */
function extractItemId(
  url: string | null,
): string | null {
  if (!url) {
    return null;
  }

  // AliExpress: /item/{digits}.html
  const aliexpress = url.match(
    /\/item\/(\d+)\.html/,
  );

  if (aliexpress?.[1]) {
    return aliexpress[1];
  }

  // Coupang: /vp/products/{digits}
  const coupang = url.match(
    /\/vp\/products\/(\d+)/,
  );

  if (coupang?.[1]) {
    return coupang[1];
  }

  // Gmarket: ?goodscode={digits} (item.gmarket.co.kr, m.gmarket.co.kr)
  if (/gmarket\.co\.kr/i.test(url)) {
    const gm = url.match(/[?&]goodscode=(\d+)/);
    if (gm?.[1]) return gm[1];
  }

  // 11번가: /products/{digits} 또는 /products/pa/{digits}
  if (/11st\.co\.kr/i.test(url)) {
    const st = url.match(/\/products\/(?:pa\/)?(\d+)/);
    if (st?.[1]) return st[1];
  }

  // 롯데온: /[mp]/product/LO{digits}
  if (/lotteon\.com/i.test(url)) {
    const lt = url.match(/\/product\/(LO\d+)/);
    if (lt?.[1]) return lt[1];
  }

  // 오늘의집: store.ohou.se/goods/{digits} 또는 ohou.se/productions/{digits}
  if (/ohou\.se/i.test(url)) {
    const oh = url.match(/\/(?:goods|productions)\/(\d+)/);
    if (oh?.[1]) return oh[1];
  }

  // 카카오스토어: store.kakao.com/{shop}/products/{digits}
  if (/store\.kakao\.com/i.test(url)) {
    const kk = url.match(/\/products\/(\d+)/);
    if (kk?.[1]) return kk[1];
  }

  // SSG: ?itemId={digits}
  if (/\.ssg\.com/i.test(url)) {
    const ssg = url.match(/[?&]itemId=(\d+)/);
    if (ssg?.[1]) return ssg[1];
  }

  // 옥션: ?itemno={alphanum}
  if (/auction\.co\.kr/i.test(url)) {
    const au = url.match(/[?&]itemno=([A-Za-z0-9]+)/);
    if (au?.[1]) return au[1];
  }

  // 29cm: /products/{digits}
  if (/29cm\.co\.kr/i.test(url)) {
    const cm = url.match(/\/products\/(\d+)/);
    if (cm?.[1]) return cm[1];
  }

  // 네이버 스마트스토어/브랜드스토어: /products/{digits}
  if (
    /smartstore\.naver\.com/i.test(url) ||
    /brand\.naver\.com/i.test(url)
  ) {
    const nv = url.match(/\/products\/(\d+)/);
    if (nv?.[1]) return nv[1];
  }

  return null;
}

/**
 * 뽐뿌 parser(PpomppuDeal) 출력 → 중앙 Deal[].
 *
 * fmkorea 매퍼와 동일한 원칙을 따른다. 추가로:
 * - product.priceRange(옵션별 가격 범위)를 그대로 옮긴다.
 * - post.postedAt(게시글 등록일)을 sourcePost에 반영한다.
 * - product.rawUrl(s.ppomppu.co.kr 래핑 URL)을
 *   sourceMeta.originalProductUrl로 보존한다.
 */
export function normalizePpomppuDeal(
  post: PpomppuDeal,
): Deal[] {
  if (post.products.length === 0) {
    return [];
  }

  return post.products.map(
    (product, index) =>
      ppomppuToDeal(post, product, index),
  );
}

function ppomppuToDeal(
  post: PpomppuDeal,
  product: PpomppuProduct,
  index: number,
): Deal {
  return {
    dealId: `${post.id}-${index}`,

    sourcePost: {
      community: "ppomppu",
      postId: post.sourcePostId,
      postUrl: post.sourceUrl,
      title: post.title,
      postedAt: post.postedAt,
      status: post.status,
      stats: post.stats,
      affiliate: {
        enabled: post.sourceMeta.affiliate,
        rawUrl: post.sourceMeta.rawUrl,
      },
    },

    product: {
      name: product.name,
      normalizedName: null,
      category: post.category,
      store: product.store,
      productId: extractItemId(product.url),
    },

    price: {
      dealPrice: product.price,
      priceRange: product.priceRange,
      currency: product.currency ?? "KRW",
      priceText: product.priceText ?? "",
      estimatedKrw: null,
      shipping: product.shipping,
      shippingText: product.shippingText,
      condition: "normal",
    },

    discount: {
      types: post.discount.type,
      codes: post.discount.codes,
      stackable: [],
      alternatives: [],
      description: post.discount.description,
    },

    purchase: {
      productUrl: product.url,
      urlType: product.urlType,
      itemId: extractItemId(product.url),
    },

    sourceMeta: {
      rawPrice: post.sourceMeta.rawPrice,
      rawShipping: post.sourceMeta.rawShipping,
      originalProductUrl:
        product.rawUrl ?? product.url,
    },

    hotScore: {
      level: "unknown",
      score: null,
    },

    priceHistory: {
      lowestPrice: null,
      lowestPriceCurrency: null,
      lowestPriceKrwAtRecord: null,
      currentVsLowest: "unknown",
    },

    collectedAt: post.collectedAt,
  };
}

/**
 * 루리웹 parser(RuliwebDeal) 출력 → 중앙 Deal[].
 *
 * fmkorea/뽐뿌 매퍼와 동일한 원칙을 따른다. 추가로:
 * - 루리웹은 1글 = 1딜 규약이라 products가 최대 1개다.
 * - product.rawUrl(web.ruliweb.com/link.php 래핑 URL)을
 *   sourceMeta.originalProductUrl로 보존한다.
 */
export function normalizeRuliwebDeal(
  post: RuliwebDeal,
): Deal[] {
  if (post.products.length === 0) {
    return [];
  }

  return post.products.map(
    (product, index) =>
      ruliwebToDeal(post, product, index),
  );
}

function ruliwebToDeal(
  post: RuliwebDeal,
  product: RuliwebProduct,
  index: number,
): Deal {
  return {
    dealId: `${post.id}-${index}`,

    sourcePost: {
      community: "ruliweb",
      postId: post.sourcePostId,
      postUrl: post.sourceUrl,
      title: post.title,
      postedAt: post.postedAt,
      status: post.status,
      stats: post.stats,
      affiliate: {
        enabled: post.sourceMeta.affiliate,
        rawUrl: post.sourceMeta.rawUrl,
      },
    },

    product: {
      name: product.name,
      normalizedName: null,
      category: post.category,
      store: product.store,
      productId: extractItemId(product.url),
    },

    price: {
      dealPrice: product.price,
      priceRange: null,
      currency: product.currency ?? "KRW",
      priceText: product.priceText ?? "",
      estimatedKrw: null,
      shipping: product.shipping,
      shippingText: product.shippingText,
      condition: "normal",
    },

    discount: {
      types: post.discount.type,
      codes: post.discount.codes,
      stackable: [],
      alternatives: [],
      description: post.discount.description,
    },

    purchase: {
      productUrl: product.url,
      urlType: product.urlType,
      itemId: extractItemId(product.url),
    },

    sourceMeta: {
      rawPrice: post.sourceMeta.rawPrice,
      rawShipping: post.sourceMeta.rawShipping,
      originalProductUrl:
        product.rawUrl ?? product.url,
    },

    hotScore: {
      level: "unknown",
      score: null,
    },

    priceHistory: {
      lowestPrice: null,
      lowestPriceCurrency: null,
      lowestPriceKrwAtRecord: null,
      currentVsLowest: "unknown",
    },

    collectedAt: post.collectedAt,
  };
}

/**
 * 퀘이사존 parser(QuasarzoneDeal) 출력 → 중앙 Deal[].
 *
 * fmkorea/뽐뿌/루리웹 매퍼와 동일한 원칙을 따른다. 추가로:
 * - 퀘이사존은 핫딜 폼 기준 1글 = 1딜이라 products가 최대 1개다.
 * - product.rawUrl(quasarzone.com/link?link= 게이트웨이 URL)을
 *   sourceMeta.originalProductUrl로 보존한다.
 */
export function normalizeQuasarzoneDeal(
  post: QuasarzoneDeal,
): Deal[] {
  if (post.products.length === 0) {
    return [];
  }

  return post.products.map(
    (product, index) =>
      quasarzoneToDeal(post, product, index),
  );
}

function quasarzoneToDeal(
  post: QuasarzoneDeal,
  product: QuasarzoneProduct,
  index: number,
): Deal {
  return {
    dealId: `${post.id}-${index}`,

    sourcePost: {
      community: "quasarzone",
      postId: post.sourcePostId,
      postUrl: post.sourceUrl,
      title: post.title,
      postedAt: post.postedAt,
      status: post.status,
      stats: post.stats,
      affiliate: {
        enabled: post.sourceMeta.affiliate,
        rawUrl: post.sourceMeta.rawUrl,
      },
    },

    product: {
      name: product.name,
      normalizedName: null,
      category: post.category,
      store: product.store,
      productId: extractItemId(product.url),
    },

    price: {
      dealPrice: product.price,
      priceRange: null,
      currency: product.currency ?? "KRW",
      priceText: product.priceText ?? "",
      estimatedKrw: null,
      shipping: product.shipping,
      shippingText: product.shippingText,
      condition: "normal",
    },

    discount: {
      types: post.discount.type,
      codes: post.discount.codes,
      stackable: [],
      alternatives: [],
      description: post.discount.description,
    },

    purchase: {
      productUrl: product.url,
      urlType: product.urlType,
      itemId: extractItemId(product.url),
    },

    sourceMeta: {
      rawPrice: post.sourceMeta.rawPrice,
      rawShipping: post.sourceMeta.rawShipping,
      originalProductUrl:
        product.rawUrl ?? product.url,
    },

    hotScore: {
      level: "unknown",
      score: null,
    },

    priceHistory: {
      lowestPrice: null,
      lowestPriceCurrency: null,
      lowestPriceKrwAtRecord: null,
      currentVsLowest: "unknown",
    },

    collectedAt: post.collectedAt,
  };
}

/**
 * 아카라이브 parser(ArcaDeal) 출력 → 중앙 Deal[].
 *
 * 퀘이사존 매퍼와 동일한 원칙을 따른다. 추가로:
 * - 아카라이브는 핫딜 폼 기준 1글 = 1딜이라 products가 최대 1개다.
 * - product.rawUrl(unsafelink.com 래핑 URL)을
 *   sourceMeta.originalProductUrl로 보존한다.
 */
export function normalizeArcaDeal(post: ArcaDeal): Deal[] {
  if (post.products.length === 0) {
    return [];
  }

  return post.products.map(
    (product, index) => arcaToDeal(post, product, index),
  );
}

function arcaToDeal(
  post: ArcaDeal,
  product: ArcaProduct,
  index: number,
): Deal {
  return {
    dealId: `${post.id}-${index}`,

    sourcePost: {
      community: "arca",
      postId: post.sourcePostId,
      postUrl: post.sourceUrl,
      title: post.title,
      postedAt: post.postedAt,
      status: post.status,
      stats: post.stats,
      affiliate: {
        enabled: post.sourceMeta.affiliate,
        rawUrl: post.sourceMeta.rawUrl,
      },
    },

    product: {
      name: product.name,
      normalizedName: null,
      category: post.category,
      store: product.store,
      productId: extractItemId(product.url),
    },

    price: {
      dealPrice: product.price,
      priceRange: null,
      currency: product.currency ?? "KRW",
      priceText: product.priceText ?? "",
      estimatedKrw: null,
      shipping: product.shipping,
      shippingText: product.shippingText,
      condition: "normal",
    },

    discount: {
      types: post.discount.type,
      codes: post.discount.codes,
      stackable: [],
      alternatives: [],
      description: post.discount.description,
    },

    purchase: {
      productUrl: product.url,
      urlType: product.urlType,
      itemId: extractItemId(product.url),
    },

    sourceMeta: {
      rawPrice: post.sourceMeta.rawPrice,
      rawShipping: post.sourceMeta.rawShipping,
      originalProductUrl: product.rawUrl ?? product.url,
    },

    hotScore: {
      level: "unknown",
      score: null,
    },

    priceHistory: {
      lowestPrice: null,
      lowestPriceCurrency: null,
      lowestPriceKrwAtRecord: null,
      currentVsLowest: "unknown",
    },

    collectedAt: post.collectedAt,
  };
}
