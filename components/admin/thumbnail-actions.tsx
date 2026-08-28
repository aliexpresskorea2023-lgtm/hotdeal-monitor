"use client";

import { useState } from "react";

/*
 * 썸네일 관리 — 행 단위 액션 (클라이언트 아일랜드).
 * 쓰기는 전부 /api/admin/image 로. 저장 성공 시 서버 재렌더 새로고침.
 */

type Props = {
  productKey: string;
  imageUrl: string | null;
  imageOverride: string | null;
};

export function ThumbnailActions({
  productKey,
  imageUrl,
  imageOverride,
}: Props) {
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  function showToast(text: string, error = false) {
    setToast({ text, error });
    setTimeout(() => setToast(null), 2600);
  }

  async function request(body: Record<string, unknown>, okText: string) {
    setBusy(true);

    try {
      const res = await fetch("/api/admin/image", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: productKey, ...body }),
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

  function setManualUrl() {
    const answer = window.prompt(
      "썸네일 이미지 URL (http/https 절대 경로)",
      imageOverride ?? imageUrl ?? "",
    );
    if (answer === null) return;

    const trimmed = answer.trim();
    if (!/^https?:\/\//.test(trimmed)) {
      showToast("http(s) 절대 URL만 지정할 수 있습니다", true);
      return;
    }

    void request({ url: trimmed }, "수동 썸네일을 저장했습니다");
  }

  function clearOverride() {
    void request({ url: null }, "수동 지정을 해제했습니다");
  }

  function resetCache() {
    const ok = window.confirm(
      "캐시를 초기화할까요? 수동 지정도 함께 삭제되고, 다음 파이프라인 실행 시 자동 수집을 재시도합니다.",
    );
    if (!ok) return;

    void request({ reset: 1 }, "캐시를 초기화했습니다");
  }

  return (
    <div className="abtn-row" style={{ marginTop: 0 }}>
      <button className="abtn" onClick={setManualUrl} disabled={busy}>
        URL 지정
      </button>
      {imageOverride && (
        <button className="abtn" onClick={clearOverride} disabled={busy}>
          해제
        </button>
      )}
      <button className="abtn danger" onClick={resetCache} disabled={busy}>
        캐시 초기화
      </button>
      {toast && (
        <div className={toast.error ? "toast error" : "toast"}>{toast.text}</div>
      )}
    </div>
  );
}
