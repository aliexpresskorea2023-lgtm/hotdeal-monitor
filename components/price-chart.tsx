"use client";

import { useRef, useState, type MouseEvent } from "react";
import type { PricePoint } from "@/src/db/history";
import { formatNumber, formatPrice, formatTime } from "@/src/lib/format";

/*
 * 최저가 히스토리 선형 차트 (클라이언트).
 *
 * 서버가 넘겨준 관측 시계열을 그리되, 마우스를 올리면 가장 가까운 관측점에
 * 십자선·하이라이트 점과 함께 "집계 날짜 + 가격" 툴팁을 띄운다. 차트 y축은
 * 원화 환산값(estimatedKrw ?? price)이라 통화 혼합 딜도 한 축에 그려지고,
 * 툴팁에는 원문 통화 표기를 우선 보여주며 외국 통화면 환산 원화를 덧붙인다.
 *
 * 좌표는 viewBox(720×240) 기준 — SVG가 반응형으로 스케일되므로 마우스 위치는
 * 래퍼 박스 대비 비율로 되돌려 인덱스를 찾고, 툴팁도 %로 배치해 스케일을 탄다.
 */

const W = 720;
const H = 240;
const P = 40;

function valueOf(point: PricePoint): number | null {
  return point.estimatedKrw ?? point.price;
}

type SeriesPoint = {
  value: number;
  at: string;
  price: number | null;
  currency: string | null;
};

export function PriceChart({ points }: { points: PricePoint[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const series: SeriesPoint[] = points
    .map((point) => ({
      value: valueOf(point),
      at: point.observedAt,
      price: point.price,
      currency: point.currency,
    }))
    .filter((p): p is SeriesPoint => p.value !== null);

  if (series.length < 2) {
    return <div className="empty">구간 내 관측이 2건 미만입니다.</div>;
  }

  const values = series.map((s) => s.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const coords = series.map((s, i) => ({
    x: P + (i / (series.length - 1)) * (W - P * 2),
    y: H - P - ((s.value - min) / span) * (H - P * 2),
  }));

  const line = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const area = `${P},${H - P} ${line} ${coords[coords.length - 1].x.toFixed(1)},${H - P}`;
  const last = coords[coords.length - 1];

  function onMove(e: MouseEvent<HTMLDivElement>) {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;

    /* 래퍼 대비 비율 → viewBox x → 가장 가까운 관측 인덱스. */
    const viewX = ((e.clientX - rect.left) / rect.width) * W;
    const raw = ((viewX - P) / (W - P * 2)) * (series.length - 1);
    const idx = Math.max(0, Math.min(series.length - 1, Math.round(raw)));
    setHover(idx);
  }

  const hc = hover !== null ? coords[hover] : null;
  const hp = hover !== null ? series[hover] : null;

  let displayPrice = "";
  let krwNote = "";
  if (hp) {
    displayPrice =
      hp.price !== null
        ? formatPrice(hp.price, hp.currency ?? "KRW", "")
        : `${formatNumber(Math.round(hp.value))}원`;
    if (hp.currency && hp.currency !== "KRW" && hp.price !== null) {
      krwNote = `≈ ${formatNumber(Math.round(hp.value))}원`;
    }
  }

  const tipLeft = hc ? Math.max(12, Math.min(88, (hc.x / W) * 100)) : 0;
  const tipTop = hc ? (hc.y / H) * 100 : 0;

  return (
    <div
      className="chart-wrap"
      ref={wrapRef}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="가격 관측 차트">
        <polygon className="spark-area" points={area} />
        <polyline className="spark-line" points={line} />
        <circle className="spark-dot" cx={last.x} cy={last.y} r={4} />

        {hc && (
          <>
            <line
              className="spark-cross"
              x1={hc.x}
              y1={P - 10}
              x2={hc.x}
              y2={H - P}
            />
            <circle className="spark-hover-dot" cx={hc.x} cy={hc.y} r={5} />
          </>
        )}

        <text className="chart-axis" x={P} y={16}>
          {formatNumber(max)}원
        </text>
        <text className="chart-axis" x={P} y={H - P + 18}>
          {formatNumber(min)}원
        </text>
        <text className="chart-axis" x={P} y={H - 8}>
          {formatTime(series[0].at)}
        </text>
        <text className="chart-axis" x={W - P} y={H - 8} textAnchor="end">
          {formatTime(series[series.length - 1].at)}
        </text>
      </svg>

      {hp && hc && (
        <div
          className="chart-tip"
          style={{ left: `${tipLeft}%`, top: `${tipTop}%` }}
        >
          <div className="chart-tip-price">
            {displayPrice}
            {krwNote && <span className="chart-tip-krw">{krwNote}</span>}
          </div>
          <div className="chart-tip-date">{formatTime(hp.at)}</div>
        </div>
      )}
    </div>
  );
}
