import { DEFAULT_DB_PATH, openDbReadOnly } from "./index";

/*
 * 네이버 키워드 트렌드 읽기 계층 (2026-08-28, v1.7).
 *
 * 기록은 수집기(collector/trends.py → scripts/ingest-trends.ts)가
 * 만들고, 여기는 /trends 페이지가 쓰는 조회만 모은다.
 * 핫딜 피드(queries.ts)와 마찬가지로 테이블 없으면 빈 결과 —
 * 수집 이력 없는 환경에서 페이지가 죽지 않도록.
 */

export type TrendChartType = "popular" | "new";

export const TREND_CHART_LABEL: Record<TrendChartType, string> = {
  popular: "인기 키워드",
  new: "급상승 키워드",
};

/** 사이트 카테고리 순서 그대로. 'A' = 전체. */
export const TREND_CATEGORIES: ReadonlyArray<{
  id: string;
  name: string;
}> = [
  { id: "A", name: "전체" },
  { id: "50000000", name: "패션의류" },
  { id: "50000001", name: "패션잡화" },
  { id: "50000002", name: "화장품/미용" },
  { id: "50000003", name: "디지털/가전" },
  { id: "50000004", name: "생활/건강" },
  { id: "50000005", name: "식품" },
  { id: "50000006", name: "출산/육아" },
  { id: "50000007", name: "스포츠/레저" },
  { id: "50000008", name: "자동차" },
];

export type TrendStatus = "STABLE" | "NEW" | "UP" | "DOWN" | "SOAR";

export interface TrendWeek {
  chartType: TrendChartType;
  ymd: string;
  month: number | null;
  week: number | null;
  /** "2026년 8월 4주차" — 드롭다운 표시용. */
  label: string;
}

export interface TrendNewsItem {
  title: string;
  source: string | null;
  date: string | null;
  link: string | null;
}

export interface TrendKeywordView {
  rank: number;
  keyword: string;
  subTitle: string | null;
  status: TrendStatus;
  /** 전주 대비 순위 변동폭 (사이트 제공). */
  fluctuation: number;
  categoryId: string;
  categoryName: string;
  syncDate: string | null;
  newsCount: number | null;
  newsSample: TrendNewsItem[];
  youtubeCount: number | null;
  /** 네이버 검색광고 월간 모바일 쿼리수. */
  mobileQc: number | null;
  /** 네이버 검색광고 월간 PC 쿼리수. */
  pcQc: number | null;
}

function isChartType(value: string | null | undefined): value is TrendChartType {
  return value === "popular" || value === "new";
}

/** ymd(YYYYMMDD)에서 연도 추출 — 주차 라벨용. */
function yearOf(ymd: string): string {
  return ymd.slice(0, 4);
}

function monthDayOf(ymd: string): string {
  return `${Number(ymd.slice(4, 6))}.${String(Number(ymd.slice(6, 8))).padStart(2, "0")}`;
}

function weekLabel(
  ymd: string,
  month: number | null,
  week: number | null,
): string {
  if (month !== null && week !== null) {
    return `${yearOf(ymd)}년 ${month}월 ${week}주차`;
  }

  /* 사이트 메타가 없으면 주차 시작일로 폴백. */
  return `${yearOf(ymd)}년 ${monthDayOf(ymd)} 주간`;
}

/** 수집된 주차 목록 (최신 순). */
export function getTrendWeeks(
  chartType: TrendChartType,
  dbPath: string = DEFAULT_DB_PATH,
): TrendWeek[] {
  const db = openDbReadOnly(dbPath);
  if (!db) return [];

  try {
    let rows: Array<{
      ymd: string;
      month: number | null;
      week: number | null;
    }>;

    try {
      rows = db
        .prepare(
          `SELECT ymd, month, week
           FROM trend_weeks
           WHERE chart_type = ?
           ORDER BY ymd DESC`,
        )
        .all(chartType) as Array<{
        ymd: string;
        month: number | null;
        week: number | null;
      }>;
    } catch {
      /* 테이블 미생성 — 수집 이력 없음. */
      return [];
    }

    return rows.map((r) => ({
      chartType,
      ymd: r.ymd,
      month: r.month,
      week: r.week,
      label: weekLabel(r.ymd, r.month, r.week),
    }));
  } finally {
    db.close();
  }
}

export interface TrendKeywordOptions {
  chartType: TrendChartType;
  ymd: string;
  categoryId: string;
}

/** 특정 주차·카테고리의 키워드 랭킹 + 보강 정보. */
export function getTrendKeywords(
  options: TrendKeywordOptions,
  dbPath: string = DEFAULT_DB_PATH,
): TrendKeywordView[] {
  const db = openDbReadOnly(dbPath);
  if (!db) return [];

  try {
    let raw: Record<string, unknown>[];

    try {
      raw = db
        .prepare(
          `SELECT k.rank, k.keyword, k.sub_title, k.status, k.fluctuation,
                  k.category_id, k.category_name, k.sync_date,
                  e.news_count, e.news_sample, e.youtube_count,
                  e.monthly_pc_qc, e.monthly_mobile_qc
           FROM trend_keywords k
           LEFT JOIN trend_enrichment e
             ON e.ymd = k.ymd AND e.keyword = k.keyword
           WHERE k.chart_type = ? AND k.ymd = ? AND k.category_id = ?
           ORDER BY k.rank ASC`,
        )
        .all(options.chartType, options.ymd, options.categoryId) as Record<
        string,
        unknown
      >[];
    } catch {
      return [];
    }

    return raw.map((r) => ({
      rank: r.rank as number,
      keyword: r.keyword as string,
      subTitle: (r.sub_title as string | null) ?? null,
      status: (r.status as TrendStatus) ?? "STABLE",
      fluctuation: (r.fluctuation as number) ?? 0,
      categoryId: r.category_id as string,
      categoryName: r.category_name as string,
      syncDate: (r.sync_date as string | null) ?? null,
      newsCount: (r.news_count as number | null) ?? null,
      newsSample: parseNewsSample(r.news_sample as string | null),
      youtubeCount: (r.youtube_count as number | null) ?? null,
      mobileQc: (r.monthly_mobile_qc as number | null) ?? null,
      pcQc: (r.monthly_pc_qc as number | null) ?? null,
    }));
  } finally {
    db.close();
  }
}

function parseNewsSample(raw: string | null): TrendNewsItem[] {
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (item): item is TrendNewsItem =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as TrendNewsItem).title === "string",
      )
      .slice(0, 3);
  } catch {
    return [];
  }
}

export function isValidChartType(value: string | undefined): boolean {
  return isChartType(value ?? null);
}
