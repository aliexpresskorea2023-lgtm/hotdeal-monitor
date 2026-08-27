import Link from "next/link";
import { getPriceHistory, type HistoryItem } from "@/src/db/history";
import { firstParam, hrefFor } from "@/src/lib/query";
import {
  formatNumber,
  formatPrice,
  formatTime,
  sourceLabel,
  statusLabel,
  timeAgo,
} from "@/src/lib/format";
import { SiteNav } from "@/components/site-nav";
import { PriceSpark } from "@/components/price-spark";

/*
 * 최저가 히스토리 — price_observations(append-only) 기반.
 * 가격/배송비/상태가 달라진 순간에만 관측이 쌓이므로,
 * 관측 2건 이상 = 값이 실제로 변한 딜만 여기 나온다.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "최저가 히스토리 · 핫딜 모니터",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function changeLabel(item: HistoryItem) {
  if (item.changePct === null) return null;

  const rounded = Math.round(item.changePct * 10) / 10;

  if (Math.abs(rounded) < 0.1) {
    return { text: "변동 없음", tone: "flat" as const };
  }

  return rounded < 0
    ? { text: `${Math.abs(rounded).toFixed(1)}% 인하`, tone: "down" as const }
    : { text: `${rounded.toFixed(1)}% 인상`, tone: "up" as const };
}

export default async function HistoryPage({ searchParams }: PageProps) {
  const raw = await searchParams;
  const sort = firstParam(raw.sort) === "drop" ? "drop" : "latest";

  const { items, hasData, trackedCount, observationCount } = getPriceHistory({
    sort,
  });

  const current: Record<string, string> = {};
  if (sort !== "latest") current.sort = sort;

  const lowestNow = items.filter((item) => item.atLowest).length;

  return (
    <>
      <SiteNav
        active="history"
        live={hasData}
        statusText={
          hasData ? `관측 ${formatNumber(observationCount)}건` : "관측 이력 없음"
        }
      />

      <main className="page">
        <header className="page-head">
          <div>
            <h1>최저가 히스토리</h1>
            <p>
              커뮤니티에 올라온 가격 관측을 시계열로 모았습니다. 값이 바뀐
              순간에만 기록이 쌓이므로, 아래 목록은 실제로 가격이 움직인
              상품입니다.
            </p>
          </div>

          <dl className="stat-cards">
            <div className="stat-card">
              <dt>변동 기록</dt>
              <dd>{formatNumber(items.length)}</dd>
            </div>
            <div className="stat-card">
              <dt>현재 최저가</dt>
              <dd>{formatNumber(lowestNow)}</dd>
            </div>
            <div className="stat-card">
              <dt>추적 상품</dt>
              <dd>{formatNumber(trackedCount)}</dd>
            </div>
          </dl>
        </header>

        <section className="filters" aria-label="정렬">
          <div className="filter-row filter-row-top">
            <div className="filter-group">
              <span className="filter-label">정렬</span>

              <div className="segment">
                <Link
                  href={hrefFor("/history", current, { sort: null })}
                  className={sort === "latest" ? "seg active" : "seg"}
                >
                  최근 변동순
                </Link>
                <Link
                  href={hrefFor("/history", current, { sort: "drop" })}
                  className={sort === "drop" ? "seg active" : "seg"}
                >
                  인하폭순
                </Link>
              </div>
            </div>
          </div>
        </section>

        {items.length > 0 ? (
          <section className="deal-list" aria-label="가격 변동 목록">
            {items.map((item) => {
              const change = changeLabel(item);
              const ended = item.status === "ended";

              return (
                <article
                  key={item.dealId}
                  className={ended ? "deal ended" : "deal"}
                >
                  <div className="deal-main">
                    <div className="deal-top">
                      <span className={ended ? "badge ended" : "badge live"}>
                        {statusLabel(item.status)}
                      </span>

                      <span className="badge cat">{item.categoryNorm}</span>

                      {item.atLowest && (
                        <span className="badge lowest">역대 최저</span>
                      )}

                      <span className="deal-time">
                        {timeAgo(item.updatedAt)} 갱신
                      </span>
                    </div>

                    <a
                      className="deal-title"
                      href={item.url ?? item.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {item.name}
                    </a>

                    <div className="deal-meta">
                      <span className="tag store">{item.storeNorm}</span>

                      <span className="tag">
                        관측 {formatNumber(item.points.length)}회
                      </span>

                      <span className="tag">
                        최저{" "}
                        {formatPrice(
                          item.lowestPrice,
                          item.currency,
                          item.lowestPrice === null
                            ? "-"
                            : String(item.lowestPrice),
                        )}
                      </span>

                      <span className="deal-sources">
                        <a
                          href={item.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={item.postTitle}
                        >
                          {sourceLabel(item.community)}
                        </a>
                      </span>
                    </div>
                  </div>

                  <div className="deal-side history-side">
                    <PriceSpark points={item.points} />

                    <div className="history-figures">
                      <div className="deal-price">
                        {formatPrice(
                          item.currentPrice,
                          item.currency,
                          item.currentPrice === null
                            ? "-"
                            : String(item.currentPrice),
                        )}
                      </div>

                      {change && (
                        <span className={`change ${change.tone}`}>
                          {change.text}
                        </span>
                      )}
                    </div>

                    <div className="history-updated">
                      {formatTime(item.updatedAt)}
                    </div>
                  </div>
                </article>
              );
            })}
          </section>
        ) : (
          <p className="empty">
            {hasData
              ? "아직 가격이 변동된 상품이 없습니다. 관측이 두 번 이상 쌓이면 여기에 히스토리가 나타납니다."
              : "가격 관측 이력이 없습니다. 수집 파이프라인(collector/run-pipeline.sh)을 몇 차례 실행하면 시계열이 쌓입니다."}
          </p>
        )}
      </main>
    </>
  );
}
