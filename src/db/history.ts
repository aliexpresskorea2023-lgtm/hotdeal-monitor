import { DEFAULT_DB_PATH, openDbReadOnly } from "./index";
import { checkExclusion } from "./exclusion";
import {
  ALL_NORM_CATEGORIES,
  normalizeCategory,
  normalizeStore,
  type NormCategory,
} from "./taxonomy";
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
 * 노출 규칙은 특가 모음 피드와 동일하게 제외 마커·제외 규칙을 통과한
 * 딜만. 표시값(이름·스토어·카테고리·구매링크)은 피드와 같은
 * 오버라이드 우선 합성 — 어드민 수정분이 여기에도 반영된다.
 * 단 가격 관측 시계열은 사실 기록이라 가격 오버라이드를 섞지 않는다.
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
  url_override: string | null;
  name_override: string | null;
  store_override: string | null;
  category_override: string | null;
  excluded_reason: string | null;
  exclusion_restored: number;
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
                d.currency, d.product_url, d.url_override,
                d.name_override, d.store_override, d.category_override,
                d.excluded_reason, d.exclusion_restored,
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

      /* 어드민 제외(미복원) 딜은 노출하지 않는다 — 피드와 동일. */
      if (deal.excluded_reason !== null) continue;

      /*
       * 무형·비핫딜 2차 방어 — 피드(queries.ts)와 같은 기준.
       * 어드민에서 복원된 딜은 규칙을 재판정하지 않는다(복원 유지).
       */
      if (
        deal.exclusion_restored === 0 &&
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

      /* 표시값은 오버라이드 우선 합성 — 핫딜 모음 피드와 동일 원칙. */
      const storeNorm = normalizeStore(deal.store_override ?? deal.store);
      const catValue = deal.category_override ?? deal.category;
      const categoryNorm = ALL_NORM_CATEGORIES.includes(
        catValue as NormCategory,
      )
        ? (catValue as NormCategory)
        : normalizeCategory(deal.community, catValue, deal.title);

      items.push({
        dealId: deal.deal_id,
        name:
          cleanDisplayName(
            deal.name_override ?? deal.product_name ?? deal.title,
            storeNorm,
          ) ?? deal.title,
        community: deal.community,
        postTitle: deal.title,
        sourceUrl: deal.post_url,
        url: deal.url_override ?? deal.product_url,
        storeNorm,
        categoryNorm,
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
