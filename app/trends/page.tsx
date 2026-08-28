import Link from "next/link";
import {
  TREND_CATEGORIES,
  TREND_CHART_LABEL,
  getTrendKeywords,
  getTrendWeeks,
  type TrendChartType,
  type TrendKeywordView,
  type TrendStatus,
} from "@/src/db/trends";
import { firstParam, hrefFor } from "@/src/lib/query";
import { formatNumber } from "@/src/lib/format";
import { TrendWeekSelect } from "@/components/trend-week-select";

/*
 * 네이버 키워드 트렌드 (2026-08-28, v1.7) — 단일 페이지.
 *
 * 출처는 snxbest.naver.com 공식 주간 쇼핑 키워드 랭킹.
 * 차트 2종(인기/급상승) × 주차 드롭다운 × 카테고리 칩 필터.
 * 관련 기사수는 Google News RSS(상한 100), 검색량은 네이버
 * 검색광고 키워드도구, 유튜브수는 YouTube Data API — 후자 둘은
 * 키가 있어야 채워진다(없으면 '—' 표시).
 *
 * 데이터는 파이프라인이 수집한 주간 스냅샷 — 매 요청 DB 재조회.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "네이버 키워드 트렌드",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const STATUS_META: Record<
  TrendStatus,
  { label: string; cls: string }
> = {
  STABLE: { label: "유지", cls: "stable" },
  NEW: { label: "신규", cls: "new" },
  UP: { label: "상승", cls: "up" },
  DOWN: { label: "하락", cls: "down" },
  SOAR: { label: "급상승", cls: "soar" },
};

/** RSS 상한이 100건이라 꼭짓값은 '100+'로 표기한다. */
function newsCountLabel(count: number | null): string {
  if (count === null) return "—";
  return count >= 100 ? "100+" : String(count);
}

function qcLabel(count: number | null): string {
  return count === null ? "—" : formatNumber(count);
}

function DeltaBadge({
  status,
  fluctuation,
}: {
  status: TrendStatus;
  fluctuation: number;
}) {
  const meta = STATUS_META[status] ?? STATUS_META.STABLE;
  const text =
    status === "UP"
      ? `▲${fluctuation}`
      : status === "DOWN"
        ? `▼${fluctuation}`
        : status === "STABLE"
          ? "―"
          : meta.label;

  return <span className={`t-badge t-${meta.cls}`}>{text}</span>;
}

function RankBadge({ rank }: { rank: number }) {
  const cls = rank <= 3 ? ` r${rank}` : "";

  return <span className={`rank-badge${cls}`}>{rank}</span>;
}

function MetricList({ row }: { row: TrendKeywordView }) {
  return (
    <dl className="trend-metrics">
      <div>
        <dt>검색량(월)</dt>
        <dd>{qcLabel(row.mobileQc)}</dd>
      </div>
      <div>
        <dt>관련 기사</dt>
        <dd>{newsCountLabel(row.newsCount)}</dd>
      </div>
      <div>
        <dt>유튜브</dt>
        <dd>{qcLabel(row.youtubeCount)}</dd>
      </div>
    </dl>
  );
}

export default async function TrendsPage({ searchParams }: PageProps) {
  const raw = await searchParams;

  const chartType: TrendChartType =
    firstParam(raw.type) === "new" ? "new" : "popular";

  const rawCat = firstParam(raw.cat);
  /* 급상승 차트는 사이트가 전체('A') 카테고리만 제공한다. */
  const categoryOptions =
    chartType === "new" ? TREND_CATEGORIES.slice(0, 1) : TREND_CATEGORIES;
  const categoryId = categoryOptions.some((c) => c.id === rawCat)
    ? (rawCat as string)
    : "A";

  const weeks = getTrendWeeks(chartType);

  if (weeks.length === 0) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>네이버 키워드 트렌드</h1>
            <p>네이버 쇼핑 주간 키워드 랭킹 — 수집 주기마다 갱신됩니다.</p>
          </div>
        </div>
        <div className="empty-note">
          아직 수집된 트렌드 데이터가 없습니다. 수집 파이프라인이 한 바퀴
          돌면 여기에 주간 랭킹이 표시됩니다.
        </div>
      </>
    );
  }

  const rawYmd = firstParam(raw.ymd);
  const selected = weeks.find((w) => w.ymd === rawYmd) ?? weeks[0];

  const rows = getTrendKeywords({
    chartType,
    ymd: selected.ymd,
    categoryId,
  });

  const current: Record<string, string> = {
    type: chartType,
    cat: categoryId,
    ymd: selected.ymd,
  };

  const categoryName =
    TREND_CATEGORIES.find((c) => c.id === categoryId)?.name ?? "전체";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>네이버 키워드 트렌드</h1>
          <p>
            네이버 쇼핑 주간 {TREND_CHART_LABEL[chartType]} 랭킹 — 수집
            주기마다 갱신됩니다.
          </p>
        </div>
        <span className="head-count">
          {selected.label} · {categoryName} · {rows.length}개 키워드
        </span>
      </div>

      <div className="toolbar">
        <div className="frow">
          <span className="flabel">차트</span>
          {(["popular", "new"] as const).map((type) => (
            <Link
              key={type}
              className={
                type === chartType ? "fchip active" : "fchip"
              }
              href={hrefFor("/trends", current, {
                type,
                ymd: null,
              })}
            >
              {TREND_CHART_LABEL[type]}
            </Link>
          ))}
        </div>

        <div className="frow">
          <span className="flabel">기간</span>
          <TrendWeekSelect
            weeks={weeks}
            currentYmd={selected.ymd}
            chartType={chartType}
            categoryId={categoryId}
          />
        </div>

        <div className="frow">
          <span className="flabel">카테고리</span>
          {categoryOptions.map((cat) => (
            <Link
              key={cat.id}
              className={
                cat.id === categoryId ? "fchip active" : "fchip"
              }
              href={hrefFor("/trends", current, { cat: cat.id })}
            >
              {cat.name}
            </Link>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty-note">
          이 주차·카테고리의 랭킹 데이터가 없습니다. 다른 주차나
          카테고리를 선택해 보세요.
        </div>
      ) : (
        <>
          {/* 주간 랭킹 대시보드 */}
          <section className="trend-table" aria-label="주간 랭킹">
            <div className="trend-head">
              <span>순위</span>
              <span>키워드</span>
              <span className="c-num">검색량(월)</span>
              <span className="c-num">관련 기사</span>
              <span className="c-num">유튜브</span>
              <span className="c-delta">전주 대비</span>
            </div>

            {rows.map((row) => (
              <div className="trend-row" key={`${row.rank}-${row.keyword}`}>
                <RankBadge rank={row.rank} />
                <span className="trend-keyword">
                  <strong>{row.keyword}</strong>
                  {row.subTitle && <small>{row.subTitle}</small>}
                </span>
                <span className="c-num">{qcLabel(row.mobileQc)}</span>
                <span className="c-num">{newsCountLabel(row.newsCount)}</span>
                <span className="c-num">{qcLabel(row.youtubeCount)}</span>
                <span className="c-delta">
                  <DeltaBadge
                    status={row.status}
                    fluctuation={row.fluctuation}
                  />
                </span>
              </div>
            ))}
          </section>

          {/* 키워드 카드 */}
          <section aria-label="키워드 카드">
            <h2 className="section-title">키워드 카드</h2>
            <div className="trend-cards">
              {rows.map((row) => (
                <article className="trend-card" key={row.keyword}>
                  <div className="trend-card-head">
                    <RankBadge rank={row.rank} />
                    <div className="trend-card-title">
                      <h3>{row.keyword}</h3>
                      {row.subTitle && <p>{row.subTitle}</p>}
                    </div>
                    <DeltaBadge
                      status={row.status}
                      fluctuation={row.fluctuation}
                    />
                  </div>

                  <MetricList row={row} />

                  <details className="trend-detail">
                    <summary>자세히 보기</summary>
                    <div className="trend-detail-body">
                      {row.newsSample.length > 0 && (
                        <ul className="news-sample">
                          {row.newsSample.map((news) => (
                            <li key={news.link ?? news.title}>
                              {news.link ? (
                                <a
                                  href={news.link}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {news.title}
                                </a>
                              ) : (
                                news.title
                              )}
                              {news.source && (
                                <span className="news-source">
                                  {news.source}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="qc-detail">
                        검색량(월): 모바일 {qcLabel(row.mobileQc)} · PC{" "}
                        {qcLabel(row.pcQc)}
                        {row.newsCount !== null && (
                          <> · 기사 {newsCountLabel(row.newsCount)}건</>
                        )}
                      </p>
                      <p className="qc-detail">
                        유튜브: 관련 콘텐츠 수 추정치{" "}
                        {row.youtubeCount === null
                          ? "—"
                          : `${qcLabel(row.youtubeCount)}건`}
                      </p>
                      {row.youtubeTop && (
                        <p className="yt-top">
                          인기 영상:{" "}
                          <a
                            href={`https://www.youtube.com/watch?v=${row.youtubeTop.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {row.youtubeTop.title ?? row.keyword}
                          </a>
                          {row.youtubeTop.channel && (
                            <span className="news-source">
                              {row.youtubeTop.channel}
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                  </details>
                </article>
              ))}
            </div>
          </section>

          <p className="source-note">
            출처: 네이버 쇼핑 베스트 주간 랭킹 · 기사수: Google News
            RSS(상한 100) · 검색량: 네이버 검색광고 키워드도구 · 유튜브:
            관련 콘텐츠(영상) 수 추정치 — YouTube Data API, 한국 리전 기준
          </p>
        </>
      )}
    </>
  );
}
