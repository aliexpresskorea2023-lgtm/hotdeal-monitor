export type Community =
  | "fmkorea"
  | "ppomppu"
  | "arca"
  | "mlbpark"
  | "quasarzone"
  | "theqoo"
  | "slrclub"
  | "ruliweb";

export type DealStatus =
  | "active"
  | "ended"
  | "unknown";

export type Currency =
  | "KRW"
  | "USD"
  | "CNY"
  | "JPY"
  | "EUR"
  | "GBP";

export type UrlType =
  | "direct"
  | "redirect"
  | "affiliate"
  | "javascript"
  | "app"
  | "none"
  | "unknown";

export type PriceCondition =
  | "normal"
  | "coupon"
  | "card_discount"
  | "multiple_discount"
  | "option"
  | "target"
  | "app_only"
  | "coin"
  | "unknown";

export interface SourceStats {
  views: number | null;
  recommendations: number | null;
  comments: number | null;
}

export interface AffiliateInfo {
  enabled: boolean;
  rawUrl: string | null;
}

export interface SourcePost {
  community: Community;
  postId: string;
  postUrl: string;
  title: string;
  postedAt: string | null;
  status: DealStatus;
  stats: SourceStats;
  affiliate: AffiliateInfo;
}

export interface Product {
  name: string | null;
  normalizedName: string | null;
  category: string | null;
  store: string | null;
  productId: string | null;
}

export interface PriceRange {
  min: number;
  max: number;
}

export interface Price {
  dealPrice: number | null;
  /** 유형 D(옵션별 최저가~최고가)에서만 채움. dealPrice와 동시에 쓰지 않는다. */
  priceRange: PriceRange | null;
  currency: Currency;
  priceText: string;
  estimatedKrw: number | null;
  shipping: number | null;
  shippingText: string | null;
  condition: PriceCondition;
}

export interface Discount {
  types: string[];
  codes: string[];
  /** 서로 중첩 적용 가능한 항목 (예: 상품쿠폰 + 카카오페이) */
  stackable: string[];
  /** 같은 결과를 내는 대체 옵션 묶음. 중복 적용 불가. */
  alternatives: string[][];
  description: string;
}

export interface Purchase {
  productUrl: string | null;
  urlType: UrlType;
  itemId: string | null;
}

export interface SourceMeta {
  rawPrice: string | null;
  rawShipping: string | null;
  originalProductUrl: string | null;
}

export interface HotScore {
  level: "hot" | "unknown";
  score: number | null;
}

export interface PriceHistory {
  lowestPrice: number | null;
  lowestPriceCurrency: Currency | null;
  lowestPriceKrwAtRecord: number | null;
  currentVsLowest:
    | "same"
    | "higher"
    | "lower"
    | "unknown";
}

export interface Deal {
  dealId: string;

  sourcePost: SourcePost;

  product: Product;

  price: Price;

  discount: Discount;

  purchase: Purchase;

  sourceMeta: SourceMeta;

  hotScore: HotScore;

  priceHistory: PriceHistory;

  collectedAt: string;
}

export interface ParserResult {
  deals: Deal[];
}