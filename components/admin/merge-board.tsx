"use client";

import { useState } from "react";
import { Combine, ExternalLink, Undo2 } from "lucide-react";
import type {
  MergeCandidate,
  MergeDealInfo,
  MergeGroup,
} from "@/src/db/admin-queries";
import { sourceLabel, statusLabel } from "@/src/lib/format";

/*
 * 카드 병합 관리 클라이언트 아일랜드 (2단계).
 *
 * 서버가 읽어준 후보·수동 그룹·검색 결과를 받아 선택/병합/해제만
 * 담당한다. 모든 쓰기는 POST /api/admin/merge 로. 성공 시 서버가
 * 다시 렌더한 페이지로 새로고침 (deal-editor와 동일 패턴).
 */

type Props = {
  candidates: MergeCandidate[];
  manualGroups: MergeGroup[];
  autoGroupCount: number;
  searchResults: MergeDealInfo[] | null;
  query: string;
  scanned: number;
};

/** 대표 카드 기본값: URL 키 있는 첫 딜, 없으면 첫 딜. */
function defaultCanonical(deals: MergeDealInfo[]): number {
  return (deals.find((d) => d.urlKey !== null) ?? deals[0]).dealId;
}

function Thumb({ deal }: { deal: MergeDealInfo }) {
  if (deal.imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={deal.imageUrl}
        alt=""
        referrerPolicy="no-referrer"
        style={{
          width: 40,
          height: 40,
          objectFit: "cover",
          borderRadius: 8,
          border: "1px solid var(--border)",
        }}
      />
    );
  }

  return (
    <div
      style={{
        width: 40,
        height: 40,
        borderRadius: 8,
        background: "var(--muted)",
      }}
    />
  );
}

function DealLine({ deal }: { deal: MergeDealInfo }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontWeight: 600, fontSize: 13, wordBreak: "break-word" }}>
        {deal.name ?? "(이름 없음)"}
      </div>
      <div className="sub" style={{ marginTop: 2 }}>
        {sourceLabel(deal.community)} · {deal.priceText}
        {deal.store ? ` · ${deal.store}` : ""} ·{" "}
        {statusLabel(deal.status)}
      </div>
      <div
        className="sub"
        style={{ marginTop: 2, wordBreak: "break-all", fontSize: 11 }}
      >
        키: {deal.effectiveKey}
        {deal.productKeyOverride && (
          <span className="badge live" style={{ marginLeft: 6 }}>
            수동 병합
          </span>
        )}
      </div>
      <a
        className="sub"
        href={deal.postUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
      >
        원문 <ExternalLink size={11} />
      </a>
    </div>
  );
}

/** 딜 뭉치에서 대표 선택 + 포함 체크 + 병합 실행. */
function Picker({
  deals,
  onDone,
  busy,
}: {
  deals: MergeDealInfo[];
  onDone: (msg: string, error?: boolean) => void;
  busy: boolean;
}) {
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(deals.map((d) => d.dealId)),
  );
  const [canonical, setCanonical] = useState<number>(() =>
    defaultCanonical(deals),
  );

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const chosen = deals.filter((d) => selected.has(d.dealId));
  const canMerge = chosen.length >= 2 && chosen.some((d) => d.dealId === canonical);

  async function merge() {
    if (!canMerge) return;

    try {
      const res = await fetch("/api/admin/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "merge",
          dealIds: chosen.map((d) => d.dealId),
          canonicalDealId: canonical,
        }),
      });

      const body = (await res.json().catch(() => null)) as {
        error?: string;
        canonicalKey?: string;
        count?: number;
      } | null;

      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);

      onDone(`${body?.count ?? chosen.length}개 카드를 병합했습니다`);
      setTimeout(() => window.location.reload(), 700);
    } catch (error) {
      onDone(`병합 실패: ${String(error)}`, true);
    }
  }

  return (
    <div>
      <table className="admin-table">
        <thead>
          <tr>
            <th style={{ width: 34 }}>포함</th>
            <th style={{ width: 46 }} />
            <th>카드</th>
            <th style={{ width: 60 }}>대표</th>
          </tr>
        </thead>
        <tbody>
          {deals.map((deal) => (
            <tr key={deal.dealId}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(deal.dealId)}
                  onChange={() => toggle(deal.dealId)}
                  aria-label="병합 포함"
                />
              </td>
              <td className="thumb-cell">
                <Thumb deal={deal} />
              </td>
              <td className="name-cell">
                <DealLine deal={deal} />
              </td>
              <td>
                <input
                  type="radio"
                  name={`canon-${deals.map((d) => d.dealId).join("-")}`}
                  checked={canonical === deal.dealId}
                  disabled={!selected.has(deal.dealId)}
                  onChange={() => {
                    setCanonical(deal.dealId);
                    setSelected((prev) => new Set(prev).add(deal.dealId));
                  }}
                  aria-label="대표 카드로 지정"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="abtn-row" style={{ marginTop: 10 }}>
        <button
          className="abtn primary"
          disabled={busy || !canMerge}
          onClick={() => void merge()}
        >
          <Combine size={14} /> 선택한 {chosen.length}개 병합
        </button>
        <span className="sub" style={{ alignSelf: "center" }}>
          대표 카드로 키를 통일합니다
        </span>
      </div>
    </div>
  );
}

export function MergeBoard({
  candidates,
  manualGroups,
  autoGroupCount,
  searchResults,
  query,
  scanned,
}: Props) {
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  function done(text: string, error = false) {
    setToast({ text, error });
    if (!error) setBusy(true);
    setTimeout(() => {
      setToast(null);
      if (!error) setBusy(false);
    }, error ? 3200 : 1400);
  }

  async function unmerge(deal: MergeDealInfo) {
    setBusy(true);

    try {
      const res = await fetch("/api/admin/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "unmerge", dealId: deal.dealId }),
      });

      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;

      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);

      done("병합을 해제했습니다");
      setTimeout(() => window.location.reload(), 700);
    } catch (error) {
      setBusy(false);
      done(`해제 실패: ${String(error)}`, true);
    }
  }

  return (
    <div>
      <p className="sub" style={{ margin: "0 0 16px" }}>
        최근 {scanned.toLocaleString("ko-KR")}개 딜을 스캔 · URL로 자동
        병합된 그룹 {autoGroupCount.toLocaleString("ko-KR")}개. 아래 후보는
        같은 상품인데 카드가 갈라진 경우입니다. 대표 카드를 고르고 병합하면
        피드와 최저가 히스토리가 하나로 합쳐집니다.
      </p>

      {searchResults !== null && (
        <section className="admin-card" style={{ marginBottom: 18 }}>
          <h2>검색 결과 · “{query}” ({searchResults.length})</h2>
          {searchResults.length < 2 ? (
            <div className="empty-note">
              병합하려면 2개 이상 필요합니다. 검색어를 바꿔 보세요.
            </div>
          ) : (
            <Picker deals={searchResults} onDone={done} busy={busy} />
          )}
        </section>
      )}

      <section style={{ marginBottom: 18 }}>
        <h2 style={{ margin: "0 0 10px" }}>병합 후보 ({candidates.length})</h2>
        {candidates.length === 0 ? (
          <div className="empty-note">
            갈라진 카드 후보가 없습니다. 위에서 검색으로 직접 찾을 수도
            있습니다.
          </div>
        ) : (
          candidates.map((cand) => (
            <div className="admin-card" key={cand.signature} style={{ marginBottom: 12 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <span
                  className={
                    cand.signal === "item_id" ? "badge live" : "badge warn"
                  }
                >
                  {cand.signal === "item_id" ? "상품번호 일치" : "이름 유사"}
                </span>
                <span className="sub">
                  키 {cand.distinctKeys}개로 갈라짐 · {cand.deals.length}카드
                </span>
              </div>
              <Picker deals={cand.deals} onDone={done} busy={busy} />
            </div>
          ))
        )}
      </section>

      <section>
        <h2 style={{ margin: "0 0 10px" }}>
          수동 병합된 그룹 ({manualGroups.length})
        </h2>
        {manualGroups.length === 0 ? (
          <div className="empty-note">아직 수동으로 병합한 카드가 없습니다.</div>
        ) : (
          manualGroups.map((group) => (
            <div className="admin-card" key={group.key} style={{ marginBottom: 12 }}>
              <div className="sub" style={{ marginBottom: 8, wordBreak: "break-all" }}>
                키: {group.key}
              </div>
              <table className="admin-table">
                <tbody>
                  {group.deals.map((deal) => (
                    <tr key={deal.dealId}>
                      <td className="thumb-cell" style={{ width: 46 }}>
                        <Thumb deal={deal} />
                      </td>
                      <td className="name-cell">
                        <DealLine deal={deal} />
                      </td>
                      <td style={{ width: 90, whiteSpace: "nowrap" }}>
                        {deal.productKeyOverride ? (
                          <button
                            className="abtn danger"
                            disabled={busy}
                            onClick={() => void unmerge(deal)}
                          >
                            <Undo2 size={13} /> 해제
                          </button>
                        ) : (
                          <span className="badge muted">자연 키</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </section>

      {toast && (
        <div className={toast.error ? "toast error" : "toast"}>{toast.text}</div>
      )}
    </div>
  );
}
