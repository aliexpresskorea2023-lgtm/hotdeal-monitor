import type { ItemView } from "@/src/db/queries";
import {
  formatNumber,
  formatPrice,
  sourceLabel,
  statusLabel,
  timeAgo,
} from "@/src/lib/format";

/*
 * 아이템 한 줄. 왼쪽은 정체(제목·분류·출처), 오른쪽은 결정(가격·이동).
 * 가격과 액션을 오른쪽 레일로 모아 목록을 훑을 때 눈이 한 열만
 * 따라가면 되게 했다.
 */

function recSum(item: ItemView): number {
  return item.sources.reduce(
    (sum, source) => sum + (source.stats.recommendations ?? 0),
    0,
  );
}

export function DealRow({ item }: { item: ItemView }) {
  const recommendations = recSum(item);
  const ended = item.status === "ended";
  const titleHref = item.url ?? item.firstSource.sourceUrl;

  return (
    <article className={ended ? "deal ended" : "deal"} data-item-key={item.key}>
      <div className="deal-main">
        <div className="deal-top">
          <span className={ended ? "badge ended" : "badge live"}>
            {statusLabel(item.status)}
          </span>

          <span className="badge cat">{item.categoryNorm}</span>

          {item.merged && (
            <span className="badge merged">출처 {item.sources.length}곳</span>
          )}

          <span className="deal-time">
            {timeAgo(item.postedAt ?? item.collectedAt)}
          </span>
        </div>

        <a
          className="deal-title"
          href={titleHref}
          target="_blank"
          rel="noopener noreferrer"
        >
          {item.name ?? item.firstSource.title}
        </a>

        <div className="deal-meta">
          <span className="tag store">{item.storeNorm}</span>

          <span className="tag">
            {item.shippingText ?? "배송비 확인 필요"}
          </span>

          {recommendations > 0 && (
            <span className="tag rec">추천 {formatNumber(recommendations)}</span>
          )}

          <span className="deal-sources">
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
      </div>

      <div className="deal-side">
        <div className={item.price === null ? "deal-price none" : "deal-price"}>
          {formatPrice(item.price, item.currency, item.priceText)}
        </div>

        <div className="deal-actions">
          {item.url && (
            <a
              className="btn primary"
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              구매하기
            </a>
          )}

          <a
            className="btn ghost"
            href={item.firstSource.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            원문 보기
          </a>
        </div>
      </div>
    </article>
  );
}
