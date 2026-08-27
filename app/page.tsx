import { getDealFeed } from "@/src/db/queries";
import { CATEGORIES, OTHER_STORE_FILTER, STORE_FILTERS, type NormCategory } from "@/src/db/taxonomy";
import { firstParam } from "@/src/lib/query";
import { formatNumber, formatTime } from "@/src/lib/format";
import { SiteNav } from "@/components/site-nav";
import { FilterBar } from "@/components/filter-bar";
import { DealRow } from "@/components/deal-row";

/*
 * 데이터 소스: data/hotdeal.db (수집 파이프라인 적재분).
 * 매 요청마다 DB에서 새로 읽는다 — 2시간 주기 수집 결과가
 * 빌드/재시작 없이 바로 반영되도록 정적 생성은 끄고 간다.
 *
 * 표시 단위: 아이템 로우.
 * 같은 구매 URL의 딜은 커뮤니티 무관 1로우로 병합되고,
 * 로우 안에 출처 커뮤니티 링크가 붙는다.
 *
 * 필터/정렬은 URL 쿼리스트링 기반(서버 컴포넌트, 클라이언트 JS 없음):
 *   ?cat=생활/식품&store=쿠팡&status=active&sort=hot
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "특가 모음 · 핫딜 모니터",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Home({ searchParams }: PageProps) {
  const raw = await searchParams;

  const rawCat = firstParam(raw.cat);
  const rawStore = firstParam(raw.store);
  const rawStatus = firstParam(raw.status);
  const rawSort = firstParam(raw.sort);

  /* 전체 규모 표시용 전체 피드. 스토어 칩은 고정 목록. */
  const all = getDealFeed();

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
  const status =
    rawStatus === "active" || rawStatus === "ended" ? rawStatus : "all";
  const sort = rawSort === "hot" || rawSort === "price" ? rawSort : "latest";

  const { items, hasData, lastIngestedAt } = getDealFeed({
    category,
    store,
    status,
    sort,
  });

  const current: Record<string, string> = {};
  if (category) current.cat = category;
  if (store) current.store = store;
  if (status !== "all") current.status = status;
  if (sort !== "latest") current.sort = sort;

  const activeCount = items.filter((item) => item.status !== "ended").length;
  const filtered = category !== null || store !== null || status !== "all";

  return (
    <>
      <SiteNav
        active="deals"
        live={hasData}
        statusText={
          hasData
            ? lastIngestedAt
              ? `수집 ${formatTime(lastIngestedAt)}`
              : "수집 데이터 있음"
            : "수집 이력 없음"
        }
      />

      <main className="page">
        <header className="page-head">
          <div>
            <h1>특가 모음</h1>
            <p>
              펨코 · 뽐뿌 · 루리웹 · 퀘이사존 · 아카라이브의 특가 글을 상품
              단위로 합쳐 보여줍니다.
            </p>
          </div>

          <dl className="stat-cards">
            <div className="stat-card">
              <dt>{filtered ? "필터 결과" : "전체 상품"}</dt>
              <dd>{formatNumber(items.length)}</dd>
            </div>
            <div className="stat-card">
              <dt>진행중</dt>
              <dd>{formatNumber(activeCount)}</dd>
            </div>
            <div className="stat-card">
              <dt>수집 상품</dt>
              <dd>{formatNumber(all.items.length)}</dd>
            </div>
          </dl>
        </header>

        <FilterBar
          current={current}
          category={category}
          store={store}
          status={status}
          sort={sort}
        />

        {hasData && items.length > 0 && (
          <section className="deal-list" aria-label="특가 목록">
            {items.map((item) => (
              <DealRow key={item.key} item={item} />
            ))}
          </section>
        )}

        {hasData && items.length === 0 && (
          <p className="empty">
            조건에 맞는 특가가 없습니다. 필터를 넓혀 보세요.
          </p>
        )}

        {!hasData && (
          <p className="empty">
            아직 표시할 데이터가 없습니다. 수집 파이프라인
            (collector/run-pipeline.sh)을 실행해 주세요.
          </p>
        )}
      </main>
    </>
  );
}
