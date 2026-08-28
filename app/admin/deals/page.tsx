import Link from "next/link";
import { listAdminDeals } from "@/src/db/admin-queries";
import { CATEGORIES, COMMUNITIES, STORE_FILTERS } from "@/src/db/taxonomy";
import { firstParam, hrefFor } from "@/src/lib/query";
import { formatTime, sourceLabel, statusLabel } from "@/src/lib/format";

/*
 * 어드민 — 핫딜 카드 관리 (목록).
 *
 * 표시 단위는 아이템이 아니라 deals 행(게시글 내 상품 1개).
 * 수동 수정이 행에 걸리므로 편집 대상과 단위를 맞춘다.
 * 숨김·제외 포함 여부와 필터는 전부 쿼리스트링.
 */

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const PAGE_SIZE = 50;

export default async function AdminDealsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const current: Record<string, string> = {};

  for (const key of ["q", "status", "community", "store", "cat", "page", "f"]) {
    const value = firstParam(sp[key]);
    if (value) current[key] = value;
  }

  const flags = new Set((current.f ?? "").split(",").filter(Boolean));

  const result = listAdminDeals({
    q: current.q ?? null,
    status:
      current.status === "active" || current.status === "ended"
        ? current.status
        : "all",
    community: current.community ?? null,
    includeHidden: true,
    excludedOnly: flags.has("excluded"),
    overriddenOnly: flags.has("overridden"),
    uncategorizedOnly: flags.has("uncategorized"),
    page: current.page ? Number(current.page) || 1 : 1,
    pageSize: PAGE_SIZE,
  });

  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));

  function toggleFlag(flag: string): string {
    const next = new Set(flags);
    if (next.has(flag)) next.delete(flag);
    else next.add(flag);

    return hrefFor("/admin/deals", current, {
      f: next.size > 0 ? [...next].join(",") : null,
      page: null,
    });
  }

  return (
    <div>
      <div className="admin-head">
        <h1>핫딜 카드 관리</h1>
        <span className="admin-count">
          {result.total.toLocaleString("ko-KR")}행 · 숨김·제외 포함
        </span>
      </div>

      <div className="toolbar">
        <form className="searchbar" action="/admin/deals" method="get" role="search">
          <input
            type="search"
            name="q"
            defaultValue={current.q ?? ""}
            placeholder="상품명·게시글 제목 검색"
            aria-label="검색"
          />
          {current.status && (
            <input type="hidden" name="status" value={current.status} />
          )}
          {current.f && <input type="hidden" name="f" value={current.f} />}
          {current.community && (
            <input type="hidden" name="community" value={current.community} />
          )}
          <button type="submit">검색</button>
        </form>

        <div className="frow">
          <span className="flabel">상태</span>
          <Link
            className={!current.status ? "fchip active" : "fchip"}
            href={hrefFor("/admin/deals", current, { status: null, page: null })}
          >
            전체
          </Link>
          <Link
            className={current.status === "active" ? "fchip active" : "fchip"}
            href={hrefFor("/admin/deals", current, { status: "active", page: null })}
          >
            진행중
          </Link>
          <Link
            className={current.status === "ended" ? "fchip active" : "fchip"}
            href={hrefFor("/admin/deals", current, { status: "ended", page: null })}
          >
            종료
          </Link>
          <span style={{ width: 14 }} />
          <span className="flabel">필터</span>
          <Link
            className={flags.has("excluded") ? "fchip active" : "fchip"}
            href={toggleFlag("excluded")}
          >
            제외됨
          </Link>
          <Link
            className={flags.has("overridden") ? "fchip active" : "fchip"}
            href={toggleFlag("overridden")}
          >
            수동수정 있음
          </Link>
          <Link
            className={flags.has("uncategorized") ? "fchip active" : "fchip"}
            href={toggleFlag("uncategorized")}
          >
            미분류
          </Link>
        </div>

        <div className="frow">
          <span className="flabel">커뮤니티</span>
          <Link
            className={!current.community ? "fchip active" : "fchip"}
            href={hrefFor("/admin/deals", current, { community: null, page: null })}
          >
            전체
          </Link>
          {COMMUNITIES.map((c) => (
            <Link
              key={c}
              className={current.community === c ? "fchip active" : "fchip"}
              href={hrefFor("/admin/deals", current, { community: c, page: null })}
            >
              {sourceLabel(c)}
            </Link>
          ))}
        </div>
      </div>

      {result.rows.length === 0 ? (
        <div className="empty-note">조건에 맞는 딜이 없습니다.</div>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th />
              <th>상품명</th>
              <th>가격</th>
              <th>커뮤니티 / 게시글</th>
              <th>상태</th>
              <th>플래그</th>
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
              const status = row.postStatusOverride ?? row.postStatus;

              return (
                <tr key={row.dealId}>
                  <td className="thumb-cell">
                    {row.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={row.imageUrl} alt="" />
                    ) : (
                      <div
                        style={{
                          width: 40,
                          height: 40,
                          borderRadius: 8,
                          background: "var(--muted)",
                        }}
                      />
                    )}
                  </td>
                  <td className="name-cell">
                    <Link href={`/admin/deals/${row.dealId}`}>
                      {displayName ?? "(이름 없음)"}
                      {row.nameOverride && (
                        <span className="badge warn" style={{ marginLeft: 6 }}>
                          수동
                        </span>
                      )}
                    </Link>
                    <div className="sub">
                      {row.categoryOverride ?? row.category ?? "미분류"}
                      {(row.storeOverride ?? row.store) &&
                        ` · ${row.storeOverride ?? row.store}`}
                    </div>
                  </td>
                  <td>
                    {displayPrice}
                    {row.priceOverride !== null && (
                      <div className="sub">수동 · 파서 {row.priceText}</div>
                    )}
                  </td>
                  <td>
                    {sourceLabel(row.community)}
                    <div className="sub">
                      <a
                        href={row.postUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "inherit" }}
                      >
                        {row.postTitle.slice(0, 26)}
                        {row.postTitle.length > 26 ? "…" : ""}
                      </a>
                    </div>
                  </td>
                  <td>
                    <span
                      className={
                        status === "active" || status === "unknown"
                          ? "badge live"
                          : "badge ended"
                      }
                    >
                      {statusLabel(status)}
                    </span>
                    {row.postStatusOverride && (
                      <div className="sub">수동 고정</div>
                    )}
                  </td>
                  <td>
                    {row.hidden === 1 && (
                      <span className="badge muted">숨김</span>
                    )}
                    {row.postHidden === 1 && (
                      <span className="badge muted">게시글 숨김</span>
                    )}
                    {row.excludedReason && (
                      <span className="badge danger">제외</span>
                    )}
                    {row.exclusionRestored === 1 && (
                      <span className="badge live">복원됨</span>
                    )}
                  </td>
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
              href={hrefFor("/admin/deals", current, {
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
              href={hrefFor("/admin/deals", current, {
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
