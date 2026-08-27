import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_DB_PATH, openDbReadOnly } from "./index";

/*
 * 웹 표시용 읽기 쿼리.
 *
 * 페이지는 아래 뷰 타입만 소비한다 — 수집 스키마(posts/deals)와
 * 표시 형태를 여기서 분리해 두면, 프론트 디자인이나 노출 기준이
 * 바뀌어도 이 파일만 고치면 된다.
 *
 * 현재 노출 규칙(데이터 확인 단계, 최소 구성):
 * - 상품이 1개 이상 파싱된 게시글만 (자유형/폼 미입력 글 제외)
 * - 종료 딜 포함 전부 표시, 진행중·상태 모름 → 종료 순서로
 * - 정렬은 게시글 마지막 적재 시각 내림차순
 * 추후 필터(커뮤니티/스토어 탭), 정렬, 페이지네이션을 여기 추가한다.
 */

export interface ProductView {
  name: string | null;
  price: number | null;
  currency: string;
  priceText: string;
  shipping: number | null;
  shippingText: string | null;
  store: string | null;
  url: string | null;
  urlType: string;
}

export interface PostView {
  /** `${community}-${post_id}` — 표시용 안정 키 */
  id: string;
  source: string;
  sourcePostId: string;
  sourceUrl: string;
  title: string;
  /** 상품 단위 카테고리 중 첫 번째 값. 상품 묶음(productKey) 단계에서 재설계 예정. */
  category: string | null;
  products: ProductView[];
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
  };
  postedAt: string | null;
  /** 마지막 적재(갱신) 시각 — 수집 워커가 마지막으로 확인한 시점 */
  collectedAt: string;
}

export interface FeedResult {
  posts: PostView[];
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
  last_seen_at: string;
}

interface DealRow {
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

/**
 * 표시할 게시글+상품 피드를 만든다.
 *
 * @param limit 표시할 게시글 수 상한 (상품이 아닌 게시글 기준)
 */
export function getDealFeed(
  limit = 500,
  dbPath: string = DEFAULT_DB_PATH,
): FeedResult {
  const db = openDbReadOnly(dbPath);

  if (!db) return { posts: [], hasData: false, lastIngestedAt: null };

  try {
    const postRows = db
      .prepare(
        `SELECT id AS rowid, community, post_id, url, title, posted_at,
                status, views, recommendations, comments,
                affiliate_enabled, affiliate_raw_url, last_seen_at
         FROM posts
         WHERE EXISTS (SELECT 1 FROM deals d WHERE d.post_rowid = posts.id)
         ORDER BY CASE status WHEN 'ended' THEN 1 ELSE 0 END,
                  last_seen_at DESC, id DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as PostRow[];

    if (postRows.length === 0) {
      return { posts: [], hasData: false, lastIngestedAt: lastIngest(db) };
    }

    const placeholders = postRows.map(() => "?").join(", ");
    const dealRows = db
      .prepare(
        `SELECT post_rowid, seq, product_name, category, store,
                deal_price, currency, price_text, shipping, shipping_text,
                product_url, url_type, raw_price, raw_shipping,
                discount_types, discount_codes, discount_description
         FROM deals
         WHERE post_rowid IN (${placeholders})
         ORDER BY post_rowid, seq`,
      )
      .all(...postRows.map((row) => row.rowid)) as unknown as DealRow[];

    const dealsByPost = new Map<number, DealRow[]>();
    for (const deal of dealRows) {
      const list = dealsByPost.get(deal.post_rowid);
      if (list) list.push(deal);
      else dealsByPost.set(deal.post_rowid, [deal]);
    }

    const posts: PostView[] = postRows.map((row) => {
      const deals = dealsByPost.get(row.rowid) ?? [];
      const first = deals[0];

      return {
        id: `${row.community}-${row.post_id}`,
        source: row.community,
        sourcePostId: row.post_id,
        sourceUrl: row.url,
        title: row.title,
        category: deals.find((d) => d.category)?.category ?? null,
        products: deals.map((d) => ({
          name: d.product_name,
          price: d.deal_price,
          currency: d.currency,
          priceText: d.price_text,
          shipping: d.shipping,
          shippingText: d.shipping_text,
          store: d.store,
          url: d.product_url,
          urlType: d.url_type,
        })),
        status: row.status as PostView["status"],
        stats: {
          views: row.views,
          recommendations: row.recommendations,
          comments: row.comments,
        },
        discount: {
          type: [...new Set(deals.flatMap((d) => parseJsonArray(d.discount_types)))],
          codes: [...new Set(deals.flatMap((d) => parseJsonArray(d.discount_codes)))],
          description:
            deals.find((d) => d.discount_description)?.discount_description ?? "",
        },
        sourceMeta: {
          affiliate: row.affiliate_enabled === 1,
          rawUrl: row.affiliate_raw_url,
          rawPrice: first?.raw_price ?? null,
          rawShipping: first?.raw_shipping ?? null,
        },
        postedAt: row.posted_at,
        collectedAt: row.last_seen_at,
      };
    });

    return { posts, hasData: true, lastIngestedAt: lastIngest(db) };
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
