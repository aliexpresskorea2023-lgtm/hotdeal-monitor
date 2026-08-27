import { DEFAULT_DB_PATH, openDbReadOnly } from "./index";
import { checkExclusion } from "./exclusion";
import { normalizeCategory, normalizeStore, type NormCategory } from "./taxonomy";
import { cleanDisplayName } from "../lib/name";
import type { PostStatus } from "./queries";

/*
 * 최저가 히스토리 읽기 쿼리.
 *
 * 재료는 price_observations — append-only 시계열이라 가격/배송비/
 * 상태가 직전 관측과 달라질 때만 행이 붙는다. 즉 관측이 2개 이상인
 * 딜 = "값이 실제로 변한 딜"이고, 그것만 히스토리로 보여준다.
 *
 * 커뮤니티 가격 관측이라는 점을 잊지 말 것 — 파서는 상품 페이지를
 * 직접 받지 않으므로, 여기 가격은 "그 시점 게시글에 적힌 값"이다.
 *
 * 노출 규칙은 특가 모음 피드와 동일하게 exclusion.ts를 통과한 딜만.
 */

export interface PricePoint {
  observedAt: string;
  price: number | null;
  currency: string | null;
  estimatedKrw: number | null;
  status: PostStatus;
}

export interface HistoryItem {
  dealId: number;
  name: string;
  community: string;
  postTitle: string;
  sourceUrl: string;
  url: string | null;
  storeNorm: string;
  categoryNorm: NormCategory;
  status: PostStatus;
  currency: string;
  /** 최신 관측 가격 */
  currentPrice: number | null;
  /** 관측 이력 중 최저가 */
  lowestPrice: number | null;
  /** 관측 이력 중 최고가 */
  highestPrice: number | null;
  /** 최초 관측 대비 최신 관측 변동률 (%) — 음수면 인하 */
  changePct: number | null;
  /** 최신 관측이 이력 최저가와 같은지 */
  atLowest: boolean;
  points: PricePoint[];
  updatedAt: string;
}

export interface HistoryResult {
  items: HistoryItem[];
  /** DB/관측 이력 존재 여부 */
  hasData: boolean;
  /** 관측이 1건 이상 쌓인 딜 수 (추적 중인 상품 규모) */
  trackedCount: number;
  /** 관측 총 건수 */
  observationCount: number;
}

export interface HistoryOptions {
  limit?: number;
  /** latest: 최근 변동순 · drop: 인하폭순 */
  sort?: "latest" | "drop";
}

interface ObsRow {
  deal_rowid: number;
  observed_at: string;
  post_status: string;
  deal_price: number | null;
  currency: string | null;
  estimated_krw: number | null;
}

interface DealJoinRow {
  deal_id: number;
  product_name: string | null;
  category: string | null;
  store: string | null;
  currency: string;
  product_url: string | null;
  community: string;
  title: string;
  post_url: string;
  status: string;
  last_seen_at: string;
}

function toStatus(raw: string): PostStatus {
  return raw === "active" || raw === "ended" ? raw : "unknown";
}

export function getPriceHistory(
  options: HistoryOptions = {},
  dbPath: string = DEFAULT_DB_PATH,
): HistoryResult {
  const limit = options.limit ?? 200;
  const sort = options.sort ?? "latest";
  const db = openDbReadOnly(dbPath);

  if (!db) {
    return {
      items: [],
      hasData: false,
      trackedCount: 0,
      observationCount: 0,
    };
  }

  try {
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS observations,
                COUNT(DISTINCT deal_rowid) AS tracked
         FROM price_observations`,
      )
      .get() as unknown as
      | { observations: number; tracked: number }
      | undefined;

    const observationCount = totals?.observations ?? 0;
    const trackedCount = totals?.tracked ?? 0;

    /* 값이 실제로 변한 딜(관측 2건 이상)만, 최근 변동 순으로. */
    const changed = db
      .prepare(
        `SELECT deal_rowid, MAX(observed_at) AS last_at
         FROM price_observations
         GROUP BY deal_rowid
         HAVING COUNT(*) >= 2
         ORDER BY last_at DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as { deal_rowid: number; last_at: string }[];

    if (changed.length === 0) {
      return {
        items: [],
        hasData: observationCount > 0,
        trackedCount,
        observationCount,
      };
    }

    const ids = changed.map((row) => row.deal_rowid);
    const placeholders = ids.map(() => "?").join(", ");

    const dealRows = db
      .prepare(
        `SELECT d.id AS deal_id, d.product_name, d.category, d.store,
                d.currency, d.product_url,
                p.community, p.title, p.url AS post_url,
                p.status, p.last_seen_at
         FROM deals d
         JOIN posts p ON p.id = d.post_rowid
         WHERE d.id IN (${placeholders})`,
      )
      .all(...ids) as unknown as DealJoinRow[];

    const obsRows = db
      .prepare(
        `SELECT deal_rowid, observed_at, post_status,
                deal_price, currency, estimated_krw
         FROM price_observations
         WHERE deal_rowid IN (${placeholders})
         ORDER BY deal_rowid, observed_at`,
      )
      .all(...ids) as unknown as ObsRow[];

    const pointsByDeal = new Map<number, PricePoint[]>();

    for (const row of obsRows) {
      const list = pointsByDeal.get(row.deal_rowid) ?? [];

      list.push({
        observedAt: row.observed_at,
        price: row.deal_price,
        currency: row.currency,
        estimatedKrw: row.estimated_krw,
        status: toStatus(row.post_status),
      });

      pointsByDeal.set(row.deal_rowid, list);
    }

    const items: HistoryItem[] = [];

    for (const deal of dealRows) {
      const points = pointsByDeal.get(deal.deal_id) ?? [];
      if (points.length < 2) continue;

      /* 무형·비핫딜은 피드와 같은 기준으로 제외. */
      if (
        checkExclusion({
          community: deal.community,
          category: deal.category,
          title: deal.title,
          price: points[points.length - 1].price,
        }).excluded
      ) {
        continue;
      }

      const priced = points.filter(
        (point): point is PricePoint & { price: number } =>
          point.price !== null,
      );

      const currentPrice = priced.length
        ? priced[priced.length - 1].price
        : null;
      const firstPrice = priced.length ? priced[0].price : null;
      const lowestPrice = priced.length
        ? Math.min(...priced.map((p) => p.price))
        : null;
      const highestPrice = priced.length
        ? Math.max(...priced.map((p) => p.price))
        : null;

      const changePct =
        firstPrice !== null && currentPrice !== null && firstPrice !== 0
          ? ((currentPrice - firstPrice) / firstPrice) * 100
          : null;

      const storeNorm = normalizeStore(deal.store);

      items.push({
        dealId: deal.deal_id,
        name: cleanDisplayName(
          deal.product_name ?? deal.title,
          storeNorm,
        ) ?? deal.title,
        community: deal.community,
        postTitle: deal.title,
        sourceUrl: deal.post_url,
        url: deal.product_url,
        storeNorm,
        categoryNorm: normalizeCategory(
          deal.community,
          deal.category,
          deal.title,
        ),
        status: toStatus(deal.status),
        currency: deal.currency,
        currentPrice,
        lowestPrice,
        highestPrice,
        changePct,
        atLowest:
          currentPrice !== null &&
          lowestPrice !== null &&
          currentPrice <= lowestPrice,
        points,
        updatedAt: points[points.length - 1].observedAt,
      });
    }

    items.sort((a, b) => {
      if (sort === "drop") {
        /* 인하폭이 큰(= changePct가 더 음수인) 순. 변동 없음은 뒤로. */
        const diff = (a.changePct ?? 0) - (b.changePct ?? 0);
        if (diff !== 0) return diff;
      }

      return b.updatedAt.localeCompare(a.updatedAt) || a.dealId - b.dealId;
    });

    return { items, hasData: true, trackedCount, observationCount };
  } finally {
    db.close();
  }
}
