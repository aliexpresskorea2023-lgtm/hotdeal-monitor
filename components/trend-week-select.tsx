"use client";

import { useRouter } from "next/navigation";

/*
 * 주차 드롭다운 — 선택 즉시 쿼리스트링만 바꿔 서버 재렌더.
 * (차트 유형·카테고리는 서버에서 함께 유지된다.)
 */

export function TrendWeekSelect({
  weeks,
  currentYmd,
  chartType,
  categoryId,
}: {
  weeks: ReadonlyArray<{ ymd: string; label: string }>;
  currentYmd: string;
  chartType: string;
  categoryId: string;
}) {
  const router = useRouter();

  return (
    <select
      className="week-select"
      aria-label="기간 선택"
      value={currentYmd}
      onChange={(event) => {
        const params = new URLSearchParams({
          type: chartType,
          cat: categoryId,
          ymd: event.target.value,
        });

        router.push(`/trends?${params.toString()}`);
      }}
    >
      {weeks.map((week) => (
        <option key={week.ymd} value={week.ymd}>
          {week.label}
        </option>
      ))}
    </select>
  );
}
