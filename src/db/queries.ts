import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_DB_PATH, openDbReadOnly } from "./index";
import { checkExclusion } from "./exclusion";
import { cleanDisplayName, splitNameParts, type NameParts } from "../lib/name";
import {
  ALL_NORM_CATEGORIES,
  isOtherStore,
  normalizeCategory,
  normalizeStore,
  OTHER_STORE_FILTER,
  type NormCategory,
} from "./taxonomy";

/*
 * 웹 표시용 읽기 쿼리 — 아이템(상품) 기반 뷰.
 *
 * 페이지는 아래 뷰 타입만 소비한다 — 수집 스키마(posts/deals)와
 * 표시 형태를 여기서 분리해 두면, 프론트 디자인이나 노출 기준이
 * 바뀌어도 이 파일만 고치면 된다.
 *
 * 표시 단위: 게시글이 아니라 아이템.
 * 같은 구매 URL을 가진 딜은 커뮤니티와 무관하게 카드 1개로
 * 병합하고, 카드 안에 출처 게시글 목록을 복수로 붙인다.
 * (설계 메모: 상품은 커뮤니티 위에 있다. 커뮤니티는 카드의 속성.)
 *
 * 식별 키 단계:
 *   현재  — 구매 URL 정규화(파라미터/프래그먼트 정리) 기반.
 *   다음  — 상품 ID(item_id) 매칭. 같은 상품을 가리키는 서로
 *           다른 URL까지 병합하려면 이 단계가 필요하다.
 *
 * 노출 규칙:
 * - 상품이 1개 이상 파싱된 게시글만 대상 (자유형/폼 미입력 제외)
 * - 무형·비핫딜 딜 제외 (exclusion.ts — 상품권/SW/포인트, 홍보글,
 *   항공권·이용권류, 0원 딜). 인제스트가 1차 방어, 여기가 2차.
 * - 구매 링크가 없는 딜은 병합할 수 없어 단독 카드로 남는다
 * - 종료 딜 포함. 진행중·상태 모름 → 종료 순서로 정렬
 * - 게시글 500개 상한 조회 후 아이템 조립
 *
 * 가격 정렬은 원화 환산 기준 — 달러/엔 등 외화는 대략 환율로
 * 환산해 비교한다 (FX_TO_KRW 주석 참고).
 */

export type PostStatus = "active" | "ended" | "unknown";

/** 아이템의 출처 게시글 하나. */
export interface ItemSourceView {
  /** `${community}-${post_id}` — 출처 간 유일 키 */
  id: string;
  /** 이 출처 딜 행의 rowid — 어드민 카드 편집 딥링크(/admin/deals/:id)용. */
  dealId: number;
  source: string;
  title: string;
  sourceUrl: string;
  status: PostStatus;
  /** 이 출처 딜의 상품명 (없으면 표시는 아이템 대표 이름 사용) */
  name: string | null;
  /** 이 게시글에 적힌 그 딜의 가격 (아이템 대표 가격과 다를 수 있음) */
  price: number | null;
  currency: string;
  priceText: string;
  shipping: number | null;
  shippingText: string | null;
  store: string | null;
  url: string | null;
  urlType: string;
  postedAt: string | null;
  /** 이 게시글의 첫 적재 시각 (원문 랜딩 폴백 기준) */
  firstSeenAt: string;
  /** 이 게시글의 마지막 적재(갱신) 시각 */
  collectedAt: string;
  stats: {
    views: number | null;
    recommendations: number | null;
    comments: number | null;
  };
}

/** 카드 단위 = 아이템. 여러 출처가 병합될 수 있다. */
export interface ItemView {
  /** 식별 키: 정규화 URL 또는 단독 딜의 `post:<community>:<id>#<seq>` */
  key: string;
  /** 출처 2개 이상으로 병합된 카드인지 */
  merged: boolean;
  /** 대표 상품명 (원본) */
  name: string | null;
  /**
   * 표시용 정제 이름 (src/lib/name.ts cleanDisplayName).
   * 프로모션 수식어·스토어 괄호·카드사 나열 등을 보수적으로 제거.
   * 정제 결과가 비면 원본으로 폴백.
   */
  displayName: string | null;
  /**
   * 정제 이름의 필드 분리 결과 (본체 + 구성/수량).
   * 커머스 상품명 등록 관례대로 없는 필드는 노출하지 않는다.
   * 이름이 없으면(게시글 제목 폴백 표시) null.
   */
  displayParts: NameParts | null;
  /** 출처들 중 대표 통화 기준 최저가 */
  price: number | null;
  currency: string;
  priceText: string;
  shipping: number | null;
  shippingText: string | null;
  store: string | null;
  url: string | null;
  urlType: string;
  category: string | null;
  /** 통합 카테고리 (커뮤니티 네이티브명 매핑 — taxonomy.ts) */
  categoryNorm: NormCategory;
  /** 스토어 대표 표기 (별칭 정규화 — taxonomy.ts) */
  storeNorm: string;
  /** 출처 중 하나라도 진행중이면 진행중 */
  status: PostStatus;
  discount: {
    type: string[];
    codes: string[];
    description: string;
  };
  /** 가장 이른 출처 작성 시각 */
  postedAt: string | null;
  /** 가장 최근 출처 갱신 시각 */
  collectedAt: string;
  /**
   * 원문 랜딩 대상: 게시 시간이 가장 빠른 출처.
   * 작성 시각이 없으면 첫 적재 시각으로 비교한다.
   */
  firstSource: ItemSourceView;
  /** 최신 확인 순으로 정렬된 출처 목록 */
  sources: ItemSourceView[];
  /**
   * 상품 썸네일 (product_images 캐시에서 조회).
   * 없으면 표시 계층에서 원문 커뮤니티 로고 → 스토어 로고로 폴백.
   */
  imageUrl: string | null;
}

export interface FeedResult {
  items: ItemView[];
  /** DB가 없거나 비어 있으면 "수집 이력 없음" 안내용 */
  hasData: boolean;
  lastIngestedAt: string | null;
}

interface PostRow {
  rowid: number;
  community: string;
  post_id: string;
  url: string;
  title: string;
  posted_at: string | null;
  status: string;
  views: number | null;
  recommendations: number | null;
  comments: number | null;
  affiliate_enabled: number;
  affiliate_raw_url: string | null;
  first_seen_at: string;
  last_seen_at: string;
  /** 어드민 수동 상태 지정 (없으면 수집기 판정). */
  status_override: string | null;
  hidden: number;
}

interface DealRow {
  /** deals 행 rowid — 어드민 편집 딥링크용. */
  deal_id: number;
  post_rowid: number;
  seq: number;
  product_name: string | null;
  category: string | null;
  store: string | null;
  deal_price: number | null;
  currency: string;
  price_text: string;
  shipping: number | null;
  shipping_text: string | null;
  product_url: string | null;
  url_type: string;
  raw_price: string | null;
  raw_shipping: string | null;
  discount_types: string | null;
  discount_codes: string | null;
  discount_description: string | null;
  /** 어드민 오버라이드 — 없으면 파서 값 노출. */
  name_override: string | null;
  price_override: number | null;
  category_override: string | null;
  store_override: string | null;
  /** 구매링크 수동 지정 — 설정 시 상품 병합 키도 이 링크 기준. */
  url_override: string | null;
  hidden: number;
  excluded_reason: string | null;
  exclusion_restored: number;
}

interface Member {
  post: PostRow;
  deal: DealRow;
}

/** 파싱 실패 대비가 필요한 JSON 배열 컬럼. */
function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/*
 * 아이템 식별 키 만들기 (1단계: URL 정규화).
 *
 * 규칙:
 * - 스킴 무시 (http/https 동일 상품 취급), 호스트 소문자
 * - 프래그먼트 제거 (옵션 앵커 #... 는 상품 정체성이 아님)
 * - 흔한 트래킹 파라미터 제거 (utm_*, spm, scm, fbclid 등).
 *   파라미터 순서는 정렬해 표기 차이로 갈라지는 것을 방지
 * - 나머지 쿼리는 보존 — 상품 식별자가 쿼리에 있는 스토어가 있다
 * - 파싱 실패(이상한 URL) 시 null → 호출 쪽에서 단독 카드로 처리
 */
const TRACKING_PARAM =
  /^(utm_[a-z]+|fbclid|gclid|igshid?|si|nclid|ref|ref_src|spm|scm)$/i;

export function productKeyFromUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);

    for (const key of Array.from(parsed.searchParams.keys())) {
      if (TRACKING_PARAM.test(key)) {
        parsed.searchParams.delete(key);
      }
    }

    parsed.searchParams.sort();

    const host = parsed.host.toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, "");
    const query = parsed.searchParams.toString();

    return `${host}${path}${query ? `?${query}` : ""}`;
  } catch {
    return null;
  }
}

function statusOf(row: PostRow): PostStatus {
  /* 어드민 수동 지정이 수집기 판정보다 우선. */
  if (row.status_override === "active" || row.status_override === "ended") {
    return row.status_override;
  }

  if (row.status === "active" || row.status === "ended") {
    return row.status;
  }

  return "unknown";
}

function makeSource(member: Member): ItemSourceView {
  const { post, deal } = member;

  const priceOverridden = deal.price_override !== null;

  /* 구매링크: 수동 지정이 파서 값보다 우선. 수동 링크는 직접 링크 취급. */
  const url = deal.url_override ?? deal.product_url;
  const urlType = deal.url_override !== null ? "direct" : deal.url_type;

  return {
    id: `${post.community}-${post.post_id}`,
    dealId: deal.deal_id,
    source: post.community,
    title: post.title,
    sourceUrl: post.url,
    status: statusOf(post),
    name: deal.name_override ?? deal.product_name,
    price: priceOverridden ? deal.price_override : deal.deal_price,
    currency: priceOverridden ? "KRW" : deal.currency,
    priceText: priceOverridden
      ? `${Math.round(deal.price_override as number).toLocaleString("ko-KR")}원`
      : deal.price_text,
    shipping: deal.shipping,
    shippingText: deal.shipping_text,
    store: deal.store_override ?? deal.store,
    url,
    urlType,
    postedAt: post.posted_at,
    firstSeenAt: post.first_seen_at,
    collectedAt: post.last_seen_at,
    stats: {
      views: post.views,
      recommendations: post.recommendations,
      comments: post.comments,
    },
  };
}

function buildItem(key: string, members: Member[]): ItemView {
  /* 최신 확인 순. 같으면 게시판 내 순서대로. */
  members.sort(
    (a, b) =>
      b.post.last_seen_at.localeCompare(a.post.last_seen_at) ||
      a.deal.seq - b.deal.seq,
  );

  /* 같은 게시글에서 들어온 중복 멤버는 첫 번째만 남긴다. */
  const sources: ItemSourceView[] = [];
  const seenPosts = new Set<string>();

  for (const member of members) {
    const postId = `${member.post.community}-${member.post.post_id}`;

    if (seenPosts.has(postId)) continue;

    seenPosts.add(postId);
    sources.push(makeSource(member));
  }

  const status: PostStatus = sources.some((s) => s.status === "active")
    ? "active"
    : sources.some((s) => s.status === "unknown")
      ? "unknown"
      : "ended";

  /* 대표 이름: 최신 출처 중 이름이 있는 것. */
  const named = sources.find((s) => s.name !== null) ?? sources[0];

  /*
   * 대표 가격: 수동 가격 오버라이드가 있으면 그것이 무조건 대표
   * 가격이다 (여럿이면 최신 출처 것). 없으면 기존 규칙 — 가격
   * 있는 출처 중 최신 출처의 통화를 기준으로 그 통화 출처들의
   * 최저가. 통화가 뒤섞인 채 최저를 구하는 것은 무의미하므로
   * 기준 통화를 먼저 고정한다.
   */
  let price: number | null = null;
  let currency = named.currency;
  let priceText = named.priceText;
  let shipping = named.shipping;
  let shippingText = named.shippingText;

  const overridden = members
    .filter((m) => m.deal.price_override !== null)
    .sort((a, b) =>
      b.post.last_seen_at.localeCompare(a.post.last_seen_at),
    )[0];

  if (overridden) {
    const oSource = makeSource(overridden);
    price = oSource.price;
    currency = oSource.currency;
    priceText = oSource.priceText;
    shipping = oSource.shipping;
    shippingText = oSource.shippingText;
  } else {
    const priced = sources.filter((s) => s.price !== null);

    if (priced.length > 0) {
      const baseCurrency = priced[0].currency;
      const sameCurrency = priced.filter((s) => s.currency === baseCurrency);

      let best = sameCurrency[0];

      for (const candidate of sameCurrency) {
        if ((candidate.price as number) < (best.price as number)) {
          best = candidate;
        }
      }

      price = best.price;
      currency = best.currency;
      priceText = best.priceText;
      shipping = best.shipping;
      shippingText = best.shippingText;
    }
  }

  const linked = sources.find((s) => s.url !== null) ?? null;
  const store = sources.find((s) => s.store !== null)?.store ?? null;
  const storeNorm = normalizeStore(store);
  const catMember =
    members.find(
      (m) => (m.deal.category_override ?? m.deal.category) !== null,
    ) ?? null;
  const catValue =
    (catMember?.deal.category_override ?? catMember?.deal.category) ?? null;

  const postedTimes = sources
    .map((s) => s.postedAt)
    .filter((t): t is string => t !== null)
    .sort();

  /*
   * 원문 랜딩 대상 = 게시 시간이 가장 빠른 출처.
   * 사이트가 작성 시각을 안 주면 첫 적재 시각으로 비교.
   */
  const firstSource = [...sources].sort(
    (a, b) =>
      (a.postedAt ?? a.firstSeenAt).localeCompare(
        b.postedAt ?? b.firstSeenAt,
      ),
  )[0];

  const displayName = cleanDisplayName(named.name, storeNorm);

  return {
    key,
    merged: sources.length >= 2,
    name: named.name,
    displayName,
    displayParts: displayName ? splitNameParts(displayName) : null,
    price,
    currency,
    priceText,
    shipping,
    shippingText,
    store,
    url: linked?.url ?? null,
    urlType: linked?.urlType ?? "none",
    category: catValue,
    categoryNorm: ALL_NORM_CATEGORIES.includes(catValue as NormCategory)
      ? (catValue as NormCategory)
      : normalizeCategory(
          catMember?.post.community ?? "",
          catValue,
          catMember?.post.title ?? null,
        ),
    storeNorm,
    status,
    discount: {
      type: [
        ...new Set(
          members.flatMap((m) => parseJsonArray(m.deal.discount_types)),
        ),
      ],
      codes: [
        ...new Set(
          members.flatMap((m) => parseJsonArray(m.deal.discount_codes)),
        ),
      ],
      description:
        members
          .map((m) => m.deal.discount_description)
          .find((d) => d !== null && d.trim() !== "") ?? "",
    },
    postedAt: postedTimes[0] ?? null,
    collectedAt: sources[0].collectedAt,
    firstSource,
    sources,
    imageUrl: null,
  };
}

export interface FeedOptions {
  /** 조회 대상 게시글 수 상한 (아이템 기준 아님) */
  postLimit?: number;
  /** 통합 카테고리 필터 */
  category?: NormCategory | null;
  /** 스토어 대표 표기 필터 */
  store?: string | null;
  /** 출처 커뮤니티 필터 (fmkorea/ppomppu/ruliweb/quasarzone/arca) */
  community?: string | null;
  /**
   * 상태 필터. active는 진행중+상태 모름을 포함한다
   * (임시 정책: 상태 모름은 진행중으로 노출).
   */
  status?: "all" | "active" | "ended";
  sort?: "latest" | "hot" | "price";
  /**
   * 상품명 검색어 — 부분 일치(대소문자 무시).
   * 아이템 대표 이름과 출처 게시글 제목 모두에서 찾는다
   * (이름이 없는 딜은 게시글 제목으로라도 걸리도록).
   */
  q?: string | null;
}

/** 출처 stats 합산 인기 점수 — 추천이 조회수보다 상위 가중치. */
export function hotScore(item: ItemView): number {
  let rec = 0;
  let views = 0;

  for (const source of item.sources) {
    rec += source.stats.recommendations ?? 0;
    views += source.stats.views ?? 0;
  }

  return rec * 100_000_000 + views;
}

/**
 * 아이템 경과 시간 (ms) — 실시간 순위 신선도 판정용.
 * 기준은 가장 이른 출처의 게시 시각, 사이트가 시각을 안 주면
 * 첫 적재 시각으로 계산한다. 시각을 파싱 못 하면 0(신규 취급) —
 * 데이터 이상으로 랭킹에서 잘못 제외되는 것을 막는다.
 */
export function itemAgeMs(item: ItemView, now: number = Date.now()): number {
  const basis = item.postedAt ?? item.firstSource.firstSeenAt;
  const parsed = Date.parse(basis);

  if (Number.isNaN(parsed)) return 0;

  return Math.max(0, now - parsed);
}

/*
 * 가격 정렬용 대략 환율 (원화 환산 기준).
 * 2026-08-27 기준치로 고정 — 표시가 아니라 정렬 전용이라
 * 소수점 정밀도는 필요 없고, 시세 변동 시 이 값만 갱신한다.
 * (출처: open.er-api.com, USD 1384.6 / JPY 8.70 / CNY 205.5 /
 * EUR 1614.1)
 */
const FX_TO_KRW: Record<string, number> = {
  KRW: 1,
  USD: 1385,
  JPY: 8.7,
  CNY: 205,
  EUR: 1615,
};

/** 아이템 대표 가격의 원화 환산값. 가격 없으면 무한대(정렬 맨 뒤). */
function priceKrwOf(item: ItemView): number {
  if (item.price === null) return Number.POSITIVE_INFINITY;

  const rate = FX_TO_KRW[item.currency] ?? 1;

  return item.price * rate;
}

/**
 * 아이템 단위 피드를 만든다. 필터/정렬은 여기서 적용한다.
 */
export function getDealFeed(
  options: FeedOptions = {},
  dbPath: string = DEFAULT_DB_PATH,
): FeedResult {
  const postLimit = options.postLimit ?? 500;
  const db = openDbReadOnly(dbPath);

  if (!db) return { items: [], hasData: false, lastIngestedAt: null };

  try {
    const postRows = db
      .prepare(
        `SELECT id AS rowid, community, post_id, url, title, posted_at,
                status, views, recommendations, comments,
                affiliate_enabled, affiliate_raw_url,
                first_seen_at, last_seen_at,
                status_override, hidden
         FROM posts
         WHERE hidden = 0
           AND EXISTS (SELECT 1 FROM deals d WHERE d.post_rowid = posts.id)
         ORDER BY CASE status WHEN 'ended' THEN 1 ELSE 0 END,
                  COALESCE(posted_at, first_seen_at) DESC, id DESC
         LIMIT ?`,
      )
      .all(postLimit) as unknown as PostRow[];

    if (postRows.length === 0) {
      return { items: [], hasData: false, lastIngestedAt: lastIngest(db) };
    }

    const placeholders = postRows.map(() => "?").join(", ");
    const dealRows = db
      .prepare(
        `SELECT id AS deal_id, post_rowid, seq, product_name, category, store,
                deal_price, currency, price_text, shipping, shipping_text,
                product_url, url_type, raw_price, raw_shipping,
                discount_types, discount_codes, discount_description,
                name_override, price_override, category_override,
                store_override, url_override, hidden, excluded_reason,
                exclusion_restored
         FROM deals
         WHERE post_rowid IN (${placeholders})
         ORDER BY post_rowid, seq`,
      )
      .all(...postRows.map((row) => row.rowid)) as unknown as DealRow[];

    const postByRowid = new Map<number, PostRow>();
    for (const row of postRows) {
      postByRowid.set(row.rowid, row);
    }

    /* 식별 키 → 멤버 목록. 키가 없으면(링크 없음) 단독 카드. */
    const groups = new Map<string, Member[]>();

    for (const deal of dealRows) {
      const post = postByRowid.get(deal.post_rowid);
      if (!post) continue;

      /* 어드민 숨김·제외(미복원) 딜은 노출하지 않는다. */
      if (deal.hidden === 1) continue;
      if (deal.excluded_reason !== null) continue;

      /*
       * 무형·비핫딜 2차 방어 — 기존 잔여분과 나중에 추가된 규칙을
       * 거른다. 어드민에서 복원된 딜은 규칙 판정을 다시 적용하지
       * 않는다 (복원 결정 유지).
       */
      if (
        deal.exclusion_restored === 0 &&
        checkExclusion({
          community: post.community,
          category: deal.category,
          title: post.title,
          price: deal.deal_price,
        }).excluded
      ) {
        continue;
      }

      const member: Member = { post, deal };
      /* 병합 키는 수동 지정 링크 우선 — 오버라이드가 카드 정체성을 바꾼다. */
      const effectiveUrl = deal.url_override ?? deal.product_url;
      const urlKey = effectiveUrl ? productKeyFromUrl(effectiveUrl) : null;
      const key =
        urlKey ??
        `post:${post.community}:${post.post_id}#${deal.seq}`;

      const list = groups.get(key);
      if (list) list.push(member);
      else groups.set(key, [member]);
    }

    let items = [...groups.entries()].map(([key, members]) =>
      buildItem(key, members),
    );

    /* 썸네일 캐시 일괄 조회 — URL 기반 키만 해당. */
    const urlKeys = items
      .map((i) => i.key)
      .filter((k) => !k.startsWith("post:"));

    if (urlKeys.length > 0) {
      const ph = urlKeys.map(() => "?").join(", ");
      const imgRows = db
        .prepare(
          `SELECT product_key, image_url, image_override
           FROM product_images
           WHERE product_key IN (${ph})
             AND (image_url != '' OR image_override IS NOT NULL)`,
        )
        .all(...urlKeys) as {
        product_key: string;
        image_url: string;
        image_override: string | null;
      }[];

      const imgByKey = new Map(
        imgRows.map((r) => [
          r.product_key,
          r.image_override ?? (r.image_url !== "" ? r.image_url : null),
        ]),
      );

      for (const item of items) {
        item.imageUrl = imgByKey.get(item.key) ?? null;
      }
    }

    if (options.q) {
      const needle = options.q.trim().toLowerCase();

      if (needle.length > 0) {
        items = items.filter((i) => {
          if (i.name && i.name.toLowerCase().includes(needle)) return true;

          return i.sources.some((s) =>
            s.title.toLowerCase().includes(needle),
          );
        });
      }
    }

    if (options.category) {
      items = items.filter((i) => i.categoryNorm === options.category);
    }

    if (options.store) {
      /*
       * "기타"는 고정 스토어 목록 밖 전부(스토어 미상 포함)를
       * 묶는 캐치올 필터다. 나머지는 정확 매칭.
       */
      items =
        options.store === OTHER_STORE_FILTER
          ? items.filter((i) => isOtherStore(i.storeNorm))
          : items.filter((i) => i.storeNorm === options.store);
    }

    if (options.community) {
      /* 출처 중 하나라도 해당 커뮤니티에서 온 아이템만. */
      const com = options.community;
      items = items.filter((i) => i.sources.some((s) => s.source === com));
    }

    if (options.status === "active") {
      items = items.filter((i) => i.status !== "ended");
    } else if (options.status === "ended") {
      items = items.filter((i) => i.status === "ended");
    }

    const sort = options.sort ?? "latest";

    /*
     * 작성 시각 기준: 원문 posted_at, 없으면 첫 적재 시각.
     * 수집 확인 시각(last_seen_at)은 쓰지 않는다 — 백필된 과거 글이
     * 적재 직후 "최신"으로 떠오르는 오염을 막는다.
     */
    const postedBasis = (i: ItemView) =>
      i.postedAt ?? i.firstSource.firstSeenAt;

    items.sort((a, b) => {
      /* 종료는 어떤 정렬에서도 맨 아래. */
      const endedDiff =
        (a.status === "ended" ? 1 : 0) - (b.status === "ended" ? 1 : 0);
      if (endedDiff !== 0) return endedDiff;

      if (sort === "hot") {
        const diff = hotScore(b) - hotScore(a);
        if (diff !== 0) return diff;
      } else if (sort === "price") {
        /* 원화 환산 기준 오름차순. 가격 없는 아이템은 맨 뒤. */
        const diff = priceKrwOf(a) - priceKrwOf(b);
        if (diff !== 0) return diff;
      }

      return (
        postedBasis(b).localeCompare(postedBasis(a)) ||
        a.key.localeCompare(b.key)
      );
    });

    return { items, hasData: true, lastIngestedAt: lastIngest(db) };
  } finally {
    db.close();
  }
}

function lastIngest(db: DatabaseSync): string | null {
  const row = db
    .prepare("SELECT MAX(ingested_at) AS at FROM ingest_runs")
    .get() as { at: string | null } | undefined;

  return row?.at ?? null;
}
