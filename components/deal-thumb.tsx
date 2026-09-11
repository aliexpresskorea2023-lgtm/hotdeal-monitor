"use client";

import { useState } from "react";

/*
 * 딜 썸네일 — 폴백 체인을 클라이언트에서 처리한다.
 * 상품 썸네일 → 본문 삽입 이미지 → 커뮤니티 로고 → 스토어 로고 순으로,
 * 앞 후보가 404거나 커뮤니티 CDN 핫링크 차단으로 깨지면 onError로
 * 다음 후보로 넘어간다. 마지막 후보(로컬 로고)까지 실패하면 그대로 둔다.
 *
 * 본문 삽입 이미지는 커뮤니티 CDN 원본을 핫링크하므로
 * referrerPolicy="no-referrer"로 referer를 지워 차단(fmkorea/ppomppu/ruliweb)을 우회한다.
 * 서버 컴포넌트인 페이지에서는 <img> onError를 못 쓰므로 이 클라이언트 컴포넌트로 분리.
 */
export function DealThumb({
  candidates,
  alt,
  className,
}: {
  candidates: (string | null | undefined)[];
  alt: string;
  className?: string;
}) {
  // null/빈 문자열 제거 + 중복 제거 (같은 로고가 두 번 들어오는 경우 방지).
  const list: string[] = [];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const trimmed = c.trim();
    if (trimmed === "") continue;
    if (list.includes(trimmed)) continue;
    list.push(trimmed);
  }

  const [index, setIndex] = useState(0);

  if (list.length === 0) return null;

  const src = list[Math.min(index, list.length - 1)];

  return (
    <img
      className={className}
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => {
        if (index < list.length - 1) setIndex(index + 1);
      }}
    />
  );
}
