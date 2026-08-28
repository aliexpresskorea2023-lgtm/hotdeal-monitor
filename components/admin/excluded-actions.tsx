"use client";

import { useState } from "react";

/*
 * 제외/미분류 관리 — 제외 딜 복원·복원 철회 액션.
 * 쓰기는 /api/admin/deal/[id] POST 액션으로.
 */

type Props = {
  dealId: number;
  restored: boolean;
};

export function ExcludedActions({ dealId, restored }: Props) {
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  function showToast(text: string, error = false) {
    setToast({ text, error });
    setTimeout(() => setToast(null), 2600);
  }

  async function act(action: "restore" | "reexclude", okText: string) {
    setBusy(true);

    try {
      const res = await fetch(`/api/admin/deal/${dealId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });

      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(parsed?.error ?? `HTTP ${res.status}`);
      }

      showToast(okText);
      setTimeout(() => window.location.reload(), 600);
    } catch (error) {
      showToast(`실패: ${String(error)}`, true);
    } finally {
      setBusy(false);
    }
  }

  function reexclude() {
    const ok = window.confirm(
      "복원을 철회할까요? 다음 인제스트에서 제외 규칙이 다시 적용됩니다.",
    );
    if (!ok) return;

    void act("reexclude", "복원을 철회했습니다");
  }

  return (
    <div className="abtn-row" style={{ marginTop: 0 }}>
      {restored ? (
        <button className="abtn danger" onClick={reexclude} disabled={busy}>
          복원 철회
        </button>
      ) : (
        <button
          className="abtn primary"
          onClick={() => void act("restore", "제외를 복원했습니다")}
          disabled={busy}
        >
          복원
        </button>
      )}
      {toast && (
        <div className={toast.error ? "toast error" : "toast"}>{toast.text}</div>
      )}
    </div>
  );
}
