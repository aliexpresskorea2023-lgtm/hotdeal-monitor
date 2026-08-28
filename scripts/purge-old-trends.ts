import { openDb } from "../src/db";

/*
 * 트렌드 보관 주기 정리 (2026-08-28, v1.7) — 13주 롤링.
 *
 * 차트별로 가장 최근 N개 주차만 남기고 오래된 주차를 삭제한다.
 * 트렌드 데이터는 오래 쌓아도 쓸모가 없다는 판단(2026-08-28)에 따른
 * 보관 정책이다. 대상:
 *
 * - trend_keywords: (chart_type, ymd) 기준 옛 주차 행 삭제.
 * - trend_weeks: 같은 기준.
 * - trend_enrichment: ymd 기준 — 어떤 차트에도 남지 않는 주차만 삭제.
 *
 * 수집단(collector/trends.py)도 같은 주기로 상한을 맞춰, 정리된
 * 주차를 다음 수집에서 다시 가져오는 왕복이 없도록 한다.
 *
 * 주의: 삭제는 되돌릴 수 없지만, 배포마다 DB 전체가 git에 커밋되어
 * 과거 시점 데이터는 히스토리에서 복원 가능하다.
 *
 * 실행: npx tsx scripts/purge-old-trends.ts [--keep-weeks 13] [--dry-run]
 */

const DEFAULT_KEEP_WEEKS = 13;

function parseArgs(argv: string[]): {
  keepWeeks: number;
  dryRun: boolean;
} {
  let keepWeeks = DEFAULT_KEEP_WEEKS;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--keep-weeks") {
      keepWeeks = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    }
  }

  if (!Number.isInteger(keepWeeks) || keepWeeks < 2) {
    console.error("--keep-weeks는 2 이상의 정수여야 합니다");
    process.exit(1);
  }

  return { keepWeeks, dryRun };
}

function main() {
  const { keepWeeks, dryRun } = parseArgs(process.argv.slice(2));
  const db = openDb();

  // 차트별 전체 주차(내림차순) — 앞의 N개만 유지.
  const pairs = db
    .prepare(
      "SELECT DISTINCT chart_type, ymd FROM trend_keywords ORDER BY chart_type, ymd DESC",
    )
    .all() as { chart_type: string; ymd: string }[];

  const keepByChart = new Map<string, string[]>();
  for (const { chart_type, ymd } of pairs) {
    const list = keepByChart.get(chart_type) ?? [];
    if (list.length < keepWeeks) list.push(ymd);
    keepByChart.set(chart_type, list);
  }

  const allKeep = new Set<string>();
  for (const list of keepByChart.values()) {
    for (const ymd of list) allKeep.add(ymd);
  }

  const inList = (values: string[]) =>
    values.map(() => "?").join(", ");

  type SqlParams = (string | number | null)[];

  const countFor = (sql: string, params: SqlParams): number =>
    (db.prepare(sql).get(...params) as { n: number }).n;

  let delKeywords = 0;
  let delWeeks = 0;
  let delEnrichment = 0;
  let purgedWeeks = 0;

  const apply = dryRun
    ? (sql: string, params: SqlParams): number =>
        countFor(sql.replace("DELETE FROM", "SELECT COUNT(*) AS n FROM"), params)
    : (sql: string, params: SqlParams): number =>
        Number(db.prepare(sql).run(...params).changes);

  if (!dryRun) db.exec("BEGIN");
  try {
    for (const [chart, keep] of keepByChart) {
      purgedWeeks += Math.max(
        0,
        pairs.filter((p) => p.chart_type === chart).length - keep.length,
      );

      delKeywords += apply(
        `DELETE FROM trend_keywords WHERE chart_type = ? AND ymd NOT IN (${inList(keep)})`,
        [chart, ...keep],
      );
      delWeeks += apply(
        `DELETE FROM trend_weeks WHERE chart_type = ? AND ymd NOT IN (${inList(keep)})`,
        [chart, ...keep],
      );
    }

    if (allKeep.size > 0) {
      delEnrichment += apply(
        `DELETE FROM trend_enrichment WHERE ymd NOT IN (${inList([...allKeep])})`,
        [...allKeep],
      );
    }

    if (!dryRun) db.exec("COMMIT");
  } catch (err) {
    if (!dryRun) db.exec("ROLLBACK");
    throw err;
  }

  const verb = dryRun ? "정리 예정" : "정리 완료";
  if (purgedWeeks === 0 && delKeywords === 0) {
    console.log(
      `트렌드 ${verb}: 보관 주기(${keepWeeks}주) 내 — 삭제 대상 없음`,
    );
  } else {
    console.log(
      `트렌드 ${verb}: 주차 ${purgedWeeks}개 / 키워드 ${delKeywords}행 / 주차 메타 ${delWeeks}행 / 보강 ${delEnrichment}행 삭제 (보관 ${keepWeeks}주)`,
    );
  }

  db.close();
}

main();
