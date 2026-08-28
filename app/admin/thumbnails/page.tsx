import Link from "next/link";
import { countThumbnails, listThumbnails } from "@/src/db/admin-queries";
import { ThumbnailActions } from "@/components/admin/thumbnail-actions";
import { firstParam, hrefFor } from "@/src/lib/query";
import { formatTime, sourceLabel } from "@/src/lib/format";

/*
 * 어드민 — 썸네일 관리.
 *
 * 구매링크 있는 딜을 상품 키 단위로 묶고 캐시 상태를 붙여 보여준다.
 * 탭: 전체 / 이미지 없음 / 자동 캐시 / 수동 지정. 액션은 행 단위
 * 클라이언트 아일랜드(ThumbnailActions)가 /api/admin/image로 요청.
 */

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const PAGE_SIZE = 50;

export default async function AdminThumbnailsPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  const rawView = firstParam(sp.view);
  const view =
    rawView === "missing" || rawView === "cached" || rawView === "override"
      ? rawView
      : "all";
  const page = Number(firstParam(sp.page)) || 1;

  const counts = countThumbnails();
  const result = listThumbnails({ view, page, pageSize: PAGE_SIZE });
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));

  const tabs: Array<{ value: "all" | "missing" | "cached" | "override"; label: string; count: number }> = [
    { value: "all", label: "전체", count: counts.all },
    { value: "missing", label: "이미지 없음", count: counts.missing },
    { value: "cached", label: "자동 캐시", count: counts.cached },
    { value: "override", label: "수동 지정", count: counts.override },
  ];

  return (
    <div>
      <div className="admin-head">
        <h1>썸네일 관리</h1>
        <span className="admin-count">
          상품 키 {counts.all.toLocaleString("ko-KR")}개 · 이미지는 다음
          파이프라인 배포에 반영
        </span>
      </div>

      <div className="toolbar">
        <div className="frow">
          {tabs.map((tab) => (
            <Link
              key={tab.value}
              className={view === tab.value ? "fchip active" : "fchip"}
              href={hrefFor("/admin/thumbnails", {}, {
                view: tab.value === "all" ? null : tab.value,
                page: null,
              })}
            >
              {tab.label} ({tab.count.toLocaleString("ko-KR")})
            </Link>
          ))}
        </div>
      </div>

      {result.rows.length === 0 ? (
        <div className="empty-note">조건에 맞는 상품 키가 없습니다.</div>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th />
              <th>상품명</th>
              <th>커뮤니티 / 게시글</th>
              <th>이미지 상태</th>
              <th>조작</th>
              <th>마지막 수집</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => {
              const displayImage = row.imageOverride ?? row.imageUrl;

              return (
                <tr key={row.productKey}>
                  <td className="thumb-cell">
                    {displayImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={displayImage} alt="" />
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
                    {row.name ?? "(이름 없음)"}
                    <div className="sub">
                      {row.store ?? "스토어 미상"}
                      {row.productUrl && (
                        <>
                          {" · "}
                          <a
                            href={row.productUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "inherit" }}
                          >
                            구매링크
                          </a>
                        </>
                      )}
                    </div>
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
                        원문 게시글
                      </a>
                    </div>
                  </td>
                  <td>
                    {row.imageOverride ? (
                      <span className="badge warn">수동</span>
                    ) : row.imageUrl ? (
                      <span className="badge live">캐시</span>
                    ) : (
                      <span className="badge muted">없음</span>
                    )}
                    {!row.imageOverride && row.attempts > 0 && (
                      <div className="sub">자동 시도 {row.attempts}회</div>
                    )}
                  </td>
                  <td>
                    <ThumbnailActions
                      productKey={row.productKey}
                      imageUrl={row.imageUrl}
                      imageOverride={row.imageOverride}
                    />
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
              href={hrefFor("/admin/thumbnails", {}, {
                view: view === "all" ? null : view,
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
              href={hrefFor("/admin/thumbnails", {}, {
                view: view === "all" ? null : view,
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
