"use client";

import { useState } from "react";

/*
 * 제외/미분류 관리 — 미분류 딜 인라인 카테고리 지정.
 * 선택 즉시 /api/admin/deal/[id] PATCH category_override.
 * 수동 지정한 카테고리는 인제스트가 갱신하지 않는 오버라이라
 * 다음 수집 이후에도 유지된다.
 */

type Props = {
  dealId: number;
  categories: string[];
};

export function CategoryPicker({ dealId, categories }: Props) {
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  function showToast(text: string, error = false) {
    setToast({ text, error });
    setTimeout(() => setToast(null), 2600);
  }

  async function assign(value: string) {
    if (value === "") return;

    setBusy(true);

    try {
      const res = await fetch(`/api/admin/deal/${dealId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category_override: value }),
      });

      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(parsed?.error ?? `HTTP ${res.status}`);
      }

      showToast(`카테고리를 "${value}"로 지정했습니다`);
      setTimeout(() => window.location.reload(), 600);
    } catch (error) {
      showToast(`실패: ${String(error)}`, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="field" style={{ marginBottom: 0, maxWidth: 180 }}>
        <select
          defaultValue=""
          disabled={busy}
          onChange={(e) => void assign(e.target.value)}
        >
          <option value="">카테고리 선택…</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      {toast && (
        <div className={toast.error ? "toast error" : "toast"}>{toast.text}</div>
      )}
    </>
  );
}
