import { getDealFeed, hotScore, itemAgeMs, type ItemView } from "@/src/db/queries";
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
  sourceLabel,
  timeAgo,
} from "@/src/lib/format";

/*
 * 핫딜 실시간 순위 — 조회수+추천 가중 점수(hotScore) 기준 TOP 10.
 * 점수는 출처 게시글 stats 합산: 추천×1e8 + 조회수.
 * "실시간"은 수집 주기(2시간) 갱신 기준 — 매 요청 DB 재조회.
 *
 * 신선도 규칙(2026-08-28): 등록된 지 24시간이 지난 딜은 순위에서
 * 제외한다 — 묵은 바이럴 딜이 점수 누적만으로 상위권을 차지하는
 * 것을 막는다. 기준 시각 = 가장 이른 출처 게시 시각(없으면 첫
 * 적재 시각).
 *
 * 상태 규칙(2026-09-02): 종료(status='ended') 딜은 순위에서
 * 완전히 제외한다. "실시간" 페이지 특성상 지금 구매 가능한 딜만
 * 노출한다. 숨김(hidden) 딜은 getDealFeed가 deal 단위에서 이미
 * 거른다.
 *
 * 필터(2026-08-27 추가): 카테고리 + 쇼핑몰 칩 — 핫딜 모음과
 * 동일하게 쿼리스트링 기반 서버 렌더.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "핫딜 실시간 순위",
};

const TOP_N = 10;
const RANK_MAX_AGE_HOURS = 24;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

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

function commentsSum(item: ItemView): number {
  return item.sources.reduce((sum, s) => sum + (s.stats.comments ?? 0), 0);
}

function viewsSum(item: ItemView): number {
  return item.sources.reduce((sum, s) => sum + (s.stats.views ?? 0), 0);
}

export default async function RankingPage({ searchParams }: PageProps) {
  const raw = await searchParams;

  /* 어드민 로그인 사용자에게만 카드 수정 버튼 노출. */
  const viewer = await getAdminViewer();
  const adminMode = viewer.login !== null;

  const rawCat = firstParam(raw.cat);
  const rawStore = firstParam(raw.store);
  const rawCommunity = firstParam(raw.community);

  const category: NormCategory | null = (
    CATEGORIES as readonly string[]
  ).includes(rawCat ?? "")
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

  const { items, hasData } = getDealFeed({ category, store, community });

  const nowMs = Date.now();
  const ranked = [...items]
    .filter((i) => i.status !== "ended")
    .filter((i) => itemAgeMs(i, nowMs) < RANK_MAX_AGE_HOURS * 3_600_000)
    .sort((a, b) => hotScore(b) - hotScore(a))
    .slice(0, TOP_N);
  const maxScore = ranked.length > 0 ? hotScore(ranked[0]) : 0;

  const current: Record<string, string> = {};
  if (category) current.cat = category;
  if (store) current.store = store;
  if (community) current.community = community;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>핫딜 실시간 순위</h1>
          <p>
            조회수·추천·댓글 기반 TOP {TOP_N} — {RANK_MAX_AGE_HOURS}시간
            이내 딜만 집계하며, 수집 주기마다 갱신됩니다.
          </p>
        </div>
      </div>

      <section className="toolbar">
        <div className="frow">
          <span className="flabel">카테고리</span>
          <a
            className={category === null ? "fchip active" : "fchip"}
            href={hrefFor("/ranking", current, { cat: null })}
          >
            전체
          </a>
          {CATEGORIES.map((cat) => (
            <a
              key={cat}
              className={category === cat ? "fchip active" : "fchip"}
              href={hrefFor("/ranking", current, { cat })}
            >
              {cat}
            </a>
          ))}
        </div>

        <div className="frow">
          <span className="flabel">쇼핑몰</span>
          <a
            className={store === null ? "fchip logo active" : "fchip logo"}
            href={hrefFor("/ranking", current, { store: null })}
            title="전체"
          >
            <img src={STORE_FILTER_LOGOS["전체"]} alt="전체" />
          </a>
          {[...STORE_FILTERS, OTHER_STORE_FILTER].map((name) => (
            <a
              key={name}
              className={store === name ? "fchip logo active" : "fchip logo"}
              href={hrefFor("/ranking", current, { store: name })}
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
            href={hrefFor("/ranking", current, { community: null })}
            title="전체"
          >
            <img src={STORE_FILTER_LOGOS["전체"]} alt="전체" />
          </a>
          {COMMUNITIES.map((com) => (
            <a
              key={com}
              className={community === com ? "fchip logo active" : "fchip logo"}
              href={hrefFor("/ranking", current, { community: com })}
              title={sourceLabel(com)}
            >
              <img src={COMMUNITY_LOGOS[com]} alt={sourceLabel(com)} />
            </a>
          ))}
        </div>
      </section>

      {!hasData || ranked.length === 0 ? (
        <div className="empty">순위 데이터가 없습니다.</div>
      ) : (
        <div className="rank-table">
          <div className="rank-head">
            <span>순위</span>
            <span />
            <span>상품</span>
            <span className="c-price">가격</span>
            <span className="c-score">인기 점수</span>
            <span className="c-comments">댓글</span>
            <span className="c-time">등록 시간</span>
            <span />
          </div>

          {ranked.map((item, index) => {
            const score = hotScore(item);
            const pct =
              maxScore > 0
                ? Math.max(4, Math.round((score / maxScore) * 100))
                : 0;
            const rank = index + 1;
            const badgeClass =
              rank === 1
                ? "rank-badge r1"
                : rank === 2
                  ? "rank-badge r2"
                  : rank === 3
                    ? "rank-badge r3"
                    : "rank-badge";
            const logo = storeLogo(item.storeNorm);

            return (
              <div
                className={
                  item.status === "ended" ? "rank-row ended" : "rank-row"
                }
                key={item.key}
              >
                <span className={badgeClass}>{rank}</span>

                <div className="thumb sm">
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
                    <span>· {sourceLabel(item.firstSource.source)}</span>
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
                          <span className="name-qty">
                            {item.displayParts.quantity}
                          </span>
                        )}
                      </>
                    ) : (
                      item.displayName ?? item.firstSource.title
                    )}
                  </a>
                </div>

                <div className="c-price">
                  <span className="price">
                    {formatPrice(item.price, item.currency, item.priceText)}
                  </span>
                </div>

                <div
                  className="c-score"
                  title={`조회수 ${formatNumber(viewsSum(item))} · 추천 ${formatNumber(
                    item.sources.reduce(
                      (sum, s) => sum + (s.stats.recommendations ?? 0),
                      0,
                    ),
                  )} · 댓글 ${formatNumber(commentsSum(item))}`}
                >
                  <div className="score-bar">
                    <i style={{ width: `${pct}%` }} />
                  </div>
                </div>

                <span className="c-comments">
                  {formatNumber(commentsSum(item))}
                </span>
                <span className="c-time">
                  {timeAgo(item.postedAt ?? item.collectedAt)}
                </span>

                <span className="c-link">
                  <a
                    className="btn primary sm"
                    href={item.firstSource.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    원문링크
                  </a>
                  {adminMode && (
                    <AdminEditLink
                      dealId={item.firstSource.dealId}
                      className="btn ghost sm admin-edit"
                    />
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
