/*
 * 상품 썸네일 수집 — 상품 페이지에서 og:image를 추출해
 * product_images 캐시에 기록한다.
 *
 * 설계:
 * - 대상: url_type='direct' 구매 링크만. 리다이렉트/제휴 래핑은
 *   최종 상품 페이지가 보장되지 않아 건너뛴다.
 * - 캐시: 성공(이미지)·실패(빈 문자열) 모두 기록. 실패는
 *   attempts 3회까지만 재시도 — 차단 사이트(쿠팡 등) 무한 재시도 방지.
 * - 예외는 삼키고 null/실패 기록 (fail→null 원칙).
 *
 * 사용법:
 *   npx tsx scripts/fetch-thumbnails.ts [--limit N] [--dry-run]
 *   --limit: 이번 실행 최대 시도 수 (기본 25 — 파이프라인용 소량 배치)
 */
import { openDb, nowKstIso } from "../src/db/index";
import { productKeyFromUrl } from "../src/db/queries";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_ATTEMPTS = 3;
const THROTTLE_MS = 1500;

interface Candidate {
  key: string;
  url: string;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/** og:image / twitter:image / itemprop / JSON-LD 순서로 추출. */
function extractImage(html: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    /<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)/i,
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (!m) continue;

    let value = decodeEntities(m[1].trim());
    if (value.startsWith("//")) value = `https:${value}`;
    if (value.startsWith("http")) return value;
  }

  /* JSON-LD "image": "..." 폴백 */
  const ld = html.match(/"image"\s*:\s*"(https?:[^"]+)"/);
  if (ld) return decodeEntities(ld[1]);

  return null;
}

async function fetchImage(
  url: string,
): Promise<{ image: string | null; status: string }> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
    });

    if (!res.ok) return { image: null, status: `http ${res.status}` };

    const html = await res.text();
    const image = extractImage(html);

    return { image, status: image ? "ok" : "no og:image" };
  } catch (e) {
    return { image: null, status: String(e).slice(0, 60) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 25 : 25;
  const dryRun = args.includes("--dry-run");

  const db = openDb();

  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT product_url FROM deals
         WHERE product_url IS NOT NULL AND url_type = 'direct'`,
      )
      .all() as { product_url: string }[];

    /* 캐시 조회: 성공 건과 포기 건은 건너뛰기. */
    const cached = db
      .prepare(
        `SELECT product_key, image_url, attempts FROM product_images`,
      )
      .all() as { product_key: string; image_url: string; attempts: number }[];
    const cachedByKey = new Map(cached.map((c) => [c.product_key, c]));

    const candidates: Candidate[] = [];
    const seen = new Set<string>();

    for (const { product_url } of rows) {
      const key = productKeyFromUrl(product_url);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const hit = cachedByKey.get(key);
      if (hit && (hit.image_url !== "" || hit.attempts >= MAX_ATTEMPTS)) {
        continue;
      }

      candidates.push({ key, url: product_url });
    }

    const batch = candidates.slice(0, limit);
    console.log(
      `후보 ${candidates.length}건 중 ${batch.length}건 시도${dryRun ? " (dry-run)" : ""}`,
    );

    let ok = 0;
    let fail = 0;

    for (let i = 0; i < batch.length; i++) {
      const c = batch[i];

      if (dryRun) {
        console.log(`[dry] ${c.url}`);
        continue;
      }

      const { image, status } = await fetchImage(c.url);
      const prev = cachedByKey.get(c.key);
      const attempts = (prev?.attempts ?? 0) + 1;

      db.prepare(
        `INSERT INTO product_images (product_key, image_url, attempts, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(product_key) DO UPDATE SET
           image_url = excluded.image_url,
           attempts = excluded.attempts,
           fetched_at = excluded.fetched_at`,
      ).run(c.key, image ?? "", attempts, nowKstIso());

      if (image) {
        ok++;
        console.log(`✓ ${c.url.slice(0, 70)} → ${image.slice(0, 80)}`);
      } else {
        fail++;
        console.log(`✗ ${c.url.slice(0, 70)} (${status}, 시도 ${attempts}/${MAX_ATTEMPTS})`);
      }

      if (i < batch.length - 1) await sleep(THROTTLE_MS);
    }

    console.log(`완료: 성공 ${ok}, 실패 ${fail}`);
  } finally {
    db.close();
  }
}

main();
