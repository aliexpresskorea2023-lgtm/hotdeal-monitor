/**
 * 네이버 카페 핫딜 검색 수집기.
 *
 * Naver Cafe Search API (cafearticle.json)로 핫딜 게시글을 발견하고
 * 직접 DB에 적재한다. HTML 스냅샷 없이 JSON 응답을 즉시 처리하므로
 * 기존 collect.py → ingest-crawls.ts 파이프라인과 독립적으로 동작한다.
 *
 * 사전 조건: .env.local에 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 설정.
 *   developers.naver.com에서 애플리케이션 등록 후 발급받은 키.
 *
 * 사용법:
 *   npx tsx scripts/fetch-naver-cafe.ts [--dry-run] [--limit N]
 *   --dry-run:  API 호출만, DB 적재 생략
 *   --limit N:  키워드당 최대 결과 수 (기본 30, 최대 100)
 */
import fs from "node:fs";
import path from "node:path";
import { openDb, nowKstIso } from "../src/db/index";
import {
  parseNaverCafeItem,
  type NaverCafeApiItem,
} from "../src/parsers/naver-cafe";
import { checkExclusion } from "../src/db/exclusion";

/* ── .env.local 로더 ─────────────────────────── */

function loadEnvLocal(): void {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvLocal();

/* ── 설정 ─────────────────────────────────────── */

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || "";
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || "";
// NCP API HUB (2025-06-25 이전 완료). 구 openapi.naver.com 엔드포인트는
// 2027-06-30 완전 종료. 인증 헤더도 X-NCP-APIGW-API-KEY-*로 변경.
const API_BASE = "https://naverapihub.apigw.ntruss.com/search/v1/cafearticle";

/**
 * 검색 키워드 목록.
 *
 * 2026-09-02 실측 기준 정제:
 * - "특가"/"할인"/"가격오류"/"독점가격" 제거 — 중고나라·부동산·펜션 등
 *   오탐이 핫딜 결과보다 많아 신호 대 잡음비가 낮음.
 * - 핫딜 커뮤니티 이름이 들어간 카페(핫딜당, 핫딜컴퍼니 등)가
 *   자연스럽게 필터링되도록 "핫딜"을 핵심어로 유지.
 * - 품목 특가는 노트북/모니터/SSD 등 구체적이어야 중고 거래와 구분됨.
 */
const SEARCH_KEYWORDS = [
  "핫딜",
  "알리 핫딜",
  "쿠팡 특가",
  "타임딜",
  "해외직구 핫딜",
  "노트북 특가",
  "아이패드 특가",
  "모니터 특가",
  "SSD 특가",
  "GPU 특가",
];

/* ── CLI 인자 ─────────────────────────────────── */

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LIMIT = (() => {
  const idx = args.indexOf("--limit");
  if (idx >= 0 && args[idx + 1]) {
    const n = parseInt(args[idx + 1], 10);
    if (n >= 1 && n <= 100) return n;
  }
  return 30;
})();

/* ── API 호출 ─────────────────────────────────── */

async function searchCafeArticles(
  query: string,
  display: number = LIMIT,
  start: number = 1,
): Promise<{ items: NaverCafeApiItem[]; total: number }> {
  const url = new URL(API_BASE);
  url.searchParams.set("query", query);
  url.searchParams.set("display", String(display));
  url.searchParams.set("start", String(start));
  url.searchParams.set("sort", "date"); // 최신순 — 핫딜은 시효성이 중요

  const resp = await fetch(url.toString(), {
    headers: {
      "X-NCP-APIGW-API-KEY-ID": NAVER_CLIENT_ID,
      "X-NCP-APIGW-API-KEY": NAVER_CLIENT_SECRET,
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    lastBuildDate: string;
    total: number;
    start: number;
    display: number;
    items: NaverCafeApiItem[];
  };

  return { items: data.items || [], total: data.total };
}

/* ── DB 적재 ──────────────────────────────────── */

type ExclusionReason =
  | "category"
  | "zero-price"
  | "promo-title"
  | "software-title"
  | "rental-title"
  | "travel-title"
  | "mart-flyer-title"
  | "telecom-title"
  | "live-benefit-title"
  | "point-reward-title";

function upsertPostAndDeal(
  db: ReturnType<typeof openDb>,
  deal: ReturnType<typeof parseNaverCafeItem>,
  now: string,
): { inserted: boolean; excluded: ExclusionReason | null } {
  const product = deal.products[0];

  // 제외 규칙 검사
  const excl = checkExclusion({
    community: "naver_cafe",
    category: null,
    title: deal.title,
    price: product?.price ?? null,
  });
  if (excl.excluded) {
    return {
      inserted: false,
      excluded: excl.reason as ExclusionReason,
    };
  }

  // post upsert
  db.prepare(
    `INSERT INTO posts (
       community, post_id, url, title, status,
       products_count, first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, ?, 'unknown', ?, ?, ?)
     ON CONFLICT(community, post_id) DO UPDATE SET
       title = excluded.title,
       status = 'unknown',
       products_count = excluded.products_count,
       last_seen_at = excluded.last_seen_at`,
  ).run(
    "naver_cafe",
    deal.sourcePostId,
    deal.sourceUrl,
    deal.title,
    product ? 1 : 0,
    now,
    now,
  );

  // post rowid 조회
  const postRow = db
    .prepare("SELECT id FROM posts WHERE community = ? AND post_id = ?")
    .get("naver_cafe", deal.sourcePostId) as { id: number } | undefined;

  if (!postRow) return { inserted: false, excluded: null };

  // 기존 deal 확인 (price observation 비교용)
  const existingDeal = db
    .prepare(
      "SELECT deal_price FROM deals WHERE post_rowid = ? AND seq = 0",
    )
    .get(postRow.id) as
    | { deal_price: number | null }
    | undefined;

  // deal upsert — deals 테이블에는 first_seen_at/last_seen_at 없음
  db.prepare(
    `INSERT INTO deals (
       post_rowid, seq,
       product_name, currency, price_text,
       deal_price, estimated_krw, shipping, condition,
       product_url, url_type, store,
       raw_price, raw_shipping,
       discount_types, discount_codes, discount_stackable,
       discount_alternatives, discount_description
     ) VALUES (?, 0, ?, ?, ?, ?, NULL, NULL, 'unknown', NULL, 'none', ?, ?, NULL, '[]', '[]', '[]', '[]', '')
     ON CONFLICT(post_rowid, seq) DO UPDATE SET
       currency = excluded.currency,
       price_text = excluded.price_text,
       deal_price = excluded.deal_price,
       store = excluded.store,
       raw_price = excluded.raw_price`,
  ).run(
    postRow.id,
    null, // product_name — 스니펫에서 불신
    product?.currency || "KRW",
    product?.priceText || "",
    product?.price ?? null,
    product?.store || null,
    deal.sourceMeta.rawPrice || null,
  );

  // price observation — 가격이 변했을 때만
  const newPrice = product?.price ?? null;
  const oldPrice = existingDeal?.deal_price ?? null;
  if (newPrice !== oldPrice) {
    db.prepare(
      `INSERT INTO price_observations
         (deal_rowid, observed_at, post_status, deal_price, currency)
       VALUES (?, ?, 'unknown', ?, ?)`,
    ).run(
      postRow.id,
      now,
      newPrice,
      product?.currency || "KRW",
    );
  }

  return { inserted: true, excluded: null };
}

/* ── 메인 ─────────────────────────────────────── */

async function main() {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
    console.error(
      "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET가 .env.local에 없습니다.\n" +
        "NCP 콘솔 > Application Services > NAVER API HUB에서 키를 발급받으세요.",
    );
    process.exit(1);
  }

  const db = DRY_RUN ? null : openDb();
  if (db) {
    // node:sqlite 쓰기 경합 대비 (dev 서버와 동시 접근 가능)
    db.exec("PRAGMA busy_timeout = 10000;");
  }

  const now = nowKstIso();
  let totalPosts = 0;
  let totalDeals = 0;
  let totalExcluded = 0;
  const exclusionCounts: Record<ExclusionReason, number> = {
    category: 0,
    "zero-price": 0,
    "promo-title": 0,
    "software-title": 0,
    "rental-title": 0,
    "travel-title": 0,
    "mart-flyer-title": 0,
    "telecom-title": 0,
    "live-benefit-title": 0,
    "point-reward-title": 0,
  };

  // run 전체에서의 중복 제거 (같은 글이 여러 키워드에 걸릴 수 있음)
  const seenPostIds = new Set<string>();

  console.log(
    `[네이버 카페] 검색 시작 — ${SEARCH_KEYWORDS.length}개 키워드, display=${LIMIT}${DRY_RUN ? " (dry-run)" : ""}`,
  );

  for (let i = 0; i < SEARCH_KEYWORDS.length; i++) {
    const keyword = SEARCH_KEYWORDS[i];
    console.log(`  [${i + 1}/${SEARCH_KEYWORDS.length}] "${keyword}"`);

    try {
      const { items, total } = await searchCafeArticles(keyword);
      console.log(`    → ${items.length}건 (전체 ${total}건)`);

      for (const item of items) {
        if (!item.link) continue;

        // post ID 추출로 중복 체크
        let postId: string;
        try {
          const u = new URL(item.link);
          const articleId = u.searchParams.get("articleId");
          const clubId = u.searchParams.get("clubId");
          postId =
            articleId && clubId ? `${clubId}_${articleId}` : item.link;
        } catch {
          postId = item.link;
        }

        if (seenPostIds.has(postId)) continue;
        seenPostIds.add(postId);

        const deal = parseNaverCafeItem(item, now);

        if (DRY_RUN) {
          const product = deal.products[0];
          const priceStr =
            product?.price !== null && product?.price !== undefined
              ? `${product.price.toLocaleString()}원`
              : "가격없음";
          console.log(
            `    · ${deal.title.slice(0, 50)}… [${deal.sourceMeta.cafeName}] ${priceStr}`,
          );
          totalPosts++;
          continue;
        }

        const result = upsertPostAndDeal(db!, deal, now);
        if (result.inserted) {
          totalDeals++;
        } else if (result.excluded) {
          totalExcluded++;
          exclusionCounts[result.excluded]++;
        }
        totalPosts++;
      }
    } catch (err) {
      console.error(`    ✗ 오류: ${(err as Error).message}`);
    }

    // API 호출 간 딜레이 — 1초 (네이버 API 권장)
    if (i < SEARCH_KEYWORDS.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (DRY_RUN) {
    console.log(
      `\n[dry-run] ${totalPosts}건 발견 (키워드 ${SEARCH_KEYWORDS.length}개)`,
    );
  } else {
    db!.close();
    console.log(
      `\n[네이버 카페] 완료: ${totalPosts}건 발견, ${totalDeals}건 적재, ${totalExcluded}건 제외`,
    );
    if (totalExcluded > 0) {
      const parts = Object.entries(exclusionCounts)
        .filter(([, c]) => c > 0)
        .map(([k, c]) => `${k}: ${c}`);
      console.log(`  제외 사유: ${parts.join(", ")}`);
    }
  }
}

main().catch((err) => {
  console.error("치명적 오류:", err);
  process.exit(1);
});
