import { DEFAULT_DB_PATH, openDbReadOnly } from "./index";
import { checkExclusion } from "./exclusion";
import {
  ALL_NORM_CATEGORIES,
  normalizeCategory,
  normalizeStore,
  type NormCategory,
} from "./taxonomy";
import { loadDeadKeys, loadResolutions } from "./link-resolution";
import { cleanDisplayName } from "../lib/name";
import { computeMergeKeys, type PostStatus } from "./queries";

/*
 * 최저가 히스토리 읽기 쿼리.
 *
 * 재료는 price_observations — append-only 시계열이라 가격/배송비/
 * 상태가 직전 관측과 달라질 때만 행이 붙는다. 즉 관측이 2개 이상인
 * 상품 = "값이 실제로 변한 상품"이고, 그것만 히스토리로 보여준다.
 *
 * 2단계(2026-09-16) — 병합 키 단위 재그룹화:
 *   예전엔 관측을 deal_rowid(게시글 내 상품 행) 단위로 묶었다. 그래서
 *   같은 상품이 커뮤니티 여럿에 걸리거나 어드민이 카드를 병합해도
 *   최저가 이력이 행별로 조각났다. 이제 공개 피드와 동일한 "유효 병합
 *   키"(product_key_override > URL 키 > 게시글 폴백)로 관측을 regroup해
 *   한 상품의 이력을 하나로 합친다. 병합된 카드의 과거 관측까지 소급
 *   통합되고, 크로스 커뮤니티 중복도 한 시리즈로 모인다.
 *
 * 커뮤니티 가격 관측이라는 점은 그대로 — 파서는 상품 페이지를 직접
 * 받지 않으므로, 여기 가격은 "그 시점 게시글에 적힌 값"이다. 서로 다른
 * 게시글의 관측이 한 키로 합쳐지면 "그 상품이 커뮤니티에서 관측된
 * 가격 시계열"이 된다.
 *
 * 노출 규칙은 특가 모음 피드와 동일하게 제외 마커·제외 규칙을 통과한
 * 딜만. 표시값(이름·스토어·카테고리·구매링크)은 피드와 같은
 * 오버라이드 우선 합성 — 어드민 수정분이 여기에도 반영된다.
 * 단 가격 관측 시계열은 사실 기록이라 가격 오버라이드를 섞지 않는다.
 *
 * 썸네일도 피드와 동일 — 대표 딜의 구매링크(수동 지정 우선)를 단축링크
 * 해석 반영 키로 product_images에서 조회. 상태는 피드와 같은 합성
 * (어드민 지정 > 구매링크 사망 판정 > 수집기 판정)을 멤버별로 구한 뒤
 * "하나라도 진행중이면 진행중"으로 합친다.
 */

export interface PricePoint {
  observedAt: string;
  price: number | null;
  currency: string | null;
  estimatedKrw: number | null;
  status: PostStatus;
}

export interface HistoryItem {
  /** 대표 딜 rowid — /history/[id] 라우트·어드민 편집 딥링크용. */
  dealId: number;
  /** 유효 병합 키 (피드와 동일 규칙). 같은 키의 관측이 한 시리즈로 합쳐진다. */
  key: string;
  /** 이 키로 병합된 딜 rowid 목록 (2개 이상이면 병합 카드). */
  memberDealIds: number[];
  name: string;
  community: string;
  postTitle: string;
  sourceUrl: string;
  url: string | null;
  storeNorm: string;
  categoryNorm: NormCategory;
  status: PostStatus;
  currency: string;
  /** 상품 썸네일 (product_images 캐시, 피드와 동일 키 합성). */
  imageUrl: string | null;
  /** 본문 삽입 대표 이미지 — 상품 썸네일 없을 때의 2순위 폴백. */
  bodyImageUrl: string | null;
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
  /** 게시글 작성 시각 (정렬·표시 기준). null이면 first_seen_at 폴백. */
  postedAt: string;
  /** 마지막 관측 시각 (참고용) */
  updatedAt: string;
}

export interface HistoryResult {
  items: HistoryItem[];
  /** DB/관측 이력 존재 여부 */
  hasData: boolean;
  /** 관측이 쌓인 상품(유효 병합 키) 수 — 추적 중인 상품 규모 */
  trackedCount: number;
  /** 관측 총 건수 */
  observationCount: number;
}

export interface HistoryOptions {
  limit?: number;
  /** latest: 최근 변동순 · drop: 인하폭순 */
  sort?: "latest" | "drop";
}

/** pass1 — 관측 딜당 lightweight 행 (키 합성 재료 + 관측 수). */
interface KeyRow {
  deal_id: number;
  obs_count: number;
  product_url: string | null;
  url_override: string | null;
  product_key_override: string | null;
  seq: number;
  community: string;
  post_id: string;
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
  seq: number;
  product_name: string | null;
  category: string | null;
  store: string | null;
  currency: string;
  product_url: string | null;
  url_override: string | null;
  product_key_override: string | null;
  name_override: string | null;
  store_override: string | null;
  category_override: string | null;
  excluded_reason: string | null;
  exclusion_restored: number;
  community: string;
  post_id: string;
  title: string;
  post_url: string;
  status: string;
  status_override: string | null;
  last_seen_at: string;
  posted_at: string | null;
  first_seen_at: string;
  body_image_url: string | null;
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

    /*
     * PASS 1 — 관측이 있는 딜을 lightweight로 읽어 유효 병합 키별로
     * 관측 수를 합친다. 어드민 하드 제외(excluded_reason) 딜은 여기서
     * 미리 걸러 후보를 줄인다(소프트 규칙은 pass2에서). 키 합성 재료만
     * 뽑으므로 행이 가볍다.
     */
    const keyRows = db
      .prepare(
        `SELECT po.deal_rowid AS deal_id, COUNT(*) AS obs_count,
                d.product_url, d.url_override, d.product_key_override, d.seq,
                p.community, p.post_id
         FROM price_observations po
         JOIN deals d ON d.id = po.deal_rowid
         JOIN posts p ON p.id = d.post_rowid
         WHERE d.excluded_reason IS NULL
         GROUP BY po.deal_rowid`,
      )
      .all() as unknown as KeyRow[];

    if (keyRows.length === 0) {
      return {
        items: [],
        hasData: observationCount > 0,
        trackedCount: 0,
        observationCount,
      };
    }

    const resolutions = loadResolutions(
      db,
      keyRows.map((r) => r.url_override ?? r.product_url),
    );

    /* 키 → 멤버(딜 id, 관측 수). */
    const dealsByKey = new Map<string, Array<{ dealId: number; obsCount: number }>>();
    const obsByKey = new Map<string, number>();

    for (const row of keyRows) {
      const { key } = computeMergeKeys(row, resolutions);

      const list = dealsByKey.get(key) ?? [];
      list.push({ dealId: row.deal_id, obsCount: row.obs_count });
      dealsByKey.set(key, list);

      obsByKey.set(key, (obsByKey.get(key) ?? 0) + row.obs_count);
    }

    const trackedCount = dealsByKey.size;

    /* 관측 합 2건 이상인 키만 후보 — "값이 실제로 변한 상품". */
    const qualifyingKeys = [...obsByKey.entries()]
      .filter(([, n]) => n >= 2)
      .map(([key]) => key);

    if (qualifyingKeys.length === 0) {
      return {
        items: [],
        hasData: observationCount > 0,
        trackedCount,
        observationCount,
      };
    }

    const memberIds = [
      ...new Set(
        qualifyingKeys.flatMap((key) =>
          (dealsByKey.get(key) ?? []).map((m) => m.dealId),
        ),
      ),
    ];

    const placeholders = memberIds.map(() => "?").join(", ");

    /* PASS 2 — 후보 딜의 표시 재료와 관측 시계열을 읽는다. */
    const dealRows = db
      .prepare(
        `SELECT d.id AS deal_id, d.seq, d.product_name, d.category, d.store,
                d.currency, d.product_url, d.url_override,
                d.product_key_override, d.name_override, d.store_override,
                d.category_override, d.excluded_reason, d.exclusion_restored,
                p.community, p.post_id, p.title, p.url AS post_url,
                p.status, p.status_override, p.last_seen_at,
                p.posted_at, p.first_seen_at, p.body_image_url
         FROM deals d
         JOIN posts p ON p.id = d.post_rowid
         WHERE d.id IN (${placeholders})`,
      )
      .all(...memberIds) as unknown as DealJoinRow[];

    const obsRows = db
      .prepare(
        `SELECT deal_rowid, observed_at, post_status,
                deal_price, currency, estimated_krw
         FROM price_observations
         WHERE deal_rowid IN (${placeholders})
         ORDER BY deal_rowid, observed_at`,
      )
      .all(...memberIds) as unknown as ObsRow[];

    const dealById = new Map<number, DealJoinRow>(
      dealRows.map((d) => [d.deal_id, d]),
    );

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

    const deadKeys = loadDeadKeys(db);

    const items: HistoryItem[] = [];
    /* 아이템과 인덱스 동기 — 썸네일 키 배치 조회용. */
    const imageKeys: (string | null)[] = [];

    for (const key of qualifyingKeys) {
      const memberIdsForKey = (dealsByKey.get(key) ?? []).map((m) => m.dealId);

      /*
       * 멤버별 노출 자격·표시값을 피드와 동일 기준으로 정리.
       * 소프트 제외 규칙(2차 방어)은 어드민 복원 딜엔 적용하지 않는다.
       */
      const members: Array<{
        deal: DealJoinRow;
        urlKey: string | null;
        status: PostStatus;
        points: PricePoint[];
      }> = [];

      for (const id of memberIdsForKey) {
        const deal = dealById.get(id);
        if (!deal) continue;

        /* 하드 제외(복원 아님)는 노출하지 않는다 — 피드와 동일. */
        if (deal.excluded_reason !== null) continue;

        const points = pointsByDeal.get(id) ?? [];
        const lastPrice = points.length
          ? points[points.length - 1].price
          : null;

        if (
          deal.exclusion_restored === 0 &&
          checkExclusion({
            community: deal.community,
            category: deal.category,
            title: deal.title,
            price: lastPrice,
          }).excluded
        ) {
          continue;
        }

        const { urlKey } = computeMergeKeys(deal, resolutions);
        const linkDead = urlKey !== null && deadKeys.has(urlKey);

        const status: PostStatus =
          deal.status_override === "active" || deal.status_override === "ended"
            ? deal.status_override
            : linkDead
              ? "ended"
              : toStatus(deal.status);

        members.push({ deal, urlKey, status, points });
      }

      if (members.length === 0) continue;

      /* 관측을 한 시리즈로 합쳐 시각순 정렬 (같은 상품이므로 통합). */
      const points = members
        .flatMap((m) => m.points)
        .slice()
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt));

      /* 소프트 제외 후 관측 2건 미만이면 이력 없음 — 스킵. */
      if (points.length < 2) continue;

      /* 대표 딜 정렬: 최신 확인 순, 같으면 게시판 내 순서. 피드와 동일. */
      const sortedMembers = [...members].sort(
        (a, b) =>
          b.deal.last_seen_at.localeCompare(a.deal.last_seen_at) ||
          a.deal.seq - b.deal.seq,
      );

      /* 대표 이름: 최신 멤버 중 이름 있는 것. */
      const named =
        sortedMembers.find(
          (m) => (m.deal.name_override ?? m.deal.product_name) !== null,
        ) ?? sortedMembers[0];

      /* 상태 합성: 하나라도 진행중이면 진행중 > 모름 > 전부 종료. */
      const status: PostStatus = members.some((m) => m.status === "active")
        ? "active"
        : members.some((m) => m.status === "unknown")
          ? "unknown"
          : "ended";

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
      const storeSource =
        sortedMembers.find(
          (m) => (m.deal.store_override ?? m.deal.store) !== null,
        ) ?? sortedMembers[0];
      const storeNorm = normalizeStore(
        storeSource.deal.store_override ?? storeSource.deal.store,
      );

      const catMember =
        sortedMembers.find(
          (m) => (m.deal.category_override ?? m.deal.category) !== null,
        ) ?? null;
      const catValue =
        (catMember?.deal.category_override ?? catMember?.deal.category) ?? null;
      const categoryNorm = ALL_NORM_CATEGORIES.includes(
        catValue as NormCategory,
      )
        ? (catValue as NormCategory)
        : normalizeCategory(
            catMember?.deal.community ?? named.deal.community,
            catValue,
            catMember?.deal.title ?? named.deal.title,
          );

      /* 구매링크: 링크 있는 멤버 중 최신 것 (피드의 linked와 동일). */
      const linked =
        sortedMembers.find(
          (m) => (m.deal.url_override ?? m.deal.product_url) !== null,
        ) ?? null;
      const effectiveUrl = linked
        ? (linked.deal.url_override ?? linked.deal.product_url)
        : null;

      /* 원문 랜딩 대상 = 게시 시각이 가장 이른 멤버 (피드의 firstSource). */
      const origin = [...members].sort((a, b) =>
        (a.deal.posted_at ?? a.deal.first_seen_at).localeCompare(
          b.deal.posted_at ?? b.deal.first_seen_at,
        ),
      )[0];

      const postedAt = origin.deal.posted_at ?? origin.deal.first_seen_at;

      const nameValue =
        cleanDisplayName(
          named.deal.name_override ?? named.deal.product_name ?? named.deal.title,
          storeNorm,
        ) ?? named.deal.title;

      /* 썸네일 키: 대표 URL 키 우선, 없으면 병합 키(post: 폴백 제외). */
      const repUrlKey =
        sortedMembers.find((m) => m.urlKey !== null)?.urlKey ?? null;
      const imageKey =
        repUrlKey ?? (key.startsWith("post:") ? null : key);

      items.push({
        dealId: named.deal.deal_id,
        key,
        memberDealIds: members.map((m) => m.deal.deal_id),
        name: nameValue,
        community: origin.deal.community,
        postTitle: origin.deal.title,
        sourceUrl: origin.deal.post_url,
        url: effectiveUrl,
        storeNorm,
        categoryNorm,
        status,
        currency: named.deal.currency,
        imageUrl: null,
        bodyImageUrl:
          origin.deal.body_image_url ??
          sortedMembers.find((m) => m.deal.body_image_url !== null)?.deal
            .body_image_url ??
          null,
        currentPrice,
        lowestPrice,
        highestPrice,
        changePct,
        atLowest:
          currentPrice !== null &&
          lowestPrice !== null &&
          currentPrice <= lowestPrice,
        points,
        postedAt,
        updatedAt: points[points.length - 1].observedAt,
      });
      imageKeys.push(imageKey);
    }

    /* 썸네일 일괄 조회 — 피드와 같은 캐시·오버라이드 합성. */
    const urlKeys = [...new Set(
      imageKeys.filter((k): k is string => k !== null),
    )];

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

      for (let i = 0; i < items.length; i += 1) {
        const key = imageKeys[i];

        if (key) {
          items[i].imageUrl = imgByKey.get(key) ?? null;
        }
      }
    }

    items.sort((a, b) => {
      if (sort === "drop") {
        /* 인하폭이 큰(= changePct가 더 음수인) 순. 변동 없음은 뒤로. */
        const diff = (a.changePct ?? 0) - (b.changePct ?? 0);
        if (diff !== 0) return diff;
      }

      /* 게시 시각 최신순 — 수집 시점이 아닌 글 게시 기준. */
      return b.postedAt.localeCompare(a.postedAt) || a.dealId - b.dealId;
    });

    const sliced = items.slice(0, limit);

    return { items: sliced, hasData: true, trackedCount, observationCount };
  } finally {
    db.close();
  }
}
