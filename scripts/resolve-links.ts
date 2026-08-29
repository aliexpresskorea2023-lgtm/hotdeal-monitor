/*
 * 단축링크 해석 — 제휴 래퍼 링크의 최종 목적지를 캐시에 기록한다.
 *
 * 배경: link.coupang.com/a/... 같은 제휴 단축링크는 오프라인 정규화로
 * 상품 정체성을 알 수 없어 같은 상품인데도 병합 키가 갈라진다.
 * 리다이렉트를 따라가 목적지 URL을 link_resolutions에 기록하면,
 * 조회 계층(피드/히스토리/썸네일)이 병합 키를 합성할 때만 이를 반영한다.
 * 노출 구매링크는 제휴 귀속 유지를 위해 항상 원본을 유지한다.
 *
 * 판정 규칙:
 * - 목적지는 응답 상태와 무관하게 최종 리다이렉트 URL(res.url) 사용 —
 *   쿠팡 상품 페이지는 봇 챌린지(403/챌린지 HTML)가 떠도 목적지 자체는
 *   안정적으로 반환된다.
 * - 리다이렉트 없이 제자리거나 목적지가 여전히 단축 호스트면 실패 기록
 *   (resolved_url NULL) — 시도 회수만 늘리고 3회 도달 시 재시도 중단.
 *
 * 사용법:
 *   npx tsx scripts/resolve-links.ts [--limit N]
 *   --limit: 최대 해석 시도 수 (기본 30 — 파이프라인용 소량 배치)
 */
import { openDb, nowKstIso } from "../src/db/index";
import { isShortLinkUrl } from "../src/db/link-resolution";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const THROTTLE_MS = 1500;
const MAX_ATTEMPTS = 3;

function parseLimit(argv: string[]): number {
  const i = argv.indexOf("--limit");
  if (i < 0) return 30;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

/** 해석 성공 여부 — 목적지가 단축 호스트에 머물면 실패 취급. */
function isResolvedDestination(source: string, destination: string): boolean {
  if (!destination || destination === source) return false;
  try {
    const host = new URL(destination).host.toLowerCase();
    const srcHost = new URL(source).host.toLowerCase();
    if (host === srcHost) return false;
    return !isShortLinkUrl(destination);
  } catch {
    return false;
  }
}

async function resolveOnce(
  url: string,
): Promise<{ destination: string | null; note: string }> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
    });

    /* 상태 코드는 무관 — 목적지 URL만 취한다 (봇 챌린지 내성). */
    const destination = res.url || "";

    if (!isResolvedDestination(url, destination)) {
      return { destination: null, note: `미해결 (status ${res.status})` };
    }

    return { destination, note: `→ ${destination}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { destination: null, note: `오류 (${msg})` };
  }
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv.slice(2));
  const db = openDb();

  /* 해석 후보 — 노출 딜(숨김·제외·숨김 글 아님)의 구매링크 중 단축링크만.
   * 이미 해결됐거나 시도 소진된 행은 제외. */
  const rows = db
    .prepare(
      `SELECT DISTINCT COALESCE(d.url_override, d.product_url) AS url
       FROM deals d
       JOIN posts p ON p.id = d.post_rowid
       WHERE d.hidden = 0
         AND d.excluded_reason IS NULL
         AND p.hidden = 0
         AND COALESCE(d.url_override, d.product_url) IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM link_resolutions r
           WHERE r.source_url = COALESCE(d.url_override, d.product_url)
             AND (r.resolved_url IS NOT NULL OR r.attempts >= ?)
         )`,
    )
    .all(MAX_ATTEMPTS) as { url: string }[];

  const candidates = rows
    .map((r) => r.url)
    .filter(isShortLinkUrl)
    .sort()
    .slice(0, limit);

  console.log(
    `[링크 해석] 단축링크 후보 ${rows.length}건 중 ${candidates.length}건 시도 (상한 ${limit})`,
  );

  if (candidates.length === 0) {
    db.close();
    return;
  }

  const upsert = db.prepare(
    `INSERT INTO link_resolutions (source_url, resolved_url, resolved_at, attempts)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(source_url) DO UPDATE SET
       resolved_url = excluded.resolved_url,
       resolved_at = excluded.resolved_at,
       attempts = link_resolutions.attempts + 1`,
  );

  let ok = 0;
  let fail = 0;

  try {
    for (let i = 0; i < candidates.length; i++) {
      const url = candidates[i];
      const { destination, note } = await resolveOnce(url);

      upsert.run(url, destination, nowKstIso());

      if (destination !== null) ok++;
      else fail++;

      console.log(`[링크 해석] (${i + 1}/${candidates.length}) ${url} ${note}`);

      if (i < candidates.length - 1) {
        await new Promise((r) => setTimeout(r, THROTTLE_MS));
      }
    }
  } finally {
    console.log(`[링크 해석] 완료: 성공 ${ok}, 미해결 ${fail}`);
    db.close();
  }
}

main();
