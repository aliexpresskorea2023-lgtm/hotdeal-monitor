import { ArrowLeft, ExternalLink } from "lucide-react";
import { notFound } from "next/navigation";
import { getPriceHistory, type PricePoint } from "@/src/db/history";
import { OTHER_STORE_FILTER, STORE_FILTER_LOGOS, COMMUNITIES, COMMUNITY_LOGOS, type Community } from "@/src/db/taxonomy";
import { firstParam, hrefFor } from "@/src/lib/query";
import { formatNumber, formatPrice, formatTime, sourceLabel, statusLabel } from "@/src/lib/format";

/*
 * 최저가 히스토리 상세 — 관측 시계열 차트 + 기간 필터 + 통계 카드.
 * 기간(range)은 쿼리스트링 기반 서버 렌더: 1m/3m/6m/1y/all (기본 3m).
 * 차트 값은 원화 환산(estimatedKrw) 우선 — 통화 혼합 딜도 한 축에 그린다.
 */
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const RANGES = [
  { key: "1m", months: 1, label: "1개월" },
  { key: "3m", months: 3, label: "3개월" },
  { key: "6m", months: 6, label: "6개월" },
  { key: "1y", months: 12, label: "1년" },
  { key: "all", months: null, label: "전체" },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];

/** 원문 커뮤니티 로고 — 상품 이미지 폴백 체인의 2순위 (피드와 동일). */
function communityLogo(source: string): string | null {
  return (COMMUNITIES as readonly string[]).includes(source)
    ? COMMUNITY_LOGOS[source as Community]
    : null;
}

function valueOf(point: PricePoint): number | null {
  return point.estimatedKrw ?? point.price;
}

function PriceChart({ points }: { points: PricePoint[] }) {
  const series = points
    .map((point) => ({ value: valueOf(point), at: point.observedAt }))
    .filter((p): p is { value: number; at: string } => p.value !== null);

  if (series.length < 2) {
    return <div className="empty">구간 내 관측이 2건 미만입니다.</div>;
  }

  const W = 720;
  const H = 240;
  const P = 40;

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

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="가격 관측 차트">
      <polygon className="spark-area" points={area} />
      <polyline className="spark-line" points={line} />
      <circle className="spark-dot" cx={last.x} cy={last.y} r={4} />
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
  );
}

function pointDate(points: PricePoint[], target: number | null): string | null {
  if (target === null) return null;
  const hit = points.find((p) => (p.estimatedKrw ?? p.price) === target);
  return hit ? hit.observedAt : null;
}

export default async function HistoryDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const raw = await searchParams;

  const dealId = Number.parseInt(id, 10);
  if (Number.isNaN(dealId)) notFound();

  const rawRange = firstParam(raw.range);
  const range: RangeKey = RANGES.some((r) => r.key === rawRange)
    ? (rawRange as RangeKey)
    : "3m";
  const rangeDef = RANGES.find((r) => r.key === range)!;

  const { items } = getPriceHistory({ limit: 1000 });
  const item = items.find((i) => i.dealId === dealId);
  if (!item) notFound();

  const cutoff =
    rangeDef.months === null
      ? null
      : (() => {
          const d = new Date();
          d.setMonth(d.getMonth() - rangeDef.months);
          return d;
        })();

  const points = cutoff
    ? item.points.filter((p) => new Date(p.observedAt) >= cutoff!)
    : item.points;

  const values = points
    .map(valueOf)
    .filter((v): v is number => v !== null);
  const avg =
    values.length > 0
      ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
      : null;
  const highest = values.length > 0 ? Math.max(...values) : null;
  const lowest = values.length > 0 ? Math.min(...values) : null;
  const first = values[0] ?? null;
  const lastV = values[values.length - 1] ?? null;
  const change = first !== null && lastV !== null ? lastV - first : null;
  const changePct =
    change !== null && first ? Math.round((change / first) * 1000) / 10 : null;

  const logo =
    item.storeNorm in STORE_FILTER_LOGOS
      ? STORE_FILTER_LOGOS[item.storeNorm]
      : STORE_FILTER_LOGOS[OTHER_STORE_FILTER];

  const current: Record<string, string> = {};
  if (range !== "3m") current.range = range;

  return (
    <>
      <a className="backlink" href="/history">
        <ArrowLeft size={15} />
        최저가 히스토리
      </a>

      <div className="detail-head">
        <div className="thumb">
          <img
            src={item.imageUrl ?? communityLogo(item.community) ?? logo}
            alt={item.storeNorm}
          />
        </div>

        <div className="row-grow">
          <div className="store-line">
            <img src={logo} alt="" />
            {item.storeNorm}
            <span>· {sourceLabel(item.community)}</span>
          </div>
          <h1 className="detail-title-h">{item.name ?? item.postTitle}</h1>
          <div className="tagrow">
            <span className={item.status === "ended" ? "tag ended" : "tag live"}>
              {statusLabel(item.status)}
            </span>
            <span className="tag">{item.categoryNorm}</span>
            <span className="tag">관측 {item.points.length}회</span>
          </div>
        </div>

        <div className="detail-rail">
          <span className="price-sub">현재가</span>
          <span className="price" style={{ fontSize: 22 }}>
            {formatPrice(item.currentPrice, item.currency, "")}
          </span>
          <a
            className="btn-primary"
            href={item.url ?? item.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            상품 보기
            <ExternalLink size={14} />
          </a>
        </div>
      </div>

      <div className="chart-box">
        <div className="head-actions" style={{ margin: "0 0 14px" }}>
          <span className="flabel" style={{ width: "auto" }}>기간</span>
          {RANGES.map((r) => (
            <a
              key={r.key}
              className={range === r.key ? "fchip active" : "fchip"}
              href={hrefFor(`/history/${dealId}`, current, { range: r.key === "3m" ? null : r.key })}
            >
              {r.label}
            </a>
          ))}
        </div>

        <PriceChart points={points} />
      </div>

      <div className="stat-cards">
        <div className="stat-card">
          <div className="lab">평균가</div>
          <div className="val">{avg !== null ? `${formatNumber(avg)}원` : "-"}</div>
          <div className="sub">구간 관측 {values.length}건</div>
        </div>
        <div className="stat-card">
          <div className="lab">최고가</div>
          <div className="val">{highest !== null ? `${formatNumber(highest)}원` : "-"}</div>
          <div className="sub">
            {pointDate(points, highest) && (
              <a
                href={item.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="이 가격이 적힌 원문 게시글"
              >
                {formatTime(pointDate(points, highest)!)}
                <ExternalLink size={11} />
              </a>
            )}
          </div>
        </div>
        <div className="stat-card">
          <div className="lab">최저가</div>
          <div className="val">{lowest !== null ? `${formatNumber(lowest)}원` : "-"}</div>
          <div className="sub">
            {pointDate(points, lowest) && (
              <a
                href={item.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="이 가격이 적힌 원문 게시글"
              >
                {formatTime(pointDate(points, lowest)!)}
                <ExternalLink size={11} />
              </a>
            )}
          </div>
        </div>
        <div className="stat-card">
          <div className="lab">가격 변동</div>
          <div className={change !== null && change < 0 ? "val down" : "val"}>
            {change === null
              ? "-"
              : `${change > 0 ? "+" : ""}${formatNumber(change)}원`}
          </div>
          <div className="sub">
            {changePct === null ? "" : `${changePct > 0 ? "+" : ""}${changePct}%`}
          </div>
        </div>
      </div>
    </>
  );
}
