import mockData from "@/data/mock/hotdeal_mock_dataset_v0.2.json";

type Post = (typeof mockData)[number];
/*
 * 실제 파서 데이터에서는 가격/상품명이 null일 수 있다.
 * (유형 E: "가격은 상품 페이지에서 확인", 상품명 추출 실패 등)
 * mock JSON 추론 타입은 number/string만 허용하므로 명시적으로 넓힌다.
 */
type Product = Omit<
  Post["products"][number],
  "price" | "name"
> & {
  price: number | null;
  name: string | null;
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

function ProductPrice({ product }: { product: Product }) {
  if (product.price === null) {
    return (
      <div className="price-area">
        <div className="main-price">
          가격 확인 필요
        </div>
      </div>
    );
  }

  if (product.currency === "USD") {
    return (
      <div className="price-area">
        <div className="main-price">
          ${product.price.toFixed(2)}
        </div>
      </div>
    );
  }

  return (
    <div className="price-area">
      <div className="main-price">
        {formatNumber(product.price)}원
      </div>
    </div>
  );
}

function ProductCard({
  post,
  product,
}: {
  post: Post;
  product: Product;
}) {
  const stats = post.stats;

  return (
    <article className="deal-card">
      {/* 상단 정보 */}
      <div className="deal-top">
        <div className="platform-badge">
          {product.store}
        </div>

        <div className="hot-badge">
          {statusLabel(post.status)}
        </div>
      </div>

      {/* 상품 정보 */}
      <div className="deal-content">
        <div className="deal-title-row">
          <h2>{product.name ?? "상품명 확인 필요"}</h2>

          {post.category && (
            <span className="normalized-name">
              {post.category}
            </span>
          )}
        </div>

        <ProductPrice product={product} />

        {/* 배송비 */}
        <div className="condition-badge">
          {product.shippingText}
        </div>

        {/* 게시글 메타 정보 */}
        <div className="deal-meta">
          <span>{sourceLabel(post.source)}</span>
          <span>·</span>
          <span>{formatTime(post.collectedAt)}</span>

          {stats.views !== null && (
            <>
              <span>·</span>
              <span>조회 {formatNumber(stats.views)}</span>
            </>
          )}

          {stats.comments !== null && (
            <>
              <span>·</span>
              <span>댓글 {formatNumber(stats.comments)}</span>
            </>
          )}
        </div>

        {/* 할인 정보 */}
        {post.discount.description && (
          <div className="discount-info">
            <span>할인 정보</span>
            <p>{post.discount.description}</p>
          </div>
        )}

        {/* 원문 제목 */}
        <div className="price-history">
          <div>
            <span>원문</span>
            <strong>{post.title}</strong>
          </div>
        </div>
      </div>

      {/* 버튼 */}
      <div className="deal-actions">
        <a
          href={post.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="secondary-button"
        >
          원문 보기 ↗
        </a>

        <a
          href={product.url}
          target="_blank"
          rel="noopener noreferrer"
          className="primary-button"
        >
          구매 링크 ↗
        </a>
      </div>

      {/* ID */}
      <div className="item-id">
        상품: {product.name ?? "상품명 확인 필요"}
      </div>
    </article>
  );
}

export default function Home() {
  const posts = mockData;

  /*
   * 게시글을 상품 단위로 펼친다.
   *
   * 예:
   * 펨코 글 1개
   * ├─ TINHIFI C1
   * ├─ LUN SHENG RING
   * └─ TINHIFI HUO
   *
   * → 카드 3개
   */
  const productItems = posts.flatMap((post) =>
    post.products.map((product) => ({
      post,
      product,
    }))
  );

  const activeCount = posts.filter(
    (post) => post.status === "active"
  ).length;

  return (
    <main className="page">
      {/* Header */}
      <header className="header">
        <div>
          <div className="eyebrow">
            SHOPPING INTELLIGENCE
          </div>

          <h1>HOTDEAL MONITOR</h1>

          <p>
            다양한 커뮤니티의 특가 정보를 한곳에서 확인하세요.
          </p>
        </div>

        <div className="header-status">
          <span className="status-dot" />
          MOCK DATA
        </div>
      </header>

      {/* Toolbar */}
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
          <strong>{productItems.length}</strong>
          <span>개의 상품</span>
        </div>

        <div>
          <strong>{posts.length}</strong>
          <span>개의 원문</span>
        </div>

        <div>
          <strong>{activeCount}</strong>
          <span>진행중인 특가</span>
        </div>
      </section>

      {/* Product Cards */}
      <section className="deal-list">
        {productItems.map(({ post, product }, index) => (
          <ProductCard
            key={`${post.id}-${index}`}
            post={post}
            product={product}
          />
        ))}
      </section>
    </main>
  );
}