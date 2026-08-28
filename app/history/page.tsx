import { ChevronRight, Search } from "lucide-react";
import Link from "next/link";
import { getPriceHistory, type HistoryItem } from "@/src/db/history";
import { OTHER_STORE_FILTER, STORE_FILTER_LOGOS } from "@/src/db/taxonomy";
import { firstParam, hrefFor } from "@/src/lib/query";
import { formatPrice, formatTime, sourceLabel, statusLabel } from "@/src/lib/format";
import { PriceSpark } from "@/components/price-spark";

/*
 * 최저가 히스토리 목록 — price_observations 시계열에서
 * 값이 실제로 변한 딜만 추려 스파크라인과 함께 보여준다.
 * 검색(q)과 정렬(sort)은 쿼리스트링 기반 서버 렌더.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "최저가 히스토리",
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const PER_PAGE = 10;

function storeLogo(storeNorm: string | null): string {
  if (storeNorm && storeNorm in STORE_FILTER_LOGOS) {
    return STORE_FILTER_LOGOS[storeNorm];
  }
  return STORE_FILTER_LOGOS[OTHER_STORE_FILTER];
}

function lowestAt(item: HistoryItem): string {
  const hit = item.points.find((p) => p.price === item.lowestPrice);
  return hit?.observedAt ?? item.updatedAt;
}

export default async function HistoryPage({ searchParams }: PageProps) {
  const raw = await searchParams;
  const q = (firstParam(raw.q) ?? "").trim();
  const sort = firstParam(raw.sort) === "drop" ? "drop" : "latest";
  const rawPage = Number.parseInt(firstParam(raw.page) ?? "1", 10);

  const { items, hasData, trackedCount, observationCount } = getPriceHistory({
    limit: 1000,
    sort,
  });

  const lowered = q.toLowerCase();
  const filtered = q
    ? items.filter((item) =>
        `${item.name ?? ""} ${item.postTitle}`.toLowerCase().includes(lowered),
      )
    : items;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const page = Math.min(Math.max(1, rawPage), totalPages);
  const visible = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const current: Record<string, string> = {};
  if (q) current.q = q;
  if (sort !== "latest") current.sort = sort;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>최저가 히스토리</h1>
          <p>상품별 최저가 기록을 확인하세요.</p>
        </div>
        <span className="head-count">
          추적 {trackedCount}건 · 관측 {formatNumberSafe(observationCount)}회
        </span>
      </div>

      <div className="head-actions">
        <form className="searchbox" action="/history" method="get">
          <Search size={15} />
          <input name="q" defaultValue={q} placeholder="상품명으로 검색" />
        </form>
        <a className={sort === "latest" ? "fchip active" : "fchip"} href={hrefFor("/history", current, { sort: null })}>
          최근 업데이트
        </a>
        <a className={sort === "drop" ? "fchip active" : "fchip"} href={hrefFor("/history", current, { sort: "drop" })}>
          인하폭 순
        </a>
      </div>

      {!hasData || filtered.length === 0 ? (
        <div className="empty" style={{ marginTop: 18 }}>
          {q ? `"${q}" 검색 결과가 없습니다.` : "아직 가격 변동 이력이 없습니다."}
        </div>
      ) : (
        <section className="deal-list" style={{ marginTop: 18 }}>
          {visible.map((item) => {
            const logo = storeLogo(item.storeNorm);

            return (
              <Link className="deal-row hist-row" key={item.dealId} href={`/history/${item.dealId}`}>
                <div className="thumb">
                  <img src={logo} alt={item.storeNorm} />
                </div>

                <div className="row-grow">
                  <div className="store-line">
                    <img src={logo} alt="" />
                    {item.storeNorm}
                    <span>· {sourceLabel(item.community)}</span>
                  </div>
                  <span className="row-title">{item.name ?? item.postTitle}</span>
                  <div className="tagrow">
                    <span className={item.status === "ended" ? "tag ended" : "tag live"}>
                      {statusLabel(item.status)}
                    </span>
                    <span className="tag">{item.categoryNorm}</span>
                    <span className="tag">관측 {item.points.length}회</span>
                  </div>
                </div>

                <span className="hist-spark">
                  <PriceSpark points={item.points} />
                </span>

                <div className="rail">
                  <span className="price">
                    {formatPrice(item.lowestPrice, item.currency, "")}
                  </span>
                  <span className="price-sub">최저가 · {formatTime(lowestAt(item))}</span>
                </div>

                <ChevronRight className="chev" size={16} />
              </Link>
            );
          })}
        </section>
      )}

      {totalPages > 1 && (
        <nav className="pager">
          {page > 1 && (
            <a href={hrefFor("/history", current, { page: page === 2 ? null : String(page - 1) })}>‹</a>
          )}
          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter((p) => totalPages <= 7 || Math.abs(p - page) <= 1 || p === 1 || p === totalPages)
            .map((p, i, arr) => (
              <span key={p} style={{ display: "contents" }}>
                {i > 0 && arr[i - 1] !== p - 1 && <span>…</span>}
                <a className={p === page ? "on" : ""} href={hrefFor("/history", current, { page: p === 1 ? null : String(p) })}>
                  {p}
                </a>
              </span>
            ))}
          {page < totalPages && (
            <a href={hrefFor("/history", current, { page: String(page + 1) })}>›</a>
          )}
        </nav>
      )}
    </>
  );
}

function formatNumberSafe(value: number): string {
  return new Intl.NumberFormat("ko-KR").format(value);
}
