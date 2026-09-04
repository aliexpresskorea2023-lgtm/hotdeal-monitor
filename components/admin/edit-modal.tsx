"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

/*
 * 공개 페이지(핫딜 모음·히스토리·랭킹)의 "수정" 버튼.
 *
 * 클릭하면 페이지를 떠나지 않고 모달 레이어 안에서 어드민 편집 페이지를
 * iframe(?embed=1 → 사이드바 등 chrome 숨김)으로 연다.
 *
 * - 일반(좌) 클릭: 모달. ctrl/cmd/shift/alt 클릭·중간 클릭은 기본 <a> 동작
 *   (새 탭)을 허용 — href를 유지해 폴백.
 * - Esc·배경 클릭: 닫기. 닫을 때 router.refresh()로 서버 컴포넌트(피드)를
 *   갱신 — D1 실시간 반영과 맞물려 편집 결과가 목록에 곧바로 보인다.
 * - iframe은 동일 오리진이라 어드민 세션 쿠키(SameSite=lax)가 그대로 전송된다.
 */

export function AdminEditLink({
  dealId,
  className = "btn ghost admin-edit",
  label = "수정",
}: {
  dealId: number | string;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  function close() {
    setOpen(false);
    router.refresh();
  }

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <a
        className={className}
        href={`/admin/deals/${dealId}`}
        title="팝업에서 카드 수정"
        onClick={(e) => {
          // 보조 클릭·수정키 클릭은 브라우저 기본 동작(새 탭)으로
          if (
            e.defaultPrevented ||
            e.button !== 0 ||
            e.metaKey ||
            e.ctrlKey ||
            e.shiftKey ||
            e.altKey
          ) {
            return;
          }
          e.preventDefault();
          setOpen(true);
        }}
      >
        {label}
      </a>

      {open && (
        <div
          className="edit-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="핫딜 카드 수정"
          onClick={close}
        >
          <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="edit-modal-bar">
              <span className="edit-modal-title">
                핫딜 카드 수정 · #{dealId}
              </span>
              <div className="edit-modal-actions">
                <a
                  className="edit-modal-newtab"
                  href={`/admin/deals/${dealId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="새 탭에서 열기"
                >
                  새 탭
                </a>
                <button
                  type="button"
                  className="edit-modal-close"
                  onClick={close}
                  aria-label="닫기"
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            <iframe
              className="edit-modal-frame"
              src={`/admin/deals/${dealId}?embed=1`}
              title={`핫딜 카드 수정 #${dealId}`}
            />
          </div>
        </div>
      )}
    </>
  );
}
