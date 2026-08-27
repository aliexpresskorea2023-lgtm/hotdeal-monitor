import { getDealFeed, type ItemView } from "@/src/db/queries";

/*
 * 데이터 소스: data/hotdeal.db (수집 파이프라인 적재분).
 * 매 요청마다 DB에서 새로 읽는다 — 2시간 주기 수집 결과가
 * 빌드/재시작 없이 바로 반영되도록 정적 생성은 끄고 간다.
 *
 * 표시 단위: 아이템 카드.
 * 같은 구매 URL의 딜은 커뮤니티와 무관하게 카드 1개로 병합되고,
 * 카드 안에 출처 게시글 목록이 붙는다. (병합 로직은
 * src/db/queries.ts — 디자인 변경 시 이 파일 마크업만 고치면 된다.)
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "HOTDEAL MONITOR",
};

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

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    active: "진행중",
    ended: "종료",
    unknown: "상태 확인 필요",
  };

  return labels[status] ?? status;
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

function ItemCard({ item }: { item: ItemView }) {
  return (
    <article className="deal-card" data-item-key={item.key}>
      {/* 상단 정보 */}
      <div className="deal-top">
        <div className="platform-badge">{item.store ?? "스토어 미상"}</div>

        <div className="deal-top-right">
          {item.merged && (
            <span className="merged-badge">
              커뮤니티 {item.sources.length}곳
            </span>
          )}

          <div className="hot-badge">{statusLabel(item.status)}</div>
        </div>
      </div>

      {/* 상품 정보 */}
      <div className="deal-content">
        <div className="deal-title-row">
          <h2>{item.name ?? "상품명 확인 필요"}</h2>

          {item.category && (
            <span className="normalized-name">{item.category}</span>
          )}
        </div>

        <div className="price-area">
          <div className="main-price">
            {formatPrice(item.price, item.currency, item.priceText)}
          </div>

          {item.merged && item.price !== null && (
            <div className="estimated-price">
              커뮤니티 {item.sources.length}곳 중 최저가
            </div>
          )}
        </div>

        {/* 배송비 */}
        <div className="condition-badge">
          {item.shippingText ?? "배송비 확인 필요"}
        </div>

        {/* 할인 정보 */}
        {item.discount.description && (
          <div className="discount-info">
            <span>할인 정보</span>
            <p>{item.discount.description}</p>
          </div>
        )}

        {/* 출처 게시글 목록 — 각 행은 원문 링크 */}
        <div className="source-list">
          {item.sources.map((source) => (
            <a
              key={source.id}
              className="source-row"
              href={source.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="source-platform">
                {sourceLabel(source.source)}
              </span>

              <span className="source-title">{source.title}</span>

              <span className="source-meta">
                {source.price !== null &&
                  formatPrice(
                    source.price,
                    source.currency,
                    source.priceText,
                  )}

                {source.stats.views !== null && (
                  <> · 조회 {formatNumber(source.stats.views)}</>
                )}

                {" · "}
                {formatTime(source.collectedAt)}
              </span>
            </a>
          ))}
        </div>
      </div>

      {/* 버튼 */}
      <div className="deal-actions">
        {item.url ? (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="primary-button"
          >
            구매 링크 ↗
          </a>
        ) : (
          <span className="secondary-button">구매 링크 없음</span>
        )}
      </div>

      {/* ID */}
      <div className="item-id">key: {item.key}</div>
    </article>
  );
}

export default function Home() {
  const { items, hasData, lastIngestedAt } = getDealFeed();

  const activeCount = items.filter(
    (item) => item.status === "active",
  ).length;
  const mergedCount = items.filter((item) => item.merged).length;
  const sourceCount = items.reduce(
    (sum, item) => sum + item.sources.length,
    0,
  );

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

      {/* Toolbar — 아직 미연결(표시만). 필터/정렬은 데이터 확인 후 구현 */}
      <section className="toolbar">
        <div className="platform-tabs">
          <button className="active">전체</button>
          <button>알리익스프레스</button>
          <button>쿠팡</button>
          <button>테무</button>
          <button>네이버</button>
        </div>

        <div className="toolbar-right">
          <select defaultValue="latest">
            <option value="latest">최신순</option>
            <option value="hot">인기순</option>
            <option value="price">가격순</option>
          </select>
        </div>
      </section>

      {/* Summary */}
      <section className="summary">
        <div>
          <strong>{items.length}</strong>
          <span>개의 아이템</span>
        </div>

        <div>
          <strong>{mergedCount}</strong>
          <span>멀티 커뮤니티</span>
        </div>

        <div>
          <strong>{sourceCount}</strong>
          <span>개의 원문</span>
        </div>

        <div>
          <strong>{activeCount}</strong>
          <span>진행중인 특가</span>
        </div>
      </section>

      {/* Item Cards */}
      {hasData ? (
        <section className="deal-list">
          {items.map((item) => (
            <ItemCard key={item.key} item={item} />
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
