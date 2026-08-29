import { DEFAULT_DB_PATH, openDbReadOnly } from "./index";
import { productKeyFromUrl, type PostStatus } from "./queries";

/*
 * 어드민 읽기 쿼리 — 공개 피드(queries.ts)와 분리.
 *
 * 공개 피드는 아이템 병합 뷰지만, 어드민은 행 단위(게시글 내
 * 상품 1개 = 1행)로 보여준다. 수동 수정이 deals 행에 걸리기
 * 때문에 편집 대상과 표시 단위를 맞춘다.
 */

export interface AdminDealRow {
  dealId: number;
  seq: number;
  community: string;
  postId: string;
  postUrl: string;
  postTitle: string;
  postStatus: string;
  postStatusOverride: string | null;
  postHidden: number;

  productName: string | null;
  nameOverride: string | null;
  dealPrice: number | null;
  priceOverride: number | null;
  priceText: string;
  currency: string;
  category: string | null;
  categoryOverride: string | null;
  store: string | null;
  storeOverride: string | null;
  productUrl: string | null;
  urlType: string;
  /** 구매링크 수동 지정 (노출·상품 키 우선값). */
  urlOverride: string | null;

  hidden: number;
  excludedReason: string | null;
  exclusionRestored: number;

  lastSeenAt: string;
  views: number | null;
  recommendations: number | null;

  /** URL 기반 상품 키 (썸네일 키). 링크 없으면 null. */
  productKey: string | null;
  imageUrl: string | null;
  imageOverride: string | null;
}

export interface AdminListOptions {
  q?: string | null;
  status?: "all" | "active" | "ended";
  community?: string | null;
  /** 숨김·제외 포함 여부 (어드민 기본 포함). */
  includeHidden?: boolean;
  /** 제외 딜만 보기. */
  excludedOnly?: boolean;
  /** 오버라이드 있는 딜만. */
  overriddenOnly?: boolean;
  /** 카테고리 미지정(기타 처리 전)만. */
  uncategorizedOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export interface AdminListResult {
  rows: AdminDealRow[];
  total: number;
  page: number;
  pageSize: number;
}

function toRow(r: Record<string, unknown>): AdminDealRow {
  const productUrl = r.product_url as string | null;
  const urlOverride = (r.url_override as string | null) ?? null;
  /* 상품 키는 수동 지정 링크 우선 — 공개 피드와 동일 기준. */
  const effectiveUrl = urlOverride ?? productUrl;

  return {
    dealId: r.deal_id as number,
    seq: r.seq as number,
    community: r.community as string,
    postId: r.post_id as string,
    postUrl: r.url as string,
    postTitle: r.title as string,
    postStatus: r.status as string,
    postStatusOverride: r.status_override as string | null,
    postHidden: r.post_hidden as number,

    productName: r.product_name as string | null,
    nameOverride: r.name_override as string | null,
    dealPrice: r.deal_price as number | null,
    priceOverride: r.price_override as number | null,
    priceText: r.price_text as string,
    currency: r.currency as string,
    category: r.category as string | null,
    categoryOverride: r.category_override as string | null,
    store: r.store as string | null,
    storeOverride: r.store_override as string | null,
    productUrl,
    urlType: r.url_type as string,
    urlOverride,

    hidden: r.hidden as number,
    excludedReason: r.excluded_reason as string | null,
    exclusionRestored: r.exclusion_restored as number,

    lastSeenAt: r.last_seen_at as string,
    views: r.views as number | null,
    recommendations: r.recommendations as number | null,

    productKey: effectiveUrl ? productKeyFromUrl(effectiveUrl) : null,
    imageUrl: null,
    imageOverride: null,
  };
}

const BASE_SELECT = `
  SELECT d.id AS deal_id, d.seq,
         p.community, p.post_id, p.url, p.title, p.status,
         p.status_override, p.hidden AS post_hidden,
         d.product_name, d.name_override, d.deal_price, d.price_override,
         d.price_text, d.currency, d.category, d.category_override,
         d.store, d.store_override, d.product_url, d.url_type,
         d.url_override,
         d.hidden, d.excluded_reason, d.exclusion_restored,
         p.last_seen_at, p.views, p.recommendations
  FROM deals d
  JOIN posts p ON p.id = d.post_rowid`;

export function listAdminDeals(
  options: AdminListOptions = {},
  dbPath: string = DEFAULT_DB_PATH,
): AdminListResult {
  const db = openDbReadOnly(dbPath);
  if (!db) return { rows: [], total: 0, page: 1, pageSize: 50 };

  try {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (!options.includeHidden) {
      where.push("d.hidden = 0 AND p.hidden = 0");
    }

    if (options.excludedOnly) {
      /* 복원 시 excluded_reason이 지워지므로 복원 마커도 포함해야
         복원 철회(재제외) 입구가 사라지지 않는다. */
      where.push("(d.excluded_reason IS NOT NULL OR d.exclusion_restored = 1)");
    }

    if (options.overriddenOnly) {
      where.push(
        `(d.name_override IS NOT NULL OR d.price_override IS NOT NULL
          OR d.category_override IS NOT NULL OR d.store_override IS NOT NULL
          OR d.url_override IS NOT NULL)`,
      );
    }

    if (options.uncategorizedOnly) {
      where.push(
        `COALESCE(d.category_override, d.category) IS NULL
         AND d.excluded_reason IS NULL`,
      );
    }

    if (options.status === "active") {
      where.push(`COALESCE(p.status_override, p.status) != 'ended'`);
    } else if (options.status === "ended") {
      where.push(`COALESCE(p.status_override, p.status) = 'ended'`);
    }

    if (options.community) {
      where.push("p.community = ?");
      params.push(options.community);
    }

    if (options.q) {
      const needle = options.q.trim();

      if (needle.length > 0) {
        where.push(
          `(COALESCE(d.name_override, d.product_name) LIKE ?
            OR p.title LIKE ?)`,
        );
        params.push(`%${needle}%`, `%${needle}%`);
      }
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM deals d JOIN posts p ON p.id = d.post_rowid ${whereSql}`)
      .get(...params) as { n: number };

    const pageSize = options.pageSize ?? 50;
    const page = Math.max(1, options.page ?? 1);

    const raw = db
      .prepare(
        `${BASE_SELECT} ${whereSql}
         ORDER BY p.last_seen_at DESC, d.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as Record<
      string,
      unknown
    >[];

    const rows = raw.map(toRow);

    attachImages(db, rows);

    return { rows, total: totalRow.n, page, pageSize };
  } finally {
    db.close();
  }
}

/** 목록 행에 썸네일(수동 지정 우선)을 붙인다. */
function attachImages(
  db: ReturnType<typeof openDbReadOnly> & object,
  rows: AdminDealRow[],
): void {
  const keys = [...new Set(rows.map((r) => r.productKey).filter(
    (k): k is string => k !== null,
  ))];

  if (keys.length === 0) return;

  const ph = keys.map(() => "?").join(", ");
  const imgRows = db
    .prepare(
      `SELECT product_key, image_url, image_override
       FROM product_images WHERE product_key IN (${ph})`,
    )
    .all(...keys) as {
    product_key: string;
    image_url: string;
    image_override: string | null;
  }[];

  const byKey = new Map(imgRows.map((r) => [r.product_key, r]));

  for (const row of rows) {
    if (!row.productKey) continue;

    const img = byKey.get(row.productKey);
    if (!img) continue;

    row.imageOverride = img.image_override;
    row.imageUrl =
      img.image_override ?? (img.image_url !== "" ? img.image_url : null);
  }
}

export interface AdminObservationRow {
  id: number;
  observedAt: string;
  postStatus: string;
  dealPrice: number | null;
  currency: string | null;
  estimatedKrw: number | null;
  shipping: number | null;
}

export interface AdminThumbnailRow {
  productKey: string;
  /** 대표 상품명 (이 키에 걸린 딜 중 최신 것). */
  name: string | null;
  store: string | null;
  community: string;
  postUrl: string;
  productUrl: string;
  imageUrl: string | null;
  imageOverride: string | null;
  attempts: number;
  lastSeenAt: string;
  /** 대표 딜 게시글의 상태 (수동 고정 우선). 종료 딜 선별용. */
  status: PostStatus;
}

export type ThumbnailView = "all" | "missing" | "cached" | "override";
/** 종료 여부 선별 — 썸네일 수동 지정은 진행중 딜 위주로 하려고. */
export type ThumbnailStatusFilter = "all" | "active" | "ended";

export interface ThumbnailListOptions {
  view?: ThumbnailView;
  status?: ThumbnailStatusFilter;
  page?: number;
  pageSize?: number;
}

function matchesView(row: AdminThumbnailRow, view: ThumbnailView): boolean {
  switch (view) {
    case "override":
      return row.imageOverride !== null;
    case "cached":
      return row.imageOverride === null && row.imageUrl !== null;
    case "missing":
      return row.imageOverride === null && row.imageUrl === null;
    default:
      return true;
  }
}

function matchesStatus(
  row: AdminThumbnailRow,
  status: ThumbnailStatusFilter,
): boolean {
  if (status === "active") return row.status !== "ended";
  if (status === "ended") return row.status === "ended";
  return true;
}

/** 상태별 상품 키 수 — 화면 탭 카운트용 (딜 상태 필터 적용 후). */
export function countThumbnails(
  status: ThumbnailStatusFilter = "all",
  dbPath: string = DEFAULT_DB_PATH,
): Record<ThumbnailView, number> {
  const all = buildThumbnailRows(dbPath).filter((r) =>
    matchesStatus(r, status),
  );

  return {
    all: all.length,
    missing: all.filter((r) => matchesView(r, "missing")).length,
    cached: all.filter((r) => matchesView(r, "cached")).length,
    override: all.filter((r) => matchesView(r, "override")).length,
  };
}

/**
 * 썸네일 관리 목록 — 구매링크 있는 딜을 상품 키 단위로 묶어
 * 캐시 상태와 함께 보여준다. 최신 딜 순. 상태 필터·페이지네이션.
 */
export function listThumbnails(
  options: ThumbnailListOptions = {},
  dbPath: string = DEFAULT_DB_PATH,
): { rows: AdminThumbnailRow[]; total: number; page: number; pageSize: number } {
  const view = options.view ?? "all";
  const status = options.status ?? "all";
  const pageSize = options.pageSize ?? 50;
  const page = Math.max(1, options.page ?? 1);

  const filtered = buildThumbnailRows(dbPath).filter(
    (r) => matchesView(r, view) && matchesStatus(r, status),
  );

  return {
    rows: filtered.slice((page - 1) * pageSize, page * pageSize),
    total: filtered.length,
    page,
    pageSize,
  };
}

/** 구매링크 있는 딜을 상품 키 단위로 묶어 캐시를 붙인다 (최신 순). */
function buildThumbnailRows(dbPath: string): AdminThumbnailRow[] {
  const db = openDbReadOnly(dbPath);
  if (!db) return [];

  try {
    const raw = db
      .prepare(
        `SELECT d.product_url AS product_url, d.url_override AS url_override,
                COALESCE(d.name_override, d.product_name) AS name,
                COALESCE(d.store_override, d.store) AS store,
                p.community, p.url AS post_url, p.last_seen_at,
                p.status AS post_status, p.status_override AS post_status_override
         FROM deals d
         JOIN posts p ON p.id = d.post_rowid
         WHERE COALESCE(d.url_override, d.product_url) IS NOT NULL
           AND d.excluded_reason IS NULL
           AND d.hidden = 0 AND p.hidden = 0
         ORDER BY p.last_seen_at DESC`,
      )
      .all() as Array<{
      product_url: string | null;
      url_override: string | null;
      name: string | null;
      store: string | null;
      community: string;
      post_url: string;
      last_seen_at: string;
      post_status: string;
      post_status_override: string | null;
    }>;

    const rows = new Map<string, AdminThumbnailRow>();

    for (const r of raw) {
      const effectiveUrl = r.url_override ?? r.product_url;
      if (!effectiveUrl) continue;

      const key = productKeyFromUrl(effectiveUrl);
      if (!key || rows.has(key)) continue;

      /* 수동 고정이 수집기 판정보다 우선 — 공개 피드와 동일. */
      const status: PostStatus =
        r.post_status_override === "active" || r.post_status_override === "ended"
          ? r.post_status_override
          : r.post_status === "active" || r.post_status === "ended"
            ? r.post_status
            : "unknown";

      rows.set(key, {
        productKey: key,
        name: r.name,
        store: r.store,
        community: r.community,
        postUrl: r.post_url,
        productUrl: effectiveUrl,
        imageUrl: null,
        imageOverride: null,
        attempts: 0,
        lastSeenAt: r.last_seen_at,
        status,
      });
    }

    const keys = [...rows.keys()];

    if (keys.length > 0) {
      /* 키가 많아도 IN 절 한 번 — 로컬 어드민 규모라 무방. */
      const ph = keys.map(() => "?").join(", ");
      const imgs = db
        .prepare(
          `SELECT product_key, image_url, image_override, attempts
           FROM product_images WHERE product_key IN (${ph})`,
        )
        .all(...keys) as Array<{
        product_key: string;
        image_url: string;
        image_override: string | null;
        attempts: number;
      }>;

      for (const img of imgs) {
        const row = rows.get(img.product_key);
        if (!row) continue;

        row.imageOverride = img.image_override;
        row.imageUrl =
          img.image_url !== "" ? img.image_url : null;
        row.attempts = img.attempts;
      }
    }

    return [...rows.values()];
  } finally {
    db.close();
  }
}

export interface AdminDealDetail extends AdminDealRow {
  postRowid: number;
  postedAt: string | null;
  firstSeenAt: string;
  snapshotPath: string | null;
  comments: number | null;
  observations: AdminObservationRow[];
  /** 같은 게시글의 다른 딜 (1게시글 N상품 탐색용). */
  siblings: Array<{ dealId: number; name: string | null }>;
}

/** 딜 상세 — 편집 화면용. */
export function getAdminDeal(
  dealId: number,
  dbPath: string = DEFAULT_DB_PATH,
): AdminDealDetail | null {
  const db = openDbReadOnly(dbPath);
  if (!db) return null;

  try {
    const raw = db
      .prepare(
        `SELECT d.id AS deal_id, d.seq, d.post_rowid,
                p.community, p.post_id, p.url, p.title, p.status,
                p.status_override, p.hidden AS post_hidden,
                p.posted_at, p.first_seen_at, p.snapshot_path, p.comments,
                d.product_name, d.name_override, d.deal_price, d.price_override,
                d.price_text, d.currency, d.category, d.category_override,
                d.store, d.store_override, d.product_url, d.url_type,
                d.url_override,
                d.hidden, d.excluded_reason, d.exclusion_restored,
                p.last_seen_at, p.views, p.recommendations
         FROM deals d
         JOIN posts p ON p.id = d.post_rowid
         WHERE d.id = ?`,
      )
      .get(dealId) as Record<string, unknown> | undefined;

    if (!raw) return null;

    const base = toRow(raw);

    const obs = db
      .prepare(
        `SELECT id, observed_at, post_status, deal_price, currency,
                estimated_krw, shipping
         FROM price_observations
         WHERE deal_rowid = ?
         ORDER BY observed_at ASC, id ASC`,
      )
      .all(dealId) as Array<{
      id: number;
      observed_at: string;
      post_status: string;
      deal_price: number | null;
      currency: string | null;
      estimated_krw: number | null;
      shipping: number | null;
    }>;

    const siblings = db
      .prepare(
        `SELECT id, COALESCE(name_override, product_name) AS name
         FROM deals
         WHERE post_rowid = ? AND id != ?
         ORDER BY seq`,
      )
      .all(raw.post_rowid as number, dealId) as Array<{
      id: number;
      name: string | null;
    }>;

    attachImages(db, [base]);

    return {
      ...base,
      postRowid: raw.post_rowid as number,
      postedAt: raw.posted_at as string | null,
      firstSeenAt: raw.first_seen_at as string,
      snapshotPath: raw.snapshot_path as string | null,
      comments: raw.comments as number | null,
      observations: obs.map((o) => ({
        id: o.id,
        observedAt: o.observed_at,
        postStatus: o.post_status,
        dealPrice: o.deal_price,
        currency: o.currency,
        estimatedKrw: o.estimated_krw,
        shipping: o.shipping,
      })),
      siblings: siblings.map((s) => ({ dealId: s.id, name: s.name })),
    };
  } finally {
    db.close();
  }
}
