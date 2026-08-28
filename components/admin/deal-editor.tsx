"use client";

import { useState } from "react";
import { ExternalLink, RotateCcw } from "lucide-react";
import type { AdminDealDetail } from "@/src/db/admin-queries";

/*
 * 어드민 딜 상세 편집기 (클라이언트 아일랜드).
 *
 * 모든 쓰기는 /api/admin/* 로 — 이 컴포넌트는 상태 표시와 요청만
 * 담당한다. 저장 후 성공 시 서버가 다시 렌더한 페이지로 새로고침.
 */

type Props = {
  deal: AdminDealDetail;
  categories: string[];
  stores: string[];
};

export function DealEditor({ deal, categories, stores }: Props) {
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  /* 편집 폼 초기값 = 현재 오버라이드 (없으면 빈칸). */
  const [name, setName] = useState(deal.nameOverride ?? "");
  const [price, setPrice] = useState(
    deal.priceOverride !== null ? String(deal.priceOverride) : "",
  );
  const [category, setCategory] = useState(deal.categoryOverride ?? "");
  const [store, setStore] = useState(deal.storeOverride ?? "");
  const [purchaseUrl, setPurchaseUrl] = useState(deal.urlOverride ?? "");
  const [imageUrl, setImageUrl] = useState(deal.imageOverride ?? "");

  function showToast(text: string, error = false) {
    setToast({ text, error });
    setTimeout(() => setToast(null), 2600);
  }

  async function request(url: string, init: RequestInit, okText: string) {
    setBusy(true);

    try {
      const res = await fetch(url, {
        headers: { "content-type": "application/json" },
        ...init,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }

      showToast(okText);
      setTimeout(() => window.location.reload(), 600);
    } catch (error) {
      showToast(`실패: ${String(error)}`, true);
    } finally {
      setBusy(false);
    }
  }

  const patchDeal = (patch: Record<string, unknown>, okText: string) =>
    request(
      `/api/admin/deal/${deal.dealId}`,
      { method: "PATCH", body: JSON.stringify(patch) },
      okText,
    );

  const dealAction = (action: string, okText: string) =>
    request(
      `/api/admin/deal/${deal.dealId}`,
      { method: "POST", body: JSON.stringify({ action }) },
      okText,
    );

  const patchPost = (patch: Record<string, unknown>, okText: string) =>
    request(
      `/api/admin/post/${deal.postRowid}`,
      { method: "PATCH", body: JSON.stringify(patch) },
      okText,
    );

  const imageAction = (body: Record<string, unknown>, okText: string) =>
    request(
      `/api/admin/image`,
      { method: "POST", body: JSON.stringify({ key: deal.productKey, ...body }) },
      okText,
    );

  function saveOverrides() {
    void patchDeal(
      {
        name_override: name.trim() === "" ? null : name,
        price_override:
          price.trim() === "" ? null : Number(price),
        category_override: category === "" ? null : category,
        store_override: store.trim() === "" ? null : store,
        url_override: purchaseUrl.trim() === "" ? null : purchaseUrl.trim(),
      },
      "수동 수정을 저장했습니다",
    );
  }

  const status = deal.postStatusOverride ?? deal.postStatus;
  const dirty =
    name !== (deal.nameOverride ?? "") ||
    price !== (deal.priceOverride !== null ? String(deal.priceOverride) : "") ||
    category !== (deal.categoryOverride ?? "") ||
    store !== (deal.storeOverride ?? "") ||
    purchaseUrl !== (deal.urlOverride ?? "") ||
    imageUrl !== (deal.imageOverride ?? "");

  return (
    <div className="admin-grid">
      {/* 왼쪽: 필드 편집 ---------------------------------- */}
      <div>
        <div className="admin-card">
          <h2>필드 수동 수정</h2>

          <div className="field">
            <label>상품명</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="(비우면 파서 값 사용)"
            />
            <div
              className={
                deal.nameOverride && deal.nameOverride !== deal.productName
                  ? "parser-hint diff"
                  : "parser-hint"
              }
            >
              파서 값: {deal.productName ?? "(없음)"}
            </div>
          </div>

          <div className="field">
            <label>가격 (원화 표시값)</label>
            <input
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="(비우면 파서 값 사용)"
              min={0}
            />
            <div
              className={
                deal.priceOverride !== null
                  ? "parser-hint diff"
                  : "parser-hint"
              }
            >
              파서 값: {deal.priceText} ({deal.currency})
            </div>
          </div>

          <div className="field">
            <label>카테고리</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">(파서 값 사용)</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <div className="parser-hint">
              파서 값: {deal.category ?? "(없음)"}
            </div>
          </div>

          <div className="field">
            <label>쇼핑몰</label>
            <input
              type="text"
              list="admin-stores"
              value={store}
              onChange={(e) => setStore(e.target.value)}
              placeholder="(비우면 파서 값 사용)"
            />
            <datalist id="admin-stores">
              {stores.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <div className="parser-hint">
              파서 값: {deal.store ?? "(없음)"}
            </div>
          </div>

          <div className="field">
            <label>구매링크</label>
            <input
              type="text"
              value={purchaseUrl}
              onChange={(e) => setPurchaseUrl(e.target.value)}
              placeholder="https://… (비우면 파서 값 사용)"
            />
            <div
              className={
                deal.urlOverride ? "parser-hint diff" : "parser-hint"
              }
            >
              파서 값 ({deal.urlType}): {deal.productUrl ?? "(없음)"}
            </div>
          </div>

          <div className="abtn-row">
            <button
              className="abtn primary"
              disabled={busy || !dirty}
              onClick={saveOverrides}
            >
              저장
            </button>
            <button
              className="abtn"
              disabled={busy}
              onClick={() =>
                void dealAction("clear", "오버라이드를 전부 해제했습니다")
              }
            >
              <RotateCcw size={13} /> 전체 되돌리기
            </button>
          </div>
        </div>

        <div className="admin-card" style={{ marginTop: 16 }}>
          <h2>썸네일</h2>

          {deal.productKey === null ? (
            <div className="parser-hint">
              구매 링크가 없어 상품 키가 없습니다.
            </div>
          ) : (
            <>
              {(deal.imageOverride ?? deal.imageUrl) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={(deal.imageOverride ?? deal.imageUrl) as string}
                  alt=""
                  style={{
                    width: 96,
                    height: 96,
                    objectFit: "cover",
                    borderRadius: 10,
                    border: "1px solid var(--border)",
                    marginBottom: 10,
                  }}
                />
              ) : (
                <div className="parser-hint" style={{ marginBottom: 10 }}>
                  확보된 이미지가 없습니다 (로고 폴백 표시 중).
                </div>
              )}

              <div className="field">
                <label>수동 이미지 URL</label>
                <div className="field-row">
                  <input
                    type="text"
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    placeholder="https://…"
                  />
                  <button
                    className="abtn primary"
                    disabled={busy || imageUrl === (deal.imageOverride ?? "")}
                    onClick={() =>
                      void imageAction(
                        { url: imageUrl.trim() === "" ? null : imageUrl.trim() },
                        imageUrl.trim() === ""
                          ? "수동 지정을 해제했습니다"
                          : "수동 썸네일을 저장했습니다",
                      )
                    }
                  >
                    저장
                  </button>
                </div>
                <div className="parser-hint">
                  자동 수집: {deal.imageUrl ?? "(없음)"}
                  {deal.imageOverride && " · 수동 지정 우선 적용 중"}
                </div>
              </div>

              <div className="abtn-row">
                <button
                  className="abtn"
                  disabled={busy}
                  onClick={() =>
                    void imageAction({ reset: 1 }, "캐시를 초기화했습니다 — 다음 수집에서 재시도")
                  }
                >
                  캐시 초기화 (재시도)
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 오른쪽: 상태·관측 ---------------------------------- */}
      <div>
        <div className="admin-card">
          <h2>상태 · 노출</h2>

          <p className="parser-hint" style={{ marginBottom: 10 }}>
            수집기 판정: {deal.postStatus}
            {deal.postStatusOverride && ` → 수동 "${deal.postStatusOverride}" 고정 중`}
          </p>

          <div className="abtn-row" style={{ marginTop: 0 }}>
            <button
              className="abtn"
              disabled={busy}
              onClick={() =>
                void patchPost({ status_override: "active" }, "진행중으로 고정했습니다")
              }
            >
              진행중 고정
            </button>
            <button
              className="abtn"
              disabled={busy}
              onClick={() =>
                void patchPost({ status_override: "ended" }, "종료로 고정했습니다")
              }
            >
              종료 고정
            </button>
            {deal.postStatusOverride && (
              <button
                className="abtn"
                disabled={busy}
                onClick={() =>
                  void patchPost({ status_override: null }, "수동 고정을 해제했습니다")
                }
              >
                <RotateCcw size={13} /> 해제
              </button>
            )}
          </div>

          <div className="abtn-row">
            <button
              className="abtn"
              disabled={busy}
              onClick={() =>
                void patchDeal(
                  { hidden: deal.hidden === 1 ? 0 : 1 },
                  deal.hidden === 1 ? "숨김 해제" : "딜을 숨겼습니다",
                )
              }
            >
              {deal.hidden === 1 ? "딜 숨김 해제" : "딜 숨기기"}
            </button>
            <button
              className="abtn"
              disabled={busy}
              onClick={() =>
                void patchPost(
                  { hidden: deal.postHidden === 1 ? 0 : 1 },
                  deal.postHidden === 1 ? "게시글 숨김 해제" : "게시글을 숨겼습니다",
                )
              }
            >
              {deal.postHidden === 1 ? "게시글 숨김 해제" : "게시글 숨기기"}
            </button>
          </div>

          {(deal.excludedReason || deal.exclusionRestored === 1) && (
            <div className="abtn-row">
              {deal.excludedReason ? (
                <button
                  className="abtn primary"
                  disabled={busy}
                  onClick={() =>
                    void dealAction("restore", "제외를 복원했습니다 — 다음 적재부터 노출")
                  }
                >
                  제외 복원 ({deal.excludedReason})
                </button>
              ) : (
                <button
                  className="abtn danger"
                  disabled={busy}
                  onClick={() =>
                    void dealAction("reexclude", "복원을 철회했습니다 — 규칙에 따라 재제외")
                  }
                >
                  복원 철회
                </button>
              )}
            </div>
          )}
        </div>

        <div className="admin-card" style={{ marginTop: 16 }}>
          <h2>가격 히스토리 ({deal.observations.length})</h2>

          {deal.observations.length === 0 ? (
            <div className="parser-hint">관측 기록이 없습니다.</div>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>가격</th>
                  <th>상태</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {deal.observations.map((o) => (
                  <tr key={o.id}>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {o.observedAt.slice(0, 16).replace("T", " ")}
                    </td>
                    <td>
                      {o.dealPrice === null
                        ? "-"
                        : `${o.dealPrice.toLocaleString("ko-KR")} ${o.currency ?? ""}`}
                    </td>
                    <td>
                      <span
                        className={
                          o.postStatus === "ended" ? "badge ended" : "badge live"
                        }
                      >
                        {o.postStatus === "ended"
                          ? "종료"
                          : o.postStatus === "active"
                            ? "진행"
                            : "모름"}
                      </span>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button
                        className="abtn"
                        disabled={busy}
                        onClick={() => {
                          const input = window.prompt(
                            "새 가격 (원화 숫자)",
                            o.dealPrice === null ? "" : String(o.dealPrice),
                          );
                          if (input === null) return;

                          const value = Number(input);
                          if (!Number.isFinite(value) || value < 0) {
                            showToast("숫자만 입력할 수 있습니다", true);
                            return;
                          }

                          void request(
                            `/api/admin/observation/${o.id}`,
                            {
                              method: "PATCH",
                              body: JSON.stringify({ deal_price: value }),
                            },
                            "관측 가격을 수정했습니다",
                          );
                        }}
                      >
                        수정
                      </button>{" "}
                      <button
                        className="abtn danger"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `${o.observedAt.slice(0, 16)} 관측을 삭제할까요? 되돌릴 수 없습니다.`,
                            )
                          ) {
                            return;
                          }

                          void request(
                            `/api/admin/observation/${o.id}`,
                            { method: "DELETE" },
                            "관측을 삭제했습니다",
                          );
                        }}
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {toast && (
        <div className={toast.error ? "toast error" : "toast"}>{toast.text}</div>
      )}
    </div>
  );
}
