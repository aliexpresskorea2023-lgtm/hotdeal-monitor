import { getDealFeed, type ItemView } from "@/src/db/queries";
import { CATEGORIES, type NormCategory } from "@/src/db/taxonomy";

/*
 * 데이터 소스: data/hotdeal.db (수집 파이프라인 적재분).
 * 매 요청마다 DB에서 새로 읽는다 — 2시간 주기 수집 결과가
 * 빌드/재시작 없이 바로 반영되도록 정적 생성은 끄고 간다.
 *
 * 표시 단위: 아이템 카드(리스트 로우).
 * 같은 구매 URL의 딜은 커뮤니티 무관 1로우로 병합되고,
 * 로우 안에 출처 커뮤니티 링크가 붙는다.
 *
 * 필터/정렬은 URL 쿼리스트링 기반(서버 컴포넌트, 클라이언트 JS 없음):
 *   ?cat=생활/식품&store=쿠팡&status=active&sort=hot
 * 디자인은 라이트 모드 기준 — 다크 모드 토글은 추후 과제.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "HOTDEAL MONITOR",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function formatNumber(value: number | null) {
  if (value === null) return "-";
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatTime(dateString: string) {
  const date = new Date(dateString);

  return date.toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function timeAgo(dateString: string) {
  const diffMs = Date.now() - new Date(dateString).getTime();
  const minutes = Math.floor(diffMs / 60_000);

  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;

  return `${Math.floor(hours / 24)}일 전`;
}

function sourceLabel(source: string) {
  const labels: Record<string, string> = {
    fmkorea: "펨코",
    ppomppu: "뽐뿌",
    arca: "아카라이브",
    quasarzone: "퀘이사존",
    mlbpark: "MLB파크",
    theqoo: "더쿠",
    slrclub: "SLR클럽",
    ruliweb: "루리웹",
  };

  return labels[source] ?? source;
}

/** 임시 정책: 상태 모름은 진행중으로 노출. 종료 확인 건만 종료. */
function statusLabel(status: string) {
  if (status === "ended") return "종료";
  return "진행중";
}

function formatPrice(
  price: number | null,
  currency: string,
  priceText: string,
) {
  if (price === null) return "가격 확인 필요";

  if (currency === "USD") return `$${price.toFixed(2)}`;
  if (currency === "KRW") return `${formatNumber(price)}원`;

  // CNY 등 기타 통화는 파서가 남긴 원문 표기를 그대로 쓴다.
  return priceText;
}

function recSum(item: ItemView): number {
  return item.sources.reduce(
    (sum, s) => sum + (s.stats.recommendations ?? 0),
    0,
  );
}

function hrefFor(
  current: Record<string, string>,
  patch: Record<string, string | null>,
) {
  const next = new URLSearchParams();

  for (const [key, value] of Object.entries({ ...current, ...patch })) {
    if (value) next.set(key, value);
  }

  const qs = next.toString();

  return qs ? `/?${qs}` : "/";
}

function DealRow({ item }: { item: ItemView }) {
  const recommendations = recSum(item);

  return (
    <article className="deal-row">
      <div className="row-line1">
        <span
          className={
            item.status === "ended" ? "row-status ended" : "row-status"
          }
        >
          {statusLabel(item.status)}
        </span>

        <a
          className="row-title"
          href={item.url ?? item.firstSource.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {item.name ?? item.firstSource.title}
        </a>

        <span className="row-cat">{item.categoryNorm}</span>
      </div>

      <div className="row-line2">
        <span className="row-store">{item.storeNorm}</span>

        <span className="row-price">
          {formatPrice(item.price, item.currency, item.priceText)}
        </span>

        <span className="row-ship">
          {item.shippingText ?? "배송비 확인 필요"}
        </span>

        {recommendations > 0 && (
          <span className="row-rec">★ {formatNumber(recommendations)}</span>
        )}

        <a
          className="row-original"
          href={item.firstSource.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          원문 보기
        </a>

        <span className="row-time">
          {timeAgo(item.postedAt ?? item.collectedAt)}
        </span>

        <span className="row-sources">
          {item.sources.map((source) => (
            <a
              key={source.id}
              href={source.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={source.title}
            >
              {sourceLabel(source.source)}
            </a>
          ))}
        </span>
      </div>
    </article>
  );
}

export default async function Home({ searchParams }: PageProps) {
  const raw = await searchParams;

  const rawCat = first(raw.cat);
  const rawStore = first(raw.store);
  const rawStatus = first(raw.status);
  const rawSort = first(raw.sort);

  /* facets(스토어 칩 목록)용 전체 피드와 필터 적용 피드를 분리 조회. */
  const all = getDealFeed();

  const storeCounts = new Map<string, number>();
  for (const item of all.items) {
    storeCounts.set(
      item.storeNorm,
      (storeCounts.get(item.storeNorm) ?? 0) + 1,
    );
  }

  const topStores = [...storeCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([name]) => name);

  const category: NormCategory | null = (CATEGORIES as readonly string[])
    .includes(rawCat ?? "")
    ? (rawCat as NormCategory)
    : null;
  const store =
    rawStore && storeCounts.has(rawStore) ? rawStore : null;
  const status =
    rawStatus === "active" || rawStatus === "ended" ? rawStatus : "all";
  const sort =
    rawSort === "hot" || rawSort === "price" ? rawSort : "latest";

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

  const activeCount = items.filter(
    (item) => item.status !== "ended",
  ).length;

  return (
    <main className="page">
      {/* Header */}
      <header className="header">
        <div>
          <div className="eyebrow">SHOPPING INTELLIGENCE</div>

          <h1>HOTDEAL MONITOR</h1>

          <p>다양한 커뮤니티의 특가 정보를 한곳에서 확인하세요.</p>
        </div>

        <div className="header-status">
          <span className="status-dot" />
          {hasData
            ? `LIVE DATA${lastIngestedAt ? ` · 적재 ${formatTime(lastIngestedAt)}` : ""}`
            : "수집 이력 없음"}
        </div>
      </header>

      {/* Toolbar — 퀘이사존형: 상태/카테고리 탭 + 쇼핑 카테고리 칩 */}
      <section className="toolbar">
        <div className="tab-row">
          <div className="platform-tabs">
            <a
              className={status === "all" ? "active" : ""}
              href={hrefFor(current, { status: null })}
            >
              전체
            </a>
            <a
              className={status === "active" ? "active" : ""}
              href={hrefFor(current, { status: "active" })}
            >
              진행중
            </a>
            <a
              className={status === "ended" ? "active" : ""}
              href={hrefFor(current, { status: "ended" })}
            >
              종료
            </a>
          </div>

          <div className="platform-tabs">
            <a
              className={sort === "latest" ? "active" : ""}
              href={hrefFor(current, { sort: null })}
            >
              최신순
            </a>
            <a
              className={sort === "hot" ? "active" : ""}
              href={hrefFor(current, { sort: "hot" })}
            >
              인기순
            </a>
            <a
              className={sort === "price" ? "active" : ""}
              href={hrefFor(current, { sort: "price" })}
            >
              가격순
            </a>
          </div>
        </div>

        <div className="platform-tabs cat-tabs">
          <a
            className={category === null ? "active" : ""}
            href={hrefFor(current, { cat: null })}
          >
            전 카테고리
          </a>
          {CATEGORIES.map((cat) => (
            <a
              key={cat}
              className={category === cat ? "active" : ""}
              href={hrefFor(current, { cat })}
            >
              {cat}
            </a>
          ))}
        </div>

        <div className="chip-row">
          <span className="chip-label">쇼핑</span>
          <a
            className={store === null ? "chip active" : "chip"}
            href={hrefFor(current, { store: null })}
          >
            전체
          </a>
          {topStores.map((name) => (
            <a
              key={name}
              className={store === name ? "chip active" : "chip"}
              href={hrefFor(current, { store: name })}
            >
              {name}
            </a>
          ))}
        </div>
      </section>

      {/* Summary */}
      <section className="summary">
        <div>
          <strong>{items.length}</strong>
          <span>개의 아이템</span>
        </div>

        <div>
          <strong>{activeCount}</strong>
          <span>진행중</span>
        </div>

        <div>
          <strong>{all.items.length}</strong>
          <span>전체 아이템</span>
        </div>
      </section>

      {/* Deal Rows */}
      {hasData ? (
        <section className="deal-list">
          {items.map((item) => (
            <DealRow key={item.key} item={item} />
          ))}
        </section>
      ) : (
        <section className="summary">
          <div>
            <span>
              아직 표시할 데이터가 없습니다. 수집 파이프라인
              (collector/run-pipeline.sh)을 실행해 주세요.
            </span>
          </div>
        </section>
      )}
    </main>
  );
}
