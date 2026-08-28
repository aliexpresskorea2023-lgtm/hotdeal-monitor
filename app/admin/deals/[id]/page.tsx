import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { getAdminDeal } from "@/src/db/admin-queries";
import { ALL_NORM_CATEGORIES, STORE_FILTERS } from "@/src/db/taxonomy";
import { DealEditor } from "@/components/admin/deal-editor";
import { formatTime, sourceLabel } from "@/src/lib/format";

/*
 * 어드민 — 핫딜 카드 상세 편집.
 * 서버 컴포넌트가 행을 읽고, 편집 아일랜드(DealEditor)가 쓰기를 담당.
 */

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function AdminDealDetailPage({ params }: PageProps) {
  const { id } = await params;
  const dealId = Number(id);

  if (!Number.isInteger(dealId)) notFound();

  const deal = getAdminDeal(dealId);
  if (!deal) notFound();

  return (
    <div>
      <div className="admin-head">
        <h1 style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Link href="/admin/deals" style={{ color: "var(--muted-foreground)" }}>
            <ArrowLeft size={20} />
          </Link>
          핫딜 카드 관리
          <span className="badge muted">#{deal.dealId}</span>
          {deal.excludedReason && (
            <span className="badge danger">제외됨 · {deal.excludedReason}</span>
          )}
          {deal.hidden === 1 && <span className="badge muted">숨김</span>}
        </h1>
      </div>

      <div className="admin-card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              {deal.postTitle}
            </div>
            <div className="sub" style={{ marginTop: 4 }}>
              {sourceLabel(deal.community)} · {deal.community}:{deal.postId} ·
              첫 적재 {formatTime(deal.firstSeenAt)} · 마지막 적재{" "}
              {formatTime(deal.lastSeenAt)} · 조회{" "}
              {(deal.views ?? 0).toLocaleString("ko-KR")} · 추천{" "}
              {(deal.recommendations ?? 0).toLocaleString("ko-KR")}
            </div>
            {deal.productUrl && (
              <div className="sub" style={{ marginTop: 4, wordBreak: "break-all" }}>
                구매링크({deal.urlType}): {deal.productUrl}
              </div>
            )}
          </div>
          <a
            className="abtn"
            href={deal.postUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            원문 <ExternalLink size={12} />
          </a>
        </div>

        {deal.siblings.length > 0 && (
          <div className="sub" style={{ marginTop: 10 }}>
            같은 게시글의 다른 상품:{" "}
            {deal.siblings.map((s, i) => (
              <span key={s.dealId}>
                {i > 0 && " · "}
                <Link href={`/admin/deals/${s.dealId}`}>
                  {s.name ?? "(이름 없음)"}
                </Link>
              </span>
            ))}
          </div>
        )}
      </div>

      <DealEditor
        deal={deal}
        categories={[...ALL_NORM_CATEGORIES]}
        stores={[...STORE_FILTERS]}
      />
    </div>
  );
}
