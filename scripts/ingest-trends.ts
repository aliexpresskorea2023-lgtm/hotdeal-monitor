import fs from "node:fs";
import path from "node:path";
import { DEFAULT_DB_PATH, openDb, nowKstIso } from "../src/db";

/*
 * 트렌드 매니퍼스트 적재 (2026-08-28, v1.7) — 멱등.
 *
 * collector/trends.py가 data/crawls/trends/에 쓴 매니퍼스트를
 * 트렌드 테이블로 upsert한다. 스키마는 openDb()가 schema.sql로
 * 자동 적용한다.
 *
 * - 주차(트렌드 주 키)·키워드 랭킹: 같은 (차트, 주차, 카테고리, 순위)는
 *   제자리 갱신 — 당주차 데이터는 사이트가 매일 갱신하므로 상태/변동폭이
 *   최신값으로 따라간다.
 * - 보강(기사·유튜브·검색량): (주차, 키워드) 단위. 매니퍼스트는 그 실행에서
 *   수집한 필드만 들고 오므로 기존값을 COALESCE로 보존하며 병합한다.
 *
 * 실행: npx tsx scripts/ingest-trends.ts
 */

interface ManifestWeek {
  chart_type: string;
  ymd: string;
  month: number | null;
  week: number | null;
}

interface ManifestKeyword {
  chart_type: string;
  ymd: string;
  category_id: string;
  category_name: string;
  rank: number;
  keyword: string;
  sub_title: string | null;
  status: string;
  fluctuation: number;
  sync_date: string | null;
  rank_id: string | null;
}

interface ManifestEnrichment {
  ymd: string;
  keyword: string;
  news_count?: number | null;
  news_sample?: unknown;
  news_fetched_at?: string | null;
  youtube_count?: number | null;
  youtube_fetched_at?: string | null;
  youtube_top?: unknown;
  monthly_pc_qc?: number | null;
  monthly_mobile_qc?: number | null;
  ads_fetched_at?: string | null;
}

interface Manifest {
  generated_at: string;
  weeks: ManifestWeek[];
  keywords: ManifestKeyword[];
  enrichment: ManifestEnrichment[];
}

const VALID_STATUS = new Set(["STABLE", "NEW", "UP", "DOWN", "SOAR"]);
const VALID_CHART = new Set(["popular", "new"]);

function main(): void {
  const dir = path.join(process.cwd(), "data", "crawls", "trends");

  if (!fs.existsSync(dir)) {
    console.log("트렌드 매니퍼스트 없음 — 생략.");
    return;
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    console.log("트렌드 매니퍼스트 없음 — 생략.");
    return;
  }

  const db = openDb(DEFAULT_DB_PATH);

  /* 마이그레이션 가드 — 기존 DB는 CREATE TABLE IF NOT EXISTS로 컬럼이
   * 추가되지 않으므로 멱등 ALTER. (신규 컬럼: youtube_top, 2026-08-28) */
  const enrichCols = new Set(
    (
      db.prepare("PRAGMA table_info(trend_enrichment)").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name),
  );
  if (!enrichCols.has("youtube_top")) {
    db.exec("ALTER TABLE trend_enrichment ADD COLUMN youtube_top TEXT");
  }

  let weeks = 0;
  let keywords = 0;
  let enriched = 0;
  let skipped = 0;

  try {
    db.exec("BEGIN");

    const upsertWeek = db.prepare(
      `INSERT INTO trend_weeks (chart_type, ymd, month, week, collected_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chart_type, ymd) DO UPDATE SET
         month = excluded.month,
         week = excluded.week,
         collected_at = excluded.collected_at`,
    );

    const upsertKeyword = db.prepare(
      `INSERT INTO trend_keywords
         (chart_type, ymd, category_id, category_name, rank, keyword,
          sub_title, status, fluctuation, sync_date, rank_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chart_type, ymd, category_id, rank) DO UPDATE SET
         category_name = excluded.category_name,
         keyword = excluded.keyword,
         sub_title = excluded.sub_title,
         status = excluded.status,
         fluctuation = excluded.fluctuation,
         sync_date = excluded.sync_date,
         rank_id = excluded.rank_id`,
    );

    const upsertEnrich = db.prepare(
      `INSERT INTO trend_enrichment
         (ymd, keyword, news_count, news_sample, news_fetched_at,
          youtube_count, youtube_fetched_at, youtube_top,
          monthly_pc_qc, monthly_mobile_qc, ads_fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ymd, keyword) DO UPDATE SET
         news_count = COALESCE(excluded.news_count, trend_enrichment.news_count),
         news_sample = COALESCE(excluded.news_sample, trend_enrichment.news_sample),
         news_fetched_at = COALESCE(excluded.news_fetched_at, trend_enrichment.news_fetched_at),
         youtube_count = COALESCE(excluded.youtube_count, trend_enrichment.youtube_count),
         youtube_fetched_at = COALESCE(excluded.youtube_fetched_at, trend_enrichment.youtube_fetched_at),
         youtube_top = COALESCE(excluded.youtube_top, trend_enrichment.youtube_top),
         monthly_pc_qc = COALESCE(excluded.monthly_pc_qc, trend_enrichment.monthly_pc_qc),
         monthly_mobile_qc = COALESCE(excluded.monthly_mobile_qc, trend_enrichment.monthly_mobile_qc),
         ads_fetched_at = COALESCE(excluded.ads_fetched_at, trend_enrichment.ads_fetched_at)`,
    );

    for (const file of files) {
      let manifest: Manifest;

      try {
        manifest = JSON.parse(
          fs.readFileSync(path.join(dir, file), "utf-8"),
        ) as Manifest;
      } catch (err) {
        console.warn(`  ! ${file} 파싱 실패 — 건너뜀 (${err})`);
        continue;
      }

      const collectedAt = manifest.generated_at ?? nowKstIso();

      for (const week of manifest.weeks ?? []) {
        if (!VALID_CHART.has(week.chart_type)) continue;

        upsertWeek.run(
          week.chart_type,
          week.ymd,
          week.month ?? null,
          week.week ?? null,
          collectedAt,
        );
        weeks += 1;
      }

      for (const row of manifest.keywords ?? []) {
        if (
          !VALID_CHART.has(row.chart_type) ||
          !VALID_STATUS.has(row.status) ||
          !row.keyword ||
          !Number.isFinite(row.rank)
        ) {
          skipped += 1;
          continue;
        }

        upsertKeyword.run(
          row.chart_type,
          row.ymd,
          row.category_id,
          row.category_name,
          row.rank,
          row.keyword,
          row.sub_title ?? null,
          row.status,
          row.fluctuation ?? 0,
          row.sync_date ?? null,
          row.rank_id ?? null,
        );
        keywords += 1;
      }

      for (const row of manifest.enrichment ?? []) {
        if (!row.ymd || !row.keyword) {
          skipped += 1;
          continue;
        }

        upsertEnrich.run(
          row.ymd,
          row.keyword,
          row.news_count ?? null,
          row.news_sample
            ? JSON.stringify(row.news_sample)
            : null,
          row.news_fetched_at ?? null,
          row.youtube_count ?? null,
          row.youtube_fetched_at ?? null,
          row.youtube_top
            ? JSON.stringify(row.youtube_top)
            : null,
          row.monthly_pc_qc ?? null,
          row.monthly_mobile_qc ?? null,
          row.ads_fetched_at ?? null,
        );
        enriched += 1;
      }
    }

    db.exec("COMMIT");

    console.log(
      `트렌드 적재 완료: 주차 ${weeks}, 키워드 ${keywords}, ` +
        `보강 ${enriched} (스킵 ${skipped}, 매니퍼스트 ${files.length}개)`,
    );
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.close();
  }
}

main();
