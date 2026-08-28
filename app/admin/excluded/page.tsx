import Link from "next/link";
import { listAdminDeals } from "@/src/db/admin-queries";
import { CATEGORIES } from "@/src/db/taxonomy";
import { ExcludedActions } from "@/components/admin/excluded-actions";
import { CategoryPicker } from "@/components/admin/category-picker";
import { firstParam, hrefFor } from "@/src/lib/query";
import { formatTime, sourceLabel } from "@/src/lib/format";

/*
 * 어드민 — 제외/미분류 상품 관리.
 *
 * 탭 2개 (쿼리스트링 ?view=):
 * - 제외됨: 인제스트가 제외 규칙으로 막은 딜. 복원하면 노출되고,
 *   복원 마커가 있어 다음 인제스트가 다시 제외하지 않는다.
 * - 미분류: 카테고리 값 없이 적재된 딜(게시판에 노출되는 "기타"
 *   항목). 여기서 지정한 카테고리는 오버라이라 수집이 덮어쓰지 않는다.
 */

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const PAGE_SIZE = 50;

const REASON_LABEL: Record<string, string> = {
  category: "무형 카테고리",
  "zero-price": "0원 딜",
  "promo-title": "프로모션/이벤트",
  "software-title": "소프트웨어",
  "rental-title": "렌탈",
  "travel-title": "항공/여행",
};

export default async function AdminExcludedPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  const view = firstParam(sp.view) === "uncategorized" ? "uncategorized" : "excluded";
  const page = Number(firstParam(sp.page)) || 1;

  const excludedCount = listAdminDeals({
    excludedOnly: true,
    includeHidden: true,
    page: 1,
    pageSize: 1,
  }).total;
  const uncategorizedCount = listAdminDeals({
    uncategorizedOnly: true,
    includeHidden: true,
    page: 1,
    pageSize: 1,
  }).total;

  const result = listAdminDeals(
    view === "uncategorized"
      ? { uncategorizedOnly: true, includeHidden: true, page, pageSize: PAGE_SIZE }
      : { excludedOnly: true, includeHidden: true, page, pageSize: PAGE_SIZE },
  );

  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));

  return (
    <div>
      <div className="admin-head">
        <h1>제외/미분류 상품 관리</h1>
        <span className="admin-count">
          {result.total.toLocaleString("ko-KR")}행
        </span>
      </div>

      <div className="toolbar">
        <div className="frow">
          <Link
            className={view === "excluded" ? "fchip active" : "fchip"}
            href={hrefFor("/admin/excluded", {}, { view: null, page: null })}
          >
            제외됨 ({excludedCount.toLocaleString("ko-KR")})
          </Link>
          <Link
            className={view === "uncategorized" ? "fchip active" : "fchip"}
            href={hrefFor("/admin/excluded", {}, {
              view: "uncategorized",
              page: null,
            })}
          >
            미분류 ({uncategorizedCount.toLocaleString("ko-KR")})
          </Link>
        </div>
      </div>

      {result.rows.length === 0 ? (
        <div className="empty-note">
          {view === "uncategorized"
            ? "미분류 딜이 없습니다."
            : "제외된 딜이 없습니다."}
        </div>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>상품명</th>
              <th>가격</th>
              <th>커뮤니티 / 게시글</th>
              {view === "excluded" ? (
                <>
                  <th>제외 사유</th>
                  <th>조작</th>
                </>
              ) : (
                <th>카테고리 지정</th>
              )}
              <th>마지막 수집</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => {
              const displayName = row.nameOverride ?? row.productName;
              const displayPrice =
                row.priceOverride !== null
                  ? `${Math.round(row.priceOverride).toLocaleString("ko-KR")}원`
                  : row.priceText;

              return (
                <tr key={row.dealId}>
                  <td className="name-cell">
                    <Link href={`/admin/deals/${row.dealId}`}>
                      {displayName ?? "(이름 없음)"}
                    </Link>
                    {row.hidden === 1 && (
                      <span className="badge muted" style={{ marginLeft: 6 }}>
                        숨김
                      </span>
                    )}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{displayPrice}</td>
                  <td>
                    {sourceLabel(row.community)}
                    <div className="sub">
                      <a
                        href={row.postUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "inherit" }}
                      >
                        {row.postTitle.slice(0, 30)}
                        {row.postTitle.length > 30 ? "…" : ""}
                      </a>
                    </div>
                  </td>
                  {view === "excluded" ? (
                    <>
                      <td>
                        {row.exclusionRestored === 1 ? (
                          <span className="badge live">복원됨</span>
                        ) : (
                          <span className="badge danger">
                            {REASON_LABEL[row.excludedReason ?? ""] ??
                              row.excludedReason}
                          </span>
                        )}
                      </td>
                      <td>
                        <ExcludedActions
                          dealId={row.dealId}
                          restored={row.exclusionRestored === 1}
                        />
                      </td>
                    </>
                  ) : (
                    <td>
                      <CategoryPicker
                        dealId={row.dealId}
                        categories={[...CATEGORIES]}
                      />
                    </td>
                  )}
                  <td style={{ whiteSpace: "nowrap" }}>
                    {formatTime(row.lastSeenAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {totalPages > 1 && (
        <nav className="pager">
          {result.page > 1 && (
            <Link
              href={hrefFor("/admin/excluded", {}, {
                view: view === "excluded" ? null : "uncategorized",
                page: String(result.page - 1),
              })}
            >
              ‹
            </Link>
          )}
          <span className="on">
            {result.page} / {totalPages}
          </span>
          {result.page < totalPages && (
            <Link
              href={hrefFor("/admin/excluded", {}, {
                view: view === "excluded" ? null : "uncategorized",
                page: String(result.page + 1),
              })}
            >
              ›
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
