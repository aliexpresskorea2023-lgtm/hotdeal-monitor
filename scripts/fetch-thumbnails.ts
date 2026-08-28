/*
 * 상품 썸네일 수집 — 2단계로 동작한다.
 *
 * 1단계(기본): 상품 페이지에서 og:image를 추출해 product_images
 *   캐시에 기록. 대상은 url_type='direct' 구매 링크만 — 리다이렉트/
 *   제휴 래핑은 최종 상품 페이지가 보장되지 않아 건너뛴다.
 *   성공·실패 모두 기록하고 실패는 3회까지만 재시도(차단 사이트
 *   무한 재시도 방지).
 *
 * 2단계(다나와 폴백): 가전/디지털 카테고리에 한해, 1단계에서 이미지를
 *   못 건진 상품을 다나와 검색으로 찾아 매칭 1위 상품의 카탈로그
 *   썸네일(img.danuri.io)을 캐시에 기록한다.
 *   - 검색어: 표시 정제된 상품명 (스토어 괄호·프로모션·수량 파생 제거).
 *   - 검증: 검색어 토큰과 결과 상품명 토큰의 중복률이 충분할 때만
 *     채택 — 엉뚱한 상품 이미지가 붙는 것보다 없는 쪽이 낫다.
 *   - 부하 제한: 실행당 소량 배치 + 3초 딜레이. 시도 여부는
 *     attempts=4 마커로 기록해 같은 상품을 반복 조회하지 않는다.
 *     (직접 링크는 og:image 3회 소진 후에야 다나와 대상이 된다 —
 *     실제 상품 페이지 이미지가 카탈로그 이미지보다 정확하므로.)
 *
 * 예외는 삼키고 null/실패 기록 (fail→null 원칙).
 *
 * 사용법:
 *   npx tsx scripts/fetch-thumbnails.ts [--limit N] [--danawa-limit N] [--dry-run]
 *   --limit: 1단계 최대 시도 수 (기본 25 — 파이프라인용 소량 배치)
 *   --danawa-limit: 2단계 최대 시도 수 (기본 10)
 */
import { openDb, nowKstIso } from "../src/db/index";
import { productKeyFromUrl } from "../src/db/queries";
import { normalizeCategory, normalizeStore } from "../src/db/taxonomy";
import { cleanDisplayName, splitNameParts } from "../src/lib/name";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_ATTEMPTS = 3;
const THROTTLE_MS = 1500;

/** 다나와 시도 완료 마커 — 이 값 이상이면 두 단계 모두 건너뛴다. */
const DANAWA_MARK = MAX_ATTEMPTS + 1;
const DANAWA_THROTTLE_MS = 3000;

/** 다나와는 가전/디지털 카탈로그만 커버한다 — 해당 카테고리만 조회. */
const DANAWA_CATEGORIES = new Set([
  "PC/하드웨어",
  "게임/하드웨어",
  "노트북/모바일",
  "가전/TV",
]);

/** 검색어↔결과 중복률 기준. 이보다 낮으면 매칭 불신. */
const MIN_OVERLAP = 0.5;

interface Candidate {
  key: string;
  url: string;
}

interface DanawaCandidate {
  key: string;
  query: string;
}

type CacheRow = {
  product_key: string;
  image_url: string;
  attempts: number;
};

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&apos;|&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
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

/* ---------------- 다나와 폴백 ---------------- */

/** 검색어/상품명에서 2자 이상 토큰 추출 (영숫자·한글). */
function tokensOf(text: string): string[] {
  return [
    ...new Set(text.toLowerCase().match(/[a-z0-9]{2,}|[가-힣]{2,}/g) ?? []),
  ];
}

/** 검색어 토큰이 결과 상품명에 포함된 비율. */
function overlapRatio(query: string, title: string): number {
  const qTokens = tokensOf(query);
  if (qTokens.length === 0) return 0;
  const hay = title.toLowerCase();
  const hits = qTokens.filter((t) => hay.includes(t)).length;
  return hits / qTokens.length;
}

/**
 * 다나와 검색 결과에서 매칭 1위 상품을 파싱.
 * 결과는 관련도 순이라 앞에 있을수록 매칭도가 높다.
 *
 * 주의: 페이지에 광고 자리(li class="prod_item" 정확히 일치)가 섞여
 * 있고 실제 상품은 class="prod_item width_change searched" 같은
 * 복합 클래스 + data-product-order 속성을 가진다. 정확히 일치하는
 * 클래스만 찾으면 빈 광고 블록을 잡으므로 복합 클래스로 분할하고
 * data-product-order가 있는(자연 검색 결과) 블록을 우선한다.
 */
function parseDanawaFirst(
  html: string,
): { title: string; image: string } | null {
  const chunks = html.split(/<li[^>]*class="prod_item[^"]*"/).slice(1);

  const extract = (block: string): { title: string; image: string } | null => {
    const nameM = block.match(/<p[^>]*class="prod_name"[^>]*>([\s\S]*?)<\/p>/);
    const title = nameM
      ? decodeEntities(
          nameM[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        )
      : "";

    const imgM =
      block.match(/<img[^>]+src="(https?:\/\/img\.danuri\.io\/[^"]+)"/) ??
      block.match(/<img[^>]+data-original="(https?:\/\/img\.danuri\.io\/[^"]+)"/);

    if (!title || !imgM) return null;
    return { title, image: imgM[1] };
  };

  const blockOf = (raw: string): string => {
    const end = raw.indexOf("</li>");
    return end >= 0 ? raw.slice(0, end) : raw.slice(0, 40_000);
  };

  /* 1차: 자연 검색 결과 (광고 블록 제외). */
  for (const raw of chunks) {
    if (!raw.includes("data-product-order")) continue;
    const hit = extract(blockOf(raw));
    if (hit) return hit;
  }

  /* 2차: 그래도 없으면 아무 블록에서라도. */
  for (const raw of chunks) {
    const hit = extract(blockOf(raw));
    if (hit) return hit;
  }

  return null;
}

/**
 * 다나와 검색. 반환값:
 * - {title, image}: 결과 있음
 * - null: 검색은 됐지만 결과/이미지 없음
 * - "error": 네트워크 오류 (이번엔 건너뛰고 다음 실행에 재시도)
 */
async function searchDanawa(
  query: string,
): Promise<{ title: string; image: string } | null | "error"> {
  try {
    const url = `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
    });

    if (!res.ok) return "error";
    return parseDanawaFirst(await res.text());
  } catch {
    return "error";
  }
}

function upsertImage(
  db: ReturnType<typeof openDb>,
  key: string,
  image: string | null,
  attempts: number,
): void {
  db.prepare(
    `INSERT INTO product_images (product_key, image_url, attempts, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(product_key) DO UPDATE SET
       image_url = excluded.image_url,
       attempts = excluded.attempts,
       fetched_at = excluded.fetched_at`,
  ).run(key, image ?? "", attempts, nowKstIso());
}

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 25 : 25;
  const danawaIdx = args.indexOf("--danawa-limit");
  const danawaLimit =
    danawaIdx >= 0 ? Number(args[danawaIdx + 1]) || 10 : 10;
  const dryRun = args.includes("--dry-run");

  const db = openDb();

  try {
    /* ---- 1단계: og:image ---------------------------------- */
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
      .all() as CacheRow[];
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
      `[og:image] 후보 ${candidates.length}건 중 ${batch.length}건 시도${dryRun ? " (dry-run)" : ""}`,
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

      upsertImage(db, c.key, image, attempts);
      cachedByKey.set(c.key, {
        product_key: c.key,
        image_url: image ?? "",
        attempts,
      });

      if (image) {
        ok++;
        console.log(`✓ ${c.url.slice(0, 70)} → ${image.slice(0, 80)}`);
      } else {
        fail++;
        console.log(`✗ ${c.url.slice(0, 70)} (${status}, 시도 ${attempts}/${MAX_ATTEMPTS})`);
      }

      if (i < batch.length - 1) await sleep(THROTTLE_MS);
    }

    console.log(`[og:image] 완료: 성공 ${ok}, 실패 ${fail}`);

    if (dryRun) return;

    /* ---- 2단계: 다나와 폴백 --------------------------------
     * 가전/디지털 카테고리 중 이미지가 아직 없는 상품.
     * 직접 링크는 og 3회 소진 후, 제휴/리다이렉트는 즉시 대상. */
    const dealRows = db
      .prepare(
        `SELECT d.product_url AS url, d.url_type AS url_type,
                d.product_name AS name, d.category AS raw_category,
                d.store AS store, p.community AS community,
                p.title AS post_title
         FROM deals d
         JOIN posts p ON p.id = d.post_rowid
         WHERE d.product_name IS NOT NULL AND d.product_url IS NOT NULL`,
      )
      .all() as {
      url: string;
      url_type: string;
      name: string;
      raw_category: string | null;
      store: string | null;
      community: string;
      post_title: string;
    }[];

    const danawaCandidates: DanawaCandidate[] = [];
    const seenDanawa = new Set<string>();

    for (const d of dealRows) {
      const norm = normalizeCategory(d.community, d.raw_category, d.post_title);
      if (!DANAWA_CATEGORIES.has(norm)) continue;

      const key = productKeyFromUrl(d.url);
      if (!key || seenDanawa.has(key)) continue;
      seenDanawa.add(key);

      const hit = cachedByKey.get(key);
      if (hit && hit.image_url !== "") continue; // 이미지 이미 확보
      if (hit && hit.attempts >= DANAWA_MARK) continue; // 다나와 시도 완료
      if (d.url_type === "direct" && (!hit || hit.attempts < MAX_ATTEMPTS)) {
        // og:image 시도 기회가 남아 있으면 그쪽이 우선.
        continue;
      }

      const display = cleanDisplayName(d.name, normalizeStore(d.store));
      const query = display ? splitNameParts(display).main.trim() : "";
      if (!query) continue;

      danawaCandidates.push({ key, query });
    }

    const danawaBatch = danawaCandidates.slice(0, danawaLimit);
    console.log(
      `[다나와] 후보 ${danawaCandidates.length}건 중 ${danawaBatch.length}건 시도`,
    );

    let dOk = 0;
    let dFail = 0;
    let dSkip = 0;
    /* 같은 검색어(다른 키) 재조회 방지. */
    const queryResults = new Map<
      string,
      { title: string; image: string } | null | "error"
    >();

    for (let i = 0; i < danawaBatch.length; i++) {
      const c = danawaBatch[i];
      const tokens = tokensOf(c.query);

      /* 토큰이 너무 적은 검색어는 매칭 신뢰도가 없어 시도 자체를 포기. */
      if (tokens.length < 2) {
        upsertImage(db, c.key, null, DANAWA_MARK);
        dSkip++;
        console.log(`- 검색어 너무 짧음: ${c.query}`);
        continue;
      }

      let result = queryResults.get(c.query);
      if (result === undefined) {
        result = await searchDanawa(c.query);
        queryResults.set(c.query, result);
        if (i < danawaBatch.length - 1 && !queryResults.has(danawaBatch[i + 1]?.query ?? "")) {
          await sleep(DANAWA_THROTTLE_MS);
        }
      }

      if (result === "error") {
        /* 네트워크 오류는 마커를 찍지 않고 다음 실행에 재시도. */
        dSkip++;
        console.log(`? 검색 실패(네트워크): ${c.query}`);
        continue;
      }

      if (!result) {
        upsertImage(db, c.key, null, DANAWA_MARK);
        dFail++;
        console.log(`✗ 결과 없음: ${c.query}`);
        continue;
      }

      const ratio = overlapRatio(c.query, result.title);
      if (ratio < MIN_OVERLAP) {
        upsertImage(db, c.key, null, DANAWA_MARK);
        dFail++;
        console.log(
          `✗ 매칭 불신(${Math.round(ratio * 100)}%): ${c.query} → ${result.title.slice(0, 50)}`,
        );
        continue;
      }

      upsertImage(db, c.key, result.image, DANAWA_MARK);
      dOk++;
      console.log(
        `✓ ${c.query} → ${result.title.slice(0, 50)} (${Math.round(ratio * 100)}%)`,
      );
    }

    console.log(
      `[다나와] 완료: 성공 ${dOk}, 실패 ${dFail}, 건너뜀 ${dSkip}`,
    );
  } finally {
    db.close();
  }
}

main();
