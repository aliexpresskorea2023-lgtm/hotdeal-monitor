import { Eye, MessageCircle } from "lucide-react";
import { type ItemView } from "@/src/db/queries";
import { getCachedDealFeed } from "@/src/db/cached";
import { getAdminViewer } from "@/src/lib/admin-viewer";
import { AdminEditLink } from "@/components/admin/edit-modal";
import {
  CATEGORIES,
  COMMUNITIES,
  COMMUNITY_LOGOS,
  OTHER_STORE_FILTER,
  STORE_FILTER_LOGOS,
  STORE_FILTERS,
  type Community,
  type NormCategory,
} from "@/src/db/taxonomy";
import { firstParam, hrefFor } from "@/src/lib/query";
import {
  formatNumber,
  formatPrice,
  formatTime,
  sourceLabel,
  statusLabel,
  timeAgo,
} from "@/src/lib/format";

/*
 * 데이터 소스: data/hotdeal.db (수집 파이프라인 적재분).
 * 매 요청마다 DB에서 새로 읽는다 — 2시간 주기 수집 결과가
 * 빌드/재시작 없이 바로 반영되도록 정적 생성은 끄고 간다.
 *
 * v1.0 레이아웃(2026-08-27): 사이드바 셸 + 스토어 로고 타일 로우.
 * 상품 썸네일은 수집하지 않으므로(결제/상품페이지 캡처본뿐)
 * 타일은 스토어 로고로 대체한다.
 *
 * 필터/정렬은 URL 쿼리스트링 기반(서버 컴포넌트, 클라이언트 JS 없음):
 *   /?cat=생활/식품&store=쿠팡&status=active&sort=hot&page=2
 * 기존 필터 체계(상태/정렬 + 카테고리 + 스토어 로고 칩)는 유지한다.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "핫딜 모음",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const PER_PAGE = 20;

function storeLogo(storeNorm: string | null): string {
  if (storeNorm && storeNorm in STORE_FILTER_LOGOS) {
    return STORE_FILTER_LOGOS[storeNorm];
  }
  return STORE_FILTER_LOGOS[OTHER_STORE_FILTER];
}

/** 원문 커뮤니티 로고 — 상품 이미지 폴백 체인의 2순위. */
function communityLogo(source: string): string | null {
  return (COMMUNITIES as readonly string[]).includes(source)
    ? COMMUNITY_LOGOS[source as Community]
    : null;
}

function statSums(item: ItemView) {
  let views = 0;
  let comments = 0;

  for (const source of item.sources) {
    views += source.stats.views ?? 0;
    comments += source.stats.comments ?? 0;
  }

  return { views, comments };
}

function pageList(total: number, current: number): (number | "…")[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const picked = new Set(
    [1, 2, current - 1, current, current + 1, total - 1, total].filter(
      (p) => p >= 1 && p <= total,
    ),
  );
  const sorted = [...picked].sort((a, b) => a - b);

  const out: (number | "…")[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push("…");
    out.push(p);
    prev = p;
  }
  return out;
}

function DealRow({
  item,
  adminMode,
}: {
  item: ItemView;
  adminMode: boolean;
}) {
  const { views, comments } = statSums(item);
  const logo = storeLogo(item.storeNorm);

  return (
    <article
      className={item.status === "ended" ? "deal-row ended" : "deal-row"}
    >
      <div className="thumb">
        <img
          src={
            item.imageUrl ??
            communityLogo(item.firstSource.source) ??
            logo
          }
          alt={item.storeNorm}
        />
      </div>

      <div className="row-grow">
        <div className="store-line">
          <img src={logo} alt="" />
          {item.storeNorm}
        </div>

        <a
          className="row-title"
          href={item.firstSource.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {item.displayParts ? (
            <>
              {item.displayParts.main}
              {item.displayParts.quantity && (
                <span className="name-qty">{item.displayParts.quantity}</span>
              )}
            </>
          ) : (
            item.displayName ?? item.firstSource.title
          )}
        </a>

        <div className="tagrow">
          <span className={item.status === "ended" ? "tag ended" : "tag live"}>
            {statusLabel(item.status)}
          </span>
          <span className="tag">{item.categoryNorm}</span>
          {item.shippingText && <span className="tag">{item.shippingText}</span>}
          {item.sources.map((source) => (
            <a
              key={source.id}
              className="tag src"
              href={source.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={source.title}
            >
              {sourceLabel(source.source)}
            </a>
          ))}
        </div>
      </div>

      <div className="rail">
        <span className="price">
          {formatPrice(item.price, item.currency, item.priceText)}
        </span>
        <span className="price-sub">
          {item.shippingText ?? "배송비 확인 필요"}
        </span>
        <div className="stats">
          <span>
            <Eye size={13} />
            {formatNumber(views)}
          </span>
          <span>
            <MessageCircle size={13} />
            {formatNumber(comments)}
          </span>
          <span>{timeAgo(item.postedAt ?? item.collectedAt)}</span>
        </div>
      </div>

      <div className="row-actions">
        <a
          className="btn primary"
          href={item.firstSource.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          원문링크
        </a>
        {item.url ? (
          <a
            className="btn ghost"
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            구매하기
          </a>
        ) : (
          <span className="btn ghost disabled" aria-disabled="true">
            구매하기
          </span>
        )}
        {adminMode && <AdminEditLink dealId={item.firstSource.dealId} />}
      </div>
    </article>
  );
}

export default async function Home({ searchParams }: PageProps) {
  const raw = await searchParams;

  /* 어드민 로그인 사용자에게만 카드 수정 버튼 노출. */
  const viewer = await getAdminViewer();
  const adminMode = viewer.login !== null;

  const rawCat = firstParam(raw.cat);
  const rawStore = firstParam(raw.store);
  const rawCommunity = firstParam(raw.community);
  const rawStatus = firstParam(raw.status);
  const rawSort = firstParam(raw.sort);
  const rawQ = firstParam(raw.q)?.trim() || null;
  const rawPage = Number.parseInt(firstParam(raw.page) ?? "1", 10);

  /* 전체 규모 표시용 전체 피드. 스토어 칩은 고정 목록. */
  const all = await getCachedDealFeed({});

  const category: NormCategory | null = (CATEGORIES as readonly string[]).includes(
    rawCat ?? "",
  )
    ? (rawCat as NormCategory)
    : null;
  const store =
    rawStore &&
    ((STORE_FILTERS as readonly string[]).includes(rawStore) ||
      rawStore === OTHER_STORE_FILTER)
      ? rawStore
      : null;
  const community =
    rawCommunity &&
    (COMMUNITIES as readonly string[]).includes(rawCommunity)
      ? rawCommunity
      : null;
  const status =
    rawStatus === "active" || rawStatus === "ended" ? rawStatus : "all";
  const sort = rawSort === "hot" || rawSort === "price" ? rawSort : "latest";

  const { items, hasData, lastIngestedAt } = await getCachedDealFeed({
    category,
    store,
    community,
    status,
    sort,
    q: rawQ,
  });

  const current: Record<string, string> = {};
  if (category) current.cat = category;
  if (store) current.store = store;
  if (community) current.community = community;
  if (status !== "all") current.status = status;
  if (sort !== "latest") current.sort = sort;
  if (rawQ) current.q = rawQ;

  const totalPages = Math.max(1, Math.ceil(items.length / PER_PAGE));
  const page = Math.min(Math.max(1, rawPage), totalPages);
  const visible = items.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const activeCount = items.filter((item) => item.status !== "ended").length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>핫딜 모음</h1>
          <p>
            {hasData && lastIngestedAt
              ? `마지막 적재 ${formatTime(lastIngestedAt)} · 2시간 주기 수집`
              : "수집 이력 없음"}
          </p>
        </div>
        <span className="head-count">
          {items.length}개 아이템 · 진행중 {activeCount}
        </span>
      </div>

      {/* 필터 — 기존 체계 유지: 검색 + 상태/정렬 + 카테고리 + 스토어 로고 칩 */}
      <section className="toolbar">
        <form className="searchbar" action="/" method="get" role="search">
          {category && <input type="hidden" name="cat" value={category} />}
          {store && <input type="hidden" name="store" value={store} />}
          {community && (
            <input type="hidden" name="community" value={community} />
          )}
          {status !== "all" && (
            <input type="hidden" name="status" value={status} />
          )}
          {sort !== "latest" && <input type="hidden" name="sort" value={sort} />}
          <input
            type="search"
            name="q"
            defaultValue={rawQ ?? ""}
            placeholder="상품명 검색 (예: 갤럭시, 샴푸, 멜론)"
            aria-label="상품명 검색"
          />
          <button type="submit">검색</button>
          {rawQ && (
            <a
              className="search-clear"
              href={hrefFor("/", current, { q: null })}
              title="검색 해제"
            >
              ✕
            </a>
          )}
        </form>

        <div className="frow">
          <span className="flabel">상태</span>
          <a className={status === "all" ? "fchip active" : "fchip"} href={hrefFor("/", current, { status: null })}>전체</a>
          <a className={status === "active" ? "fchip active" : "fchip"} href={hrefFor("/", current, { status: "active" })}>진행중</a>
          <a className={status === "ended" ? "fchip active" : "fchip"} href={hrefFor("/", current, { status: "ended" })}>종료</a>
          <span style={{ width: 14 }} />
          <span className="flabel">정렬</span>
          <a className={sort === "latest" ? "fchip active" : "fchip"} href={hrefFor("/", current, { sort: null })}>최신순</a>
          <a className={sort === "hot" ? "fchip active" : "fchip"} href={hrefFor("/", current, { sort: "hot" })}>인기순</a>
          <a className={sort === "price" ? "fchip active" : "fchip"} href={hrefFor("/", current, { sort: "price" })}>가격순</a>
        </div>

        <div className="frow">
          <span className="flabel">카테고리</span>
          <a className={category === null ? "fchip active" : "fchip"} href={hrefFor("/", current, { cat: null })}>전체</a>
          {CATEGORIES.map((cat) => (
            <a
              key={cat}
              className={category === cat ? "fchip active" : "fchip"}
              href={hrefFor("/", current, { cat })}
            >
              {cat}
            </a>
          ))}
        </div>

        <div className="frow">
          <span className="flabel">쇼핑몰</span>
          <a
            className={store === null ? "fchip logo active" : "fchip logo"}
            href={hrefFor("/", current, { store: null })}
            title="전체"
          >
            <img src={STORE_FILTER_LOGOS["전체"]} alt="전체" />
          </a>
          {[...STORE_FILTERS, OTHER_STORE_FILTER].map((name) => (
            <a
              key={name}
              className={store === name ? "fchip logo active" : "fchip logo"}
              href={hrefFor("/", current, { store: name })}
              title={name}
            >
              <img src={STORE_FILTER_LOGOS[name]} alt={name} />
            </a>
          ))}
        </div>

        <div className="frow">
          <span className="flabel">커뮤니티</span>
          <a
            className={community === null ? "fchip logo active" : "fchip logo"}
            href={hrefFor("/", current, { community: null })}
            title="전체"
          >
            <img src={STORE_FILTER_LOGOS["전체"]} alt="전체" />
          </a>
          {COMMUNITIES.map((com) => (
            <a
              key={com}
              className={community === com ? "fchip logo active" : "fchip logo"}
              href={hrefFor("/", current, { community: com })}
              title={sourceLabel(com)}
            >
              <img src={COMMUNITY_LOGOS[com]} alt={sourceLabel(com)} />
            </a>
          ))}
        </div>
      </section>

      {hasData ? (
        <section className="deal-list">
          {visible.map((item) => (
            <DealRow key={item.key} item={item} adminMode={adminMode} />
          ))}
        </section>
      ) : (
        <div className="empty">
          아직 표시할 데이터가 없습니다. 수집 파이프라인
          (collector/run-pipeline.sh)을 실행해 주세요.
        </div>
      )}

      {totalPages > 1 && (
        <nav className="pager">
          {page > 1 && (
            <a href={hrefFor("/", current, { page: page === 2 ? null : String(page - 1) })}>‹</a>
          )}
          {pageList(totalPages, page).map((p, i) =>
            p === "…" ? (
              <span key={`e${i}`}>…</span>
            ) : (
              <a
                key={p}
                className={p === page ? "on" : ""}
                href={hrefFor("/", current, { page: p === 1 ? null : String(p) })}
              >
                {p}
              </a>
            ),
          )}
          {page < totalPages && (
            <a href={hrefFor("/", current, { page: String(page + 1) })}>›</a>
          )}
        </nav>
      )}
    </>
  );
}
