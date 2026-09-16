"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Combine,
  ExternalLink,
  Search,
  Undo2,
  X,
} from "lucide-react";
import type {
  MergeCandidate,
  MergeDealInfo,
  MergeGroup,
} from "@/src/db/admin-queries";
import { sourceLabel, statusLabel } from "@/src/lib/format";

/*
 * 카드 병합 관리 클라이언트 아일랜드 (2단계).
 *
 * 두 탭 — "자동 추천"(상품번호 일치 후보 + 수동 그룹/찢기)과
 * "수동 병합"(상품명 검색 → 카드 → 모달에서 임의 카드 조합).
 * 서버가 읽어준 후보·그룹을 받아 선택/병합/해제를 담당하고, 모달의
 * 라이브 검색은 POST /api/admin/merge action:"search"로 즉시 조회한다.
 * 모든 쓰기는 같은 POST 엔드포인트로. 성공 시 서버가 다시 렌더한
 * 페이지로 새로고침 (deal-editor와 동일 패턴).
 */

type TabKey = "recommend" | "manual";

type Props = {
  candidates: MergeCandidate[];
  groups: MergeGroup[];
  scanned: number;
  initialTab: TabKey;
  initialQuery: string;
};

/** 대표 카드 기본값: URL 키 있는 첫 딜, 없으면 첫 딜. */
function defaultCanonical(deals: MergeDealInfo[]): number {
  return (deals.find((d) => d.urlKey !== null) ?? deals[0]).dealId;
}

/** 라이브 검색 훅 — 디바운스 300ms, 최소 2자, 최신 요청만 반영. */
type SearchState = {
  results: MergeDealInfo[];
  searching: boolean;
  searched: boolean;
  error: string | null;
};

function useMergeSearch(initial = "") {
  const [q, setQ] = useState(initial);
  const [state, setState] = useState<SearchState>({
    results: [],
    searching: false,
    searched: false,
    error: null,
  });
  const reqId = useRef(0);
  const needle = q.trim();

  useEffect(() => {
    /* 2자 미만은 요청하지 않는다 — 상태 초기화는 호출부의 렌더 가드
       (needle.length < 2)가 담당하므로 여기서 동기 setState를 하지 않는다. */
    if (needle.length < 2) return;

    const id = ++reqId.current;

    const timer = setTimeout(() => {
      void (async () => {
        setState((s) => ({ ...s, searching: true, error: null }));
        try {
          const res = await fetch("/api/admin/merge", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "search", q: needle, limit: 50 }),
          });
          const body = (await res.json().catch(() => null)) as {
            error?: string;
            results?: MergeDealInfo[];
          } | null;
          if (id !== reqId.current) return;
          if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
          setState({
            results: body?.results ?? [],
            searching: false,
            searched: true,
            error: null,
          });
        } catch (e) {
          if (id !== reqId.current) return;
          setState({
            results: [],
            searching: false,
            searched: true,
            error: String(e),
          });
        }
      })();
    }, 300);

    return () => clearTimeout(timer);
  }, [needle]);

  return { q, setQ, ...state };
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
        {deal.store ? ` · ${deal.store}` : ""} · {statusLabel(deal.status)}
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

/** 딜 뭉치에서 대표 선택 + 포함 체크 + 병합 실행 (자동 추천 후보용). */
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
  const canMerge =
    chosen.length >= 2 && chosen.some((d) => d.dealId === canonical);

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

/**
 * 수동 병합 모달 — 기준 카드를 고정하고 라이브 검색으로 임의 카드를
 * 추가해 묶는다. 선택 카드가 이미 다른 형제와 묶여 있는데 그 형제가
 * 선택에서 빠졌으면 찢기 경고를 띄운다.
 */
function MergeModal({
  base,
  groupsByKey,
  busy,
  setBusy,
  onDone,
  onClose,
  onMerged,
}: {
  base: MergeDealInfo;
  groupsByKey: Map<string, MergeDealInfo[]>;
  busy: boolean;
  setBusy: (v: boolean) => void;
  onDone: (msg: string, error?: boolean) => void;
  onClose: () => void;
  onMerged: () => void;
}) {
  /* 기준 카드가 이미 그룹이면 그 멤버를 전부 초기 선택 — 그룹을 찢지
     않고 카드를 "추가"하는 것이 자연스러운 기본값. */
  const initial = useMemo(() => {
    const members = groupsByKey.get(base.effectiveKey);
    return members && members.length >= 2 ? members : [base];
  }, [base, groupsByKey]);

  const [selected, setSelected] = useState<Map<number, MergeDealInfo>>(
    () => new Map(initial.map((d) => [d.dealId, d])),
  );
  const [canonical, setCanonical] = useState<number>(base.dealId);
  const [warning, setWarning] = useState<MergeDealInfo[] | null>(null);
  const { q, setQ, results, searching, searched, error } = useMergeSearch("");

  const selectedList = [...selected.values()];
  const canMerge = selected.size >= 2 && selected.has(canonical);

  function addDeal(d: MergeDealInfo) {
    setSelected((prev) => {
      if (prev.has(d.dealId)) return prev;
      const next = new Map(prev);
      next.set(d.dealId, d);
      return next;
    });
  }

  function toggleDeal(d: MergeDealInfo) {
    if (selected.has(d.dealId)) removeDeal(d.dealId);
    else addDeal(d);
  }

  function removeDeal(id: number) {
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(id);
      if (canonical === id) {
        const first = next.keys().next().value as number | undefined;
        if (first !== undefined) setCanonical(first);
      }
      return next;
    });
  }

  function chooseCanonical(id: number) {
    if (!selected.has(id)) return;
    setCanonical(id);
  }

  /* 선택된 카드가 속한 기존 그룹의, 선택에 빠진 형제 = 찢어질 카드. */
  function orphansOf(list: MergeDealInfo[]): MergeDealInfo[] {
    const selIds = new Set(list.map((d) => d.dealId));
    const out: MergeDealInfo[] = [];
    const seen = new Set<number>();
    for (const d of list) {
      const members = groupsByKey.get(d.effectiveKey);
      if (!members) continue;
      for (const m of members) {
        if (!selIds.has(m.dealId) && !seen.has(m.dealId)) {
          seen.add(m.dealId);
          out.push(m);
        }
      }
    }
    return out;
  }

  async function doMerge(list: MergeDealInfo[], canonicalId: number) {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "merge",
          dealIds: list.map((d) => d.dealId),
          canonicalDealId: canonicalId,
        }),
      });

      const body = (await res.json().catch(() => null)) as {
        error?: string;
        count?: number;
      } | null;

      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);

      setWarning(null);
      onDone(`${body?.count ?? list.length}개 카드를 병합했습니다`);
      setTimeout(() => onMerged(), 700);
    } catch (e) {
      setBusy(false);
      onDone(`병합 실패: ${String(e)}`, true);
    }
  }

  function onMergeClick() {
    if (!canMerge) return;
    const orphans = orphansOf(selectedList);
    if (orphans.length > 0) {
      setWarning(orphans);
      return;
    }
    void doMerge(selectedList, canonical);
  }

  function includeOrphans() {
    if (!warning) return;
    const next = new Map(selected);
    for (const o of warning) next.set(o.dealId, o);
    setSelected(next);
    const list = [...next.values()];
    void doMerge(list, next.has(canonical) ? canonical : list[0].dealId);
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-panel">
        <div className="modal-head">
          <h2>수동 병합</h2>
          <button
            className="icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="닫기"
          >
            <X size={16} />
          </button>
        </div>

        <div
          className="admin-card"
          style={{ marginBottom: 12, padding: 12, borderColor: "var(--primary)" }}
        >
          <div className="sub" style={{ marginBottom: 6, fontWeight: 700 }}>
            기준 카드
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Thumb deal={base} />
            <DealLine deal={base} />
          </div>
        </div>

        <div className="sub" style={{ marginBottom: 6, fontWeight: 700 }}>
          선택한 카드 {selected.size}개 · 칩의 이름을 눌러 대표로 지정
        </div>
        <div className="chip-row">
          {selectedList.map((d) => (
            <span
              key={d.dealId}
              className={d.dealId === canonical ? "chip canonical" : "chip"}
            >
              <button
                type="button"
                onClick={() => chooseCanonical(d.dealId)}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  color: "inherit",
                  fontWeight: d.dealId === canonical ? 800 : 600,
                }}
                title="대표 카드로 지정"
              >
                <span className="chip-name">
                  {d.dealId === canonical ? "★ " : ""}
                  {d.name ?? "(이름 없음)"}
                </span>
              </button>
              <button
                type="button"
                onClick={() => removeDeal(d.dealId)}
                disabled={busy}
                aria-label="선택 해제"
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>

        <div className="modal-search">
          <Search size={15} />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="함께 묶을 카드 검색 (상품명·게시글 제목, 2자 이상)"
            aria-label="병합할 카드 검색"
          />
          {searching && <span className="sub">검색 중…</span>}
        </div>

        {error && <div className="warn-box">검색 실패: {error}</div>}

        {warning && (
          <div className="warn-box">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontWeight: 800,
                marginBottom: 6,
              }}
            >
              <AlertTriangle size={14} /> 선택한 카드가 이미 {warning.length}
              개의 다른 카드와 묶여 있습니다
            </div>
            <div style={{ marginBottom: 8 }}>
              {warning.map((o) => o.name ?? "(이름 없음)").join(", ")}
            </div>
            <div className="sub" style={{ marginBottom: 8 }}>
              선택한 것만 병합하면 기존 그룹에서 이 카드들이 떨어져 나갑니다
              (찢김).
            </div>
            <div className="abtn-row" style={{ marginTop: 0 }}>
              <button
                className="abtn primary"
                disabled={busy}
                onClick={includeOrphans}
              >
                <Combine size={14} /> 형제 모두 포함해 병합
              </button>
              <button
                className="abtn danger"
                disabled={busy}
                onClick={() => {
                  setWarning(null);
                  void doMerge(selectedList, canonical);
                }}
              >
                선택한 것만 병합 (찢김)
              </button>
            </div>
          </div>
        )}

        {!warning && (
          <div style={{ maxHeight: 300, overflowY: "auto" }}>
            {q.trim().length < 2 ? (
              <div className="empty-note" style={{ padding: 18 }}>
                두 글자 이상 입력하면 카드를 검색합니다.
              </div>
            ) : searched && results.length === 0 ? (
              <div className="empty-note" style={{ padding: 18 }}>
                “{q.trim()}” 검색 결과 없음.
              </div>
            ) : (
              <table className="admin-table">
                <tbody>
                  {results.map((deal) => (
                    <tr key={deal.dealId}>
                      <td style={{ width: 34 }}>
                        <input
                          type="checkbox"
                          checked={selected.has(deal.dealId)}
                          onChange={() => toggleDeal(deal)}
                          disabled={busy}
                          aria-label="병합 포함"
                        />
                      </td>
                      <td className="thumb-cell" style={{ width: 46 }}>
                        <Thumb deal={deal} />
                      </td>
                      <td className="name-cell">
                        <DealLine deal={deal} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        <div className="abtn-row" style={{ marginTop: 14 }}>
          <button
            className="abtn primary"
            disabled={busy || !canMerge || warning !== null}
            onClick={onMergeClick}
          >
            <Combine size={14} /> 선택한 {selected.size}개 병합
          </button>
          <button className="abtn" onClick={onClose} disabled={busy}>
            취소
          </button>
          {!canMerge && (
            <span className="sub" style={{ alignSelf: "center" }}>
              2개 이상 선택하세요
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** 수동 병합 탭 — 검색 → 카드 목록 → [병합하기]로 모달. */
function ManualTab({
  initialQuery,
  busy,
  groupsByKey,
  onDone,
  setBusy,
  onMerged,
}: {
  initialQuery: string;
  busy: boolean;
  groupsByKey: Map<string, MergeDealInfo[]>;
  onDone: (msg: string, error?: boolean) => void;
  setBusy: (v: boolean) => void;
  onMerged: () => void;
}) {
  const { q, setQ, results, searching, searched, error } =
    useMergeSearch(initialQuery);
  const [modalBase, setModalBase] = useState<MergeDealInfo | null>(null);

  /* 검색어를 ?q=로 보존 (딥링크·새로고침 유지). */
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", "manual");
      const needle = q.trim();
      if (needle.length > 0) url.searchParams.set("q", needle);
      else url.searchParams.delete("q");
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* no-op */
    }
  }, [q]);

  return (
    <div>
      <p className="sub" style={{ margin: "0 0 12px" }}>
        상품명·게시글 제목으로 카드를 검색하고, 기준이 될 카드의 [병합하기]를
        누르면 모달에서 함께 묶을 카드를 추가할 수 있습니다. 상품번호가 달라
        자동 추천이 못 잡는 경우(예: 같은 펩시인데 판매자·옵션이 다른 카드)에
        쓰세요.
      </p>

      <div className="toolbar">
        <div className="searchbar" role="search">
          <Search size={15} />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="상품명·게시글 제목으로 병합할 카드 검색"
            aria-label="검색"
          />
          {searching && <span className="sub">검색 중…</span>}
        </div>
      </div>

      {error && <div className="warn-box">검색 실패: {error}</div>}

      {q.trim().length < 2 ? (
        <div className="empty-note">두 글자 이상 입력하면 카드를 검색합니다.</div>
      ) : searched && results.length === 0 ? (
        <div className="empty-note">“{q.trim()}” 검색 결과가 없습니다.</div>
      ) : results.length > 0 ? (
        <div className="admin-card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="admin-table">
            <tbody>
              {results.map((deal) => (
                <tr key={deal.dealId}>
                  <td className="thumb-cell" style={{ width: 46 }}>
                    <Thumb deal={deal} />
                  </td>
                  <td className="name-cell">
                    <DealLine deal={deal} />
                  </td>
                  <td style={{ width: 110, whiteSpace: "nowrap" }}>
                    <button
                      className="abtn primary"
                      disabled={busy}
                      onClick={() => setModalBase(deal)}
                    >
                      <Combine size={13} /> 병합하기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {modalBase && (
        <MergeModal
          base={modalBase}
          groupsByKey={groupsByKey}
          busy={busy}
          setBusy={setBusy}
          onDone={onDone}
          onClose={() => setModalBase(null)}
          onMerged={onMerged}
        />
      )}
    </div>
  );
}

/** 자동 추천 탭 — 후보 + 수동 그룹(찢기). */
function RecommendTab({
  candidates,
  manualGroups,
  autoGroupCount,
  scanned,
  busy,
  onDone,
  onUnmerge,
  onUnmergeGroup,
}: {
  candidates: MergeCandidate[];
  manualGroups: MergeGroup[];
  autoGroupCount: number;
  scanned: number;
  busy: boolean;
  onDone: (msg: string, error?: boolean) => void;
  onUnmerge: (deal: MergeDealInfo) => void;
  onUnmergeGroup: (group: MergeGroup) => void;
}) {
  return (
    <div>
      <p className="sub" style={{ margin: "0 0 16px" }}>
        최근 {scanned.toLocaleString("ko-KR")}개 딜을 스캔 · URL로 자동 병합된
        그룹 {autoGroupCount.toLocaleString("ko-KR")}개. 아래 후보는 같은
        상품인데 카드가 갈라진 경우입니다. 대표 카드를 고르고 병합하면 피드와
        최저가 히스토리가 하나로 합쳐집니다. 상품번호가 달라 여기에 안 잡히는
        카드는 “수동 병합” 탭에서 검색으로 묶으세요.
      </p>

      <section style={{ marginBottom: 18 }}>
        <h2 style={{ margin: "0 0 10px" }}>병합 후보 ({candidates.length})</h2>
        {candidates.length === 0 ? (
          <div className="empty-note">
            갈라진 카드 후보가 없습니다. “수동 병합” 탭에서 검색으로 직접 찾을
            수 있습니다.
          </div>
        ) : (
          candidates.map((cand) => (
            <div
              className="admin-card"
              key={cand.signature}
              style={{ marginBottom: 12 }}
            >
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
              <Picker deals={cand.deals} onDone={onDone} busy={busy} />
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
          manualGroups.map((group) => {
            const overrideDeals = group.deals.filter((d) => d.productKeyOverride);
            return (
              <div
                className="admin-card"
                key={group.key}
                style={{ marginBottom: 12 }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <div className="sub" style={{ wordBreak: "break-all" }}>
                    키: {group.key}
                  </div>
                  {overrideDeals.length > 0 && (
                    <button
                      className="abtn danger"
                      disabled={busy}
                      onClick={() => onUnmergeGroup(group)}
                    >
                      <Undo2 size={13} /> 전체 해제
                    </button>
                  )}
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
                        <td style={{ width: 100, whiteSpace: "nowrap" }}>
                          {deal.productKeyOverride ? (
                            <button
                              className="abtn danger"
                              disabled={busy}
                              onClick={() => onUnmerge(deal)}
                            >
                              <Undo2 size={13} /> 빼기
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
            );
          })
        )}
      </section>
    </div>
  );
}

export function MergeBoard({
  candidates,
  groups,
  scanned,
  initialTab,
  initialQuery,
}: Props) {
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [tab, setTabState] = useState<TabKey>(initialTab);

  const manualGroups = useMemo(() => groups.filter((g) => g.manual), [groups]);
  const autoGroupCount = groups.length - manualGroups.length;

  /* 형제 판정용: 유효 키 → 멤버 (2개 이상 그룹만). */
  const groupsByKey = useMemo(() => {
    const m = new Map<string, MergeDealInfo[]>();
    for (const g of groups) {
      if (g.deals.length >= 2) m.set(g.key, g.deals);
    }
    return m;
  }, [groups]);

  function done(text: string, error = false) {
    setToast({ text, error });
    if (!error) setBusy(true);
    setTimeout(
      () => {
        setToast(null);
        if (!error) setBusy(false);
      },
      error ? 3200 : 1400,
    );
  }

  function changeTab(next: TabKey) {
    setTabState(next);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", next);
      if (next !== "manual") url.searchParams.delete("q");
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* no-op */
    }
  }

  /* 병합 성공 → 자동 추천 탭으로 이동하며 서버 재렌더(결과 확인). */
  function onMerged() {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", "recommend");
      url.searchParams.delete("q");
      window.location.href = url.toString();
    } catch {
      window.location.reload();
    }
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
      done("카드를 그룹에서 뺐습니다");
      setTimeout(() => window.location.reload(), 700);
    } catch (error) {
      setBusy(false);
      done(`빼기 실패: ${String(error)}`, true);
    }
  }

  async function unmergeGroup(group: MergeGroup) {
    const targets = group.deals.filter((d) => d.productKeyOverride);
    if (targets.length === 0) return;
    setBusy(true);
    try {
      for (const deal of targets) {
        const res = await fetch("/api/admin/merge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "unmerge", dealId: deal.dealId }),
        });
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      done(`그룹 전체를 해제했습니다 (${targets.length}개)`);
      setTimeout(() => window.location.reload(), 700);
    } catch (error) {
      setBusy(false);
      done(`해제 실패: ${String(error)}`, true);
    }
  }

  return (
    <div>
      <div className="admin-tabs" role="tablist">
        <button
          className="tab-btn"
          role="tab"
          aria-selected={tab === "recommend"}
          onClick={() => changeTab("recommend")}
        >
          자동 추천 ({candidates.length})
        </button>
        <button
          className="tab-btn"
          role="tab"
          aria-selected={tab === "manual"}
          onClick={() => changeTab("manual")}
        >
          수동 병합
        </button>
      </div>

      {tab === "recommend" ? (
        <RecommendTab
          candidates={candidates}
          manualGroups={manualGroups}
          autoGroupCount={autoGroupCount}
          scanned={scanned}
          busy={busy}
          onDone={done}
          onUnmerge={(deal) => void unmerge(deal)}
          onUnmergeGroup={(group) => void unmergeGroup(group)}
        />
      ) : (
        <ManualTab
          initialQuery={initialQuery}
          busy={busy}
          groupsByKey={groupsByKey}
          onDone={done}
          setBusy={setBusy}
          onMerged={onMerged}
        />
      )}

      {toast && (
        <div className={toast.error ? "toast error" : "toast"}>{toast.text}</div>
      )}
    </div>
  );
}
