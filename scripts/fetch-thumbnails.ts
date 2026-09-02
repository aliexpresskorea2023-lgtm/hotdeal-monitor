/*
 * 상품 썸네일 수집 — 다단계 파이프라인 (2026-09-02 대개편).
 *
 * 단계 구성:
 *   1단계(og:image)  — 상품 페이지에서 og:image 추출. curl_cffi Chrome
 *                      지문으로 수집(차단 우회), venv 없으면 Node fetch 폴백.
 *   2단계(다나와)    — 가전/디지털 4개 카테고리, 다나와 카탈로그 검색 폴백.
 *   2b단계(네이버쇼핑) — 생활/식품·패션/뷰티·기타 카테고리, 네이버 쇼핑검색
 *                      API 폴백 (NAVER_CLIENT_ID/SECRET 필요, 없으면 스킵).
 *   3단계(Playwright) — --playwright 플래그 시에만. 쿠팡/지마켓 등 하드차단
 *                      잔여분을 헤드리스 브라우저로 재시도 (별도 저빈도 배치).
 *
 * 2026-09-02 변경(사용자 확정, 해결안 #2·#3·#4·#5·#6 + 타임아웃):
 *   #2 HTTP 클라이언트를 curl_cffi impersonate=chrome으로 교체 — collector에서
 *      검증된 지문으로 쿠팡(Akamai)·지마켓·옥션·네이버(429) 1차 차단 우회.
 *   #3 네이버 계열 분리 스로틀(10s) + 24h 쿨다운 + 세션 웜업(홈페이지 쿠키).
 *   #4 비상품 URL(쇼핑라이브·블로그·통신결제·기프티콘·게시판 스레드) 제외 —
 *      시도 자체를 안 하고 attempts=MAX로 영구 스킵 마킹.
 *   #5 네이버 쇼핑검색 API 폴백 — 다나와가 커버 못 하는 패션/식품/생활.
 *   #6 Playwright 헤드리스 폴백 — 하드차단 잔여분, --playwright 시에만.
 *   타임아웃 12s → 기본 25s, 알리/토스 등 느린 호스트 35s.
 *
 *   (제외: #1 재시도 정책·Stage-1 resolved-redirect 아키텍처 개편,
 *    #7 쿠팡 파트너스 API — 사용자 지시로 미적용.)
 *
 * 예외는 삼키고 null/실패 기록 (fail→null 원칙).
 *
 * 사용법:
 *   npx tsx scripts/fetch-thumbnails.ts [--limit N] [--danawa-limit N]
 *                                       [--naver-limit N] [--playwright]
 *                                       [--pw-limit N] [--dry-run]
 *   --limit:         1단계 최대 시도 수 (기본 25 — 파이프라인용 소량 배치)
 *   --danawa-limit:  2단계 최대 시도 수 (기본 10)
 *   --naver-limit:   2b단계 최대 시도 수 (기본 10)
 *   --playwright:    3단계 활성화 (playwright 설치 필요)
 *   --pw-limit:      3단계 최대 시도 수 (기본 5 — 저빈도)
 */
import { openDb, nowKstIso } from "../src/db/index";
import { productKeyFromUrl } from "../src/db/queries";
import { loadResolutions } from "../src/db/link-resolution";
import { normalizeCategory, normalizeStore } from "../src/db/taxonomy";
import { cleanDisplayName, splitNameParts } from "../src/lib/name";
import {
  cffiAvailable,
  fetchBatchCffi,
  type CffiRequest,
  type CffiResult,
} from "./lib/cffi-fetch";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_ATTEMPTS = 3;

/** 다나와/네이버쇼핑 시도 완료 마커 — 이 값 이상이면 검색 폴백 건너뜀. */
const DANAWA_MARK = MAX_ATTEMPTS + 1;
const DANAWA_THROTTLE_MS = 3000;
const NAVER_SHOP_THROTTLE_MS = 2000;

/** 검색어↔결과 중복률 기준. 이보다 낮으면 매칭 불신. */
const MIN_OVERLAP = 0.5;

/* ---------------- 타임아웃 (2026-09-02 완화) ---------------- */
/** 기본 페이지 로드 타임아웃 — 12s에서 25s로 완화. */
const DEFAULT_TIMEOUT_MS = 25_000;
/** 알리익스프레스·토스 등 렌더 느린 호스트 — 35s. */
const SLOW_TIMEOUT_MS = 35_000;

/* ---------------- 호스트 분류 ---------------- */

/**
 * #3 네이버 계열 — 동일 rate-limit 페이지(22,586B)를 공유하므로
 * 분리 스로틀(10s) + 24h 쿨다운 + 세션 웜업이 필요하다.
 */
const NAVER_HOSTS = new Set([
  "smartstore.naver.com",
  "m.smartstore.naver.com",
  "brand.naver.com",
  "m.brand.naver.com",
  "brandconnect.naver.com",
  "shopping.naver.com",
  "m.shopping.naver.com",
  "storefarm.naver.com",
  "m.storefarm.naver.com",
  "naver.me",
]);

/** 네이버 계열 스로틀 — 기본 1.5s로는 429 rate-limit에 걸린다(실측). */
const NAVER_THROTTLE_MS = 10_000;
/** 네이버 24h 쿨다운 — 하루 내 재시도 금지로 rate-limit 누적 방지. */
const NAVER_COOLDOWN_HOURS = 24;

/** 타임아웃 여유 호스트 (알리/토스 — SPA + 해외 CDN). */
const SLOW_HOSTS = new Set([
  "ko.aliexpress.com",
  "a.aliexpress.com",
  "aliexpress.com",
  "www.aliexpress.com",
  "m.aliexpress.com",
  "toss.shopping",
  "toss.im",
]);

/**
 * #6 Playwright 대상 — curl_cffi로도 뚫리지 않는 하드차단
 * (쿠팡 Akamai Bot Manager, 지마켓/옥션/에픽 JS 챌린지).
 */
const HARD_BLOCK_HOSTS = new Set([
  "coupang.com",
  "link.coupang.com",
  "m.coupang.com",
  "gmarket.co.kr",
  "item.gmarket.co.kr",
  "m.gmarket.co.kr",
  "link.gmarket.co.kr",
  "auction.co.kr",
  "item.auction.co.kr",
  "m.auction.co.kr",
  "epicgames.com",
  "store.epicgames.com",
]);

/**
 * #4 비상품 URL — 상품 페이지가 아니라 시도 자체가 무의미한 호스트.
 * shopping-live(방송 페이지), blog/cafe(콘텐츠), telecom-pay(결제/포인트),
 * gift(기프티콘), forum-thread(게시판 URL이 product_url로 샌 케이스).
 */
const NON_PRODUCT_HOSTS = new Set([
  "view.shoppinglive.naver.com",
  "shoppinglive.naver.com",
  "m.shoppinglive.naver.com",
  "blog.naver.com",
  "m.blog.naver.com",
  "cafe.naver.com",
  "m.cafe.naver.com",
  "pay.sktelecom.com",
  "point.pay.naver.com",
  "pay.naver.com",
  "joytel.co.kr",
  "gift.kakao.com",
  "gifting.kakao.com",
  "giftishow.com",
  "giftn.com",
  "ofw.adison.com",
]);

/** 다나와는 가전/디지털 카탈로그만 커버 — 해당 카테고리만 조회. */
const DANAWA_CATEGORIES = new Set([
  "PC/하드웨어",
  "게임/하드웨어",
  "노트북/모바일",
  "가전/TV",
]);

/** 네이버 쇼핑검색 폴백 대상 — 다나와가 커버 못 하는 카테고리. */
const NAVER_SHOP_CATEGORIES = new Set([
  "생활/식품",
  "패션/뷰티",
  "기타",
]);

interface Candidate {
  key: string;
  url: string;
  host: string;
  group: string;
  timeoutMs: number;
}

interface DanawaCandidate {
  key: string;
  query: string;
}

type CacheRow = {
  product_key: string;
  image_url: string;
  attempts: number;
  fetched_at: string;
  /** 어드민 수동 지정 썸네일 — 있으면 자동 수집 대상에서 제외. */
  image_override: string | null;
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** URL에서 host 추출 (실패 시 빈 문자열). */
function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** www./m. 접두를 벗긴 정규 호스트명. */
function bareHost(host: string): string {
  return host.replace(/^(www|m)\./, "");
}

/** #4 비상품 URL 판정. */
function isNonProductUrl(url: string, host: string): boolean {
  if (NON_PRODUCT_HOSTS.has(host) || NON_PRODUCT_HOSTS.has(bareHost(host))) {
    return true;
  }
  /* 게시판 스레드 URL이 product_url로 샌 케이스 (arca.live/b/... 등). */
  if (/(^|\.)arca\.live$/.test(host) && /\/b\//.test(url)) return true;
  if (/(^|\.)ppomppu\.co\.kr$/.test(host) && /\/zboard\//.test(url)) {
    return true;
  }
  if (/(^|\.)fmkorea\.com$/.test(host) && /\/hotdeal\//.test(url)) {
    return true;
  }
  return false;
}

/** 호스트 → 스로틀 그룹 + 타임아웃 분류. */
function classifyHost(host: string): { group: string; timeoutMs: number } {
  const bare = bareHost(host);
  if (NAVER_HOSTS.has(host) || NAVER_HOSTS.has(bare)) {
    return { group: "naver", timeoutMs: DEFAULT_TIMEOUT_MS };
  }
  if (SLOW_HOSTS.has(host) || SLOW_HOSTS.has(bare)) {
    return { group: "slow", timeoutMs: SLOW_TIMEOUT_MS };
  }
  return { group: "default", timeoutMs: DEFAULT_TIMEOUT_MS };
}

/** fetched_at(KST ISO)이 지금으로부터 hours 이내인지. */
function withinHours(isoKst: string | null, hours: number): boolean {
  if (!isoKst) return false;
  const t = Date.parse(isoKst);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < hours * 3_600_000;
}

/* ---------------- Node fetch 폴백 ---------------- */

/**
 * curl_cffi venv가 없을 때의 폴백 경로 — Node 내장 fetch.
 * (차단 호스트에서는 실패하지만, 스크립트가 venv 없이도 돌게 유지.)
 */
async function nodeFetchImage(
  url: string,
  timeoutMs: number,
): Promise<{ image: string | null; status: string }> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
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

/* ---------------- 검색어 토큰/중복률 (다나와·네이버 공용) ---------------- */

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

/* ---------------- 다나와 폴백 (2단계) ---------------- */

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

/* ---------------- 네이버 쇼핑검색 폴백 (2b단계, #5) ---------------- */

/**
 * 네이버 쇼핑검색 Open API — /v1/search/shop.json.
 * NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수 필요
 * (developers.naver.com 무료 앱 등록, shop 일 25k 쿼터).
 *
 * 검색 페이지(search.shopping.naver.com)는 SPA + 429 rate-limit이라
 * 스크래핑하지 않는다 — 공식 API만 쓴다(사용자 인프라 원칙: 무료/공개 API).
 *
 * 반환:
 * - {title, image}: 매칭 1위
 * - null: 결과 없음
 * - "error": 네트워크/인증 오류
 * - "no-cred": 자격증명 없음 (전 단계 스킵)
 */
async function searchNaverShop(
  query: string,
): Promise<{ title: string; image: string } | null | "error" | "no-cred"> {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return "no-cred";

  try {
    const url =
      `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}` +
      `&display=5&sort=sim`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        "X-Naver-Client-Id": clientId,
        "X-Naver-Client-Secret": clientSecret,
      },
    });

    if (!res.ok) return "error";

    const data = (await res.json()) as {
      items?: Array<{ title: string; image: string }>;
    };
    const items = data.items ?? [];
    if (items.length === 0) return null;

    /* title에 네이버가 심는 강조 태그(<b>) 제거. */
    const first = items[0];
    const title = decodeEntities((first.title ?? "").replace(/<\/?b>/g, ""));
    const image = first.image ?? "";
    if (!title || !image) return null;
    return { title, image };
  } catch {
    return "error";
  }
}

/* ---------------- Playwright 폴백 (3단계, #6) ---------------- */

/**
 * 하드차단 호스트(쿠팡 Akamai 등)를 헤드리스 Chromium으로 렌더해
 * og:image를 추출한다. --playwright 플래그 시에만 동작하는 저빈도 배치.
 *
 * playwright 미설치 시 안내 메시지 후 빈 Map 반환(스크립트 중단 안 함).
 */
async function playwrightFetch(
  urls: string[],
  timeoutMs: number,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (urls.length === 0) return out;

  /*
   * playwright는 옵셔널 의존성 — 미설치 상태에서도 빌드/타입체크가
   * 깨지면 안 된다. 모듈명을 변수로 우회해 정적 해석을 피하고
   * 결과는 any로 취급한다. ( 런타임에 없으면 catch로 안내 후 빈 Map. )
   */
  const moduleName = "playwright";
  let pw: any = null;
  try {
    pw = await import(moduleName);
  } catch {
    console.warn(
      "[playwright] 미설치 — `npm i -D playwright && npx playwright install chromium` 후 --playwright 재실행.",
    );
    return out;
  }

  let browser;
  try {
    browser = await pw.chromium.launch({ headless: true });
  } catch (e) {
    console.warn(`[playwright] 브라우저 기동 실패: ${String(e).slice(0, 100)}`);
    return out;
  }

  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: "ko-KR",
      viewport: { width: 1280, height: 800 },
    });

    for (const url of urls) {
      const page = await context.newPage();
      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        });
        /* og:image는 DOM에서 직접 — SPA 렌더 대기. */
        const image = await page.evaluate(() => {
          const m = document.querySelector<HTMLMetaElement>(
            'meta[property="og:image"]',
          );
          return m?.content ?? null;
        });
        if (image) out.set(url, image);
        console.log(
          image
            ? `[pw] ✓ ${url.slice(0, 60)} → ${image.slice(0, 70)}`
            : `[pw] ✗ ${url.slice(0, 60)} (og:image 없음)`,
        );
      } catch (e) {
        console.log(`[pw] ✗ ${url.slice(0, 60)} (${String(e).slice(0, 50)})`);
      } finally {
        await page.close();
      }
      /* 저빈도 유지 — 페이지 사이 3s. */
      await sleep(3000);
    }
  } finally {
    await browser.close();
  }

  return out;
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

  /* 숫자 인자 파싱 — 0도 유효값으로 받아들인다(단계 비활성화용). */
  const numArg = (flag: string, fallback: number): number => {
    const i = args.indexOf(flag);
    if (i < 0) return fallback;
    const n = Number(args[i + 1]);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  const limit = numArg("--limit", 25);
  const danawaLimit = numArg("--danawa-limit", 10);
  const naverLimit = numArg("--naver-limit", 10);
  const usePlaywright = args.includes("--playwright");
  const pwLimit = numArg("--pw-limit", 5);
  const dryRun = args.includes("--dry-run");

  const db = openDb();
  /* dev 서버·워커와 WAL 경합 시 즉시 실패 방지. */
  db.exec("PRAGMA busy_timeout = 10000;");

  const useCffi = cffiAvailable();
  if (!useCffi) {
    console.warn(
      "[경고] collector/.venv/bin/python 또는 fetch-html-batch.py 없음 — " +
        "Node fetch 폴백 사용(차단 호스트 성공률 낮음).",
    );
  }

  try {
    /* ---- 1단계: og:image ---------------------------------- */
    const rows = db
      .prepare(
        `SELECT DISTINCT COALESCE(url_override, product_url) AS product_url
         FROM deals
         WHERE url_override IS NOT NULL
            OR (product_url IS NOT NULL AND url_type = 'direct')`,
      )
      .all() as { product_url: string }[];

    /* 캐시 조회: 성공 건과 포기 건은 건너뛰기. fetched_at은 쿨다운용. */
    const cached = db
      .prepare(
        `SELECT product_key, image_url, attempts, fetched_at, image_override
         FROM product_images`,
      )
      .all() as CacheRow[];
    const cachedByKey = new Map(cached.map((c) => [c.product_key, c]));

    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    let nonProductSkipped = 0;
    let naverCooldownSkipped = 0;

    /* 단축링크 해석 반영 — 피드가 참조하는 키와 동일 키로 캐시. */
    const resolutions = loadResolutions(
      db,
      rows.map((r) => r.product_url),
    );

    for (const { product_url } of rows) {
      const resolved = resolutions.get(product_url);
      const url = resolved ?? product_url;
      const key = productKeyFromUrl(url);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const host = hostOf(url);

      /* #4 비상품 URL — 시도 없이 영구 스킵 마킹. */
      if (isNonProductUrl(url, host)) {
        const prev = cachedByKey.get(key);
        if (!prev || prev.attempts < MAX_ATTEMPTS) {
          if (!dryRun) upsertImage(db, key, null, MAX_ATTEMPTS);
          nonProductSkipped++;
        }
        continue;
      }

      const hit = cachedByKey.get(key);
      /* 수동 지정 썸네일이 있으면 자동 수집하지 않는다. */
      if (hit?.image_override) continue;
      if (hit && (hit.image_url !== "" || hit.attempts >= MAX_ATTEMPTS)) {
        continue;
      }

      const { group, timeoutMs } = classifyHost(host);

      /* #3 네이버 24h 쿨다운 — 하루 내 재시도 금지. */
      if (
        group === "naver" &&
        hit &&
        hit.attempts > 0 &&
        withinHours(hit.fetched_at, NAVER_COOLDOWN_HOURS)
      ) {
        naverCooldownSkipped++;
        continue;
      }

      candidates.push({ key, url, host, group, timeoutMs });
    }

    const batch = candidates.slice(0, limit);
    console.log(
      `[og:image] 후보 ${candidates.length}건 중 ${batch.length}건 시도` +
        `${dryRun ? " (dry-run)" : ""} ` +
        `(클라이언트: ${useCffi ? "curl_cffi" : "node-fetch"})`,
    );
    if (nonProductSkipped > 0) {
      console.log(`  #4 비상품 URL 영구 스킵: ${nonProductSkipped}건`);
    }
    if (naverCooldownSkipped > 0) {
      console.log(`  #3 네이버 24h 쿨다운 스킵: ${naverCooldownSkipped}건`);
    }

    let ok = 0;
    let fail = 0;

    if (dryRun) {
      for (const c of batch) {
        console.log(`[dry] (${c.group}) ${c.url}`);
      }
    } else if (useCffi && batch.length > 0) {
      /* #2 curl_cffi 배치 수집 — Python이 per-group 스로틀 적용. */
      const naverWarmups = [...NAVER_HOSTS].filter((h) =>
        batch.some((c) => c.host === h || bareHost(c.host) === h),
      );
      const reqs: CffiRequest[] = batch.map((c) => ({
        url: c.url,
        timeoutMs: c.timeoutMs,
        hostGroup: c.group,
      }));
      const results: CffiResult[] = await fetchBatchCffi(reqs, {
        throttleByGroup: {
          default: 1500,
          naver: NAVER_THROTTLE_MS,
          slow: 3000,
        },
        warmupHosts: naverWarmups,
      });

      for (let i = 0; i < batch.length; i++) {
        const c = batch[i];
        const r = results[i];
        const prev = cachedByKey.get(c.key);
        const attempts = (prev?.attempts ?? 0) + 1;

        const image =
          r.status !== null && r.status >= 200 && r.status < 300 && r.body
            ? extractImage(r.body)
            : null;
        const status = r.error
          ? r.error.slice(0, 50)
          : r.status !== null
            ? `http ${r.status}`
            : "no response";

        upsertImage(db, c.key, image, attempts);
        cachedByKey.set(c.key, {
          product_key: c.key,
          image_url: image ?? "",
          attempts,
          fetched_at: nowKstIso(),
          image_override: prev?.image_override ?? null,
        });

        if (image) {
          ok++;
          console.log(`✓ ${c.url.slice(0, 70)} → ${image.slice(0, 80)}`);
        } else {
          fail++;
          console.log(
            `✗ ${c.url.slice(0, 70)} (${status}, 시도 ${attempts}/${MAX_ATTEMPTS})`,
          );
        }
      }
    } else {
      /* Node fetch 폴백 — venv 없을 때. TS 쪽 스로틀. */
      for (let i = 0; i < batch.length; i++) {
        const c = batch[i];
        const { image, status } = await nodeFetchImage(c.url, c.timeoutMs);
        const prev = cachedByKey.get(c.key);
        const attempts = (prev?.attempts ?? 0) + 1;

        upsertImage(db, c.key, image, attempts);
        cachedByKey.set(c.key, {
          product_key: c.key,
          image_url: image ?? "",
          attempts,
          fetched_at: nowKstIso(),
          image_override: prev?.image_override ?? null,
        });

        if (image) {
          ok++;
          console.log(`✓ ${c.url.slice(0, 70)} → ${image.slice(0, 80)}`);
        } else {
          fail++;
          console.log(
            `✗ ${c.url.slice(0, 70)} (${status}, 시도 ${attempts}/${MAX_ATTEMPTS})`,
          );
        }

        if (i < batch.length - 1) {
          await sleep(c.group === "naver" ? NAVER_THROTTLE_MS : 1500);
        }
      }
    }

    console.log(`[og:image] 완료: 성공 ${ok}, 실패 ${fail}`);

    if (dryRun) return;

    /* ---- 2단계: 다나와 + 네이버쇼핑 폴백 --------------------
     * 가전/디지털 4개 → 다나와, 생활/식품·패션/뷰티·기타 → 네이버쇼핑.
     * 직접 링크는 og 3회 소진 후, 제휴/리다이렉트는 즉시 대상. */
    const dealRows = db
      .prepare(
        `SELECT COALESCE(d.url_override, d.product_url) AS url,
                CASE WHEN d.url_override IS NOT NULL THEN 'direct'
                     ELSE d.url_type END AS url_type,
                d.product_name AS name, d.category AS raw_category,
                d.store AS store, p.community AS community,
                p.title AS post_title
         FROM deals d
         JOIN posts p ON p.id = d.post_rowid
         WHERE d.product_name IS NOT NULL
           AND COALESCE(d.url_override, d.product_url) IS NOT NULL`,
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
    const naverCandidates: DanawaCandidate[] = [];
    const seenSearch = new Set<string>();

    /* 1단계와 같은 해석 반영 — 동일 키 규약 유지. */
    const searchResolutions = loadResolutions(
      db,
      dealRows.map((d) => d.url),
    );

    for (const d of dealRows) {
      const norm = normalizeCategory(d.community, d.raw_category, d.post_title);
      const isDanawa = DANAWA_CATEGORIES.has(norm);
      const isNaverShop = NAVER_SHOP_CATEGORIES.has(norm);
      if (!isDanawa && !isNaverShop) continue;

      const resolved = searchResolutions.get(d.url) ?? d.url;
      const host = hostOf(resolved);

      /* #4 비상품 URL은 검색 폴백도 무의미. */
      if (isNonProductUrl(resolved, host)) continue;

      const key = productKeyFromUrl(resolved);
      if (!key || seenSearch.has(key)) continue;
      seenSearch.add(key);

      const hit = cachedByKey.get(key);
      if (hit?.image_override) continue; // 수동 지정이 우선
      if (hit && hit.image_url !== "") continue; // 이미지 이미 확보
      if (hit && hit.attempts >= DANAWA_MARK) continue; // 검색 폴백 시도 완료
      if (d.url_type === "direct" && (!hit || hit.attempts < MAX_ATTEMPTS)) {
        // og:image 시도 기회가 남아 있으면 그쪽이 우선.
        continue;
      }

      const display = cleanDisplayName(d.name, normalizeStore(d.store));
      const query = display ? splitNameParts(display).main.trim() : "";
      if (!query) continue;

      if (isDanawa) danawaCandidates.push({ key, query });
      else naverCandidates.push({ key, query });
    }

    /* -- 2단계: 다나와 -- */
    const danawaBatch = danawaCandidates.slice(0, danawaLimit);
    console.log(
      `[다나와] 후보 ${danawaCandidates.length}건 중 ${danawaBatch.length}건 시도`,
    );

    let dOk = 0;
    let dFail = 0;
    let dSkip = 0;
    const danawaQueryResults = new Map<
      string,
      { title: string; image: string } | null | "error"
    >();

    for (let i = 0; i < danawaBatch.length; i++) {
      const c = danawaBatch[i];
      const tokens = tokensOf(c.query);

      if (tokens.length < 2) {
        upsertImage(db, c.key, null, DANAWA_MARK);
        dSkip++;
        console.log(`- 검색어 너무 짧음: ${c.query}`);
        continue;
      }

      let result = danawaQueryResults.get(c.query);
      if (result === undefined) {
        result = await searchDanawa(c.query);
        danawaQueryResults.set(c.query, result);
        if (
          i < danawaBatch.length - 1 &&
          !danawaQueryResults.has(danawaBatch[i + 1]?.query ?? "")
        ) {
          await sleep(DANAWA_THROTTLE_MS);
        }
      }

      if (result === "error") {
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

    console.log(`[다나와] 완료: 성공 ${dOk}, 실패 ${dFail}, 건너뜀 ${dSkip}`);

    /* -- 2b단계: 네이버 쇼핑검색 (#5) -- */
    const naverBatch = naverCandidates.slice(0, naverLimit);
    console.log(
      `[네이버쇼핑] 후보 ${naverCandidates.length}건 중 ${naverBatch.length}건 시도`,
    );

    let nOk = 0;
    let nFail = 0;
    let nSkip = 0;
    let naverNoCred = false;
    const naverQueryResults = new Map<
      string,
      { title: string; image: string } | null | "error" | "no-cred"
    >();

    for (let i = 0; i < naverBatch.length; i++) {
      const c = naverBatch[i];
      const tokens = tokensOf(c.query);

      if (tokens.length < 2) {
        upsertImage(db, c.key, null, DANAWA_MARK);
        nSkip++;
        console.log(`- 검색어 너무 짧음: ${c.query}`);
        continue;
      }

      let result = naverQueryResults.get(c.query);
      if (result === undefined) {
        result = await searchNaverShop(c.query);
        naverQueryResults.set(c.query, result);
        if (result !== "no-cred" && i < naverBatch.length - 1) {
          await sleep(NAVER_SHOP_THROTTLE_MS);
        }
      }

      if (result === "no-cred") {
        if (!naverNoCred) {
          console.log(
            "[네이버쇼핑] NAVER_CLIENT_ID/SECRET 없음 — 2b단계 스킵. " +
              "developers.naver.com 무료 앱 등록 후 .env.local에 추가하면 활성화.",
          );
          naverNoCred = true;
        }
        nSkip++;
        continue;
      }

      if (result === "error") {
        nSkip++;
        console.log(`? 검색 실패(네트워크/인증): ${c.query}`);
        continue;
      }

      if (!result) {
        upsertImage(db, c.key, null, DANAWA_MARK);
        nFail++;
        console.log(`✗ 결과 없음: ${c.query}`);
        continue;
      }

      const ratio = overlapRatio(c.query, result.title);
      if (ratio < MIN_OVERLAP) {
        upsertImage(db, c.key, null, DANAWA_MARK);
        nFail++;
        console.log(
          `✗ 매칭 불신(${Math.round(ratio * 100)}%): ${c.query} → ${result.title.slice(0, 50)}`,
        );
        continue;
      }

      upsertImage(db, c.key, result.image, DANAWA_MARK);
      nOk++;
      console.log(
        `✓ ${c.query} → ${result.title.slice(0, 50)} (${Math.round(ratio * 100)}%)`,
      );
    }

    console.log(
      `[네이버쇼핑] 완료: 성공 ${nOk}, 실패 ${nFail}, 건너뜀 ${nSkip}`,
    );

    /* ---- 3단계: Playwright 하드차단 폴백 (#6, --playwright 시) ---- */
    if (usePlaywright) {
      const pwCandidates: { key: string; url: string; timeoutMs: number }[] = [];
      const seenPw = new Set<string>();

      for (const d of dealRows) {
        const resolved = searchResolutions.get(d.url) ?? d.url;
        const host = hostOf(resolved);
        if (!HARD_BLOCK_HOSTS.has(host) && !HARD_BLOCK_HOSTS.has(bareHost(host))) {
          continue;
        }
        const key = productKeyFromUrl(resolved);
        if (!key || seenPw.has(key)) continue;
        seenPw.add(key);

        const hit = cachedByKey.get(key);
        if (hit?.image_override) continue;
        if (hit && hit.image_url !== "") continue;

        pwCandidates.push({
          key,
          url: resolved,
          timeoutMs: SLOW_TIMEOUT_MS,
        });
      }

      const pwBatch = pwCandidates.slice(0, pwLimit);
      console.log(
        `[playwright] 후보 ${pwCandidates.length}건 중 ${pwBatch.length}건 시도`,
      );

      const pwResults = await playwrightFetch(
        pwBatch.map((c) => c.url),
        SLOW_TIMEOUT_MS,
      );

      let pOk = 0;
      let pFail = 0;
      for (const c of pwBatch) {
        const image = pwResults.get(c.url) ?? null;
        const prev = cachedByKey.get(c.key);
        const attempts = (prev?.attempts ?? 0) + 1;
        upsertImage(db, c.key, image, Math.max(attempts, DANAWA_MARK));
        cachedByKey.set(c.key, {
          product_key: c.key,
          image_url: image ?? "",
          attempts: Math.max(attempts, DANAWA_MARK),
          fetched_at: nowKstIso(),
          image_override: prev?.image_override ?? null,
        });
        if (image) pOk++;
        else pFail++;
      }
      console.log(`[playwright] 완료: 성공 ${pOk}, 실패 ${pFail}`);
    }
  } finally {
    db.close();
  }
}

main();
