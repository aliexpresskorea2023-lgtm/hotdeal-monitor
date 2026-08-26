import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { parsePpomppuHtml } from "../src/parsers/ppomppu";
import { parseRuliwebHtml } from "../src/parsers/ruliweb";
import { parseFmkoreaHtml } from "../src/parsers/fmkorea";
import {
  normalizeFmkoreaDeal,
  normalizePpomppuDeal,
  normalizeRuliwebDeal,
} from "../src/parsers/normalize";

/*
 * 라이브 크롤링 테스트 (2026-08-26)
 *
 * 파서는 fixture로 검증됐지만, 실제 "목록 요청 → 상세 수집 → 파서"
 * 파이프라인이 라이브에서 동작하는지 확인하는 일회성 점검 스크립트.
 * 회귀 테스트가 아니므로 스키마 assertion은 하지 않는다.
 *
 * 정책:
 * - 커뮤니티당 목록 1건 + 상세 최대 3건만 수집 (최소 발자국)
 * - ppomppu/ruliweb 3초, fmkorea 7초 스로틀 (fmkorea WAF 실측 이력)
 * - 챌린지/차단 페이지는 게시글로 저장하지 않고 실패 보고만 한다
 * - 원본 HTML은 tests/fixtures-live/에 스냅샷으로 보존
 *
 * 실행: npx tsx tests/live-crawl-test.ts
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const SNAPSHOT_DIR = path.join(
  process.cwd(),
  "tests",
  "fixtures-live",
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(
  url: string,
): Promise<{ status: number; buffer: Buffer }> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9",
    },
    redirect: "follow",
  });

  const buffer = Buffer.from(await res.arrayBuffer());

  return { status: res.status, buffer };
}

function saveSnapshot(name: string, html: string): string {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const file = path.join(SNAPSHOT_DIR, name);
  fs.writeFileSync(file, html, "utf-8");

  return file;
}

type PostRef = { id: string; url: string };

/* =========================================================
 * ppomppu — EUC-KR, view.php?id=pmarket&no=<id>
 * ======================================================= */

function ppomppuListPostRefs(html: string): PostRef[] {
  const $ = cheerio.load(html);
  const refs: PostRef[] = [];
  const seen = new Set<string>();

  $('a[href*="view.php"]').each((_, a) => {
    const href = $(a).attr("href") ?? "";

    /* pmarket 게시판 글만 — 공지/규정(regulation) 등 타 게시판 링크 제외. */
    if (!/[?&]id=pmarket(&|$)/.test(href)) {
      return;
    }

    const id = href.match(/[?&]no=(\d+)/)?.[1];

    if (!id || seen.has(id)) {
      return;
    }

    seen.add(id);
    refs.push({
      id,
      url: `https://www.ppomppu.co.kr/zboard/view.php?id=pmarket&no=${id}`,
    });
  });

  return refs;
}

/* =========================================================
 * ruliweb — board/1020/read/<id>, 공지(table_body notice) 제외
 * ======================================================= */

function ruliwebListPostRefs(html: string): PostRef[] {
  const $ = cheerio.load(html);
  const refs: PostRef[] = [];
  const seen = new Set<string>();

  $("tr.table_body").each((_, row) => {
    const classes = $(row).attr("class") ?? "";

    if (classes.includes("notice")) {
      return;
    }

    const anchor = $(row).find("a.subject_link").first();
    const href = anchor.attr("href") ?? "";
    const match = href.match(/\/board\/1020\/read\/(\d+)/);

    if (!match?.[1] || seen.has(match[1])) {
      return;
    }

    seen.add(match[1]);
    refs.push({
      id: match[1],
      url: `https://bbs.ruliweb.com/community/board/1020/read/${match[1]}`,
    });
  });

  return refs;
}

/* =========================================================
 * fmkorea — document_srl, 통합공지(1200490157) 제외
 * ======================================================= */

const FMKOREA_NOTICE_SRL = "1200490157";

function fmkoreaListPostRefs(html: string): PostRef[] {
  const $ = cheerio.load(html);
  const refs: PostRef[] = [];
  const seen = new Set<string>();

  $('a[href*="document_srl="]').each((_, a) => {
    const href = $(a).attr("href") ?? "";
    const id = href.match(/document_srl=(\d+)/)?.[1];

    if (!id || id === FMKOREA_NOTICE_SRL || seen.has(id)) {
      return;
    }

    seen.add(id);
    refs.push({
      id,
      url: `https://www.fmkorea.com/index.php?mid=hotdeal&document_srl=${id}`,
    });
  });

  return refs;
}

/* fmkorea 차단/챌린지 페이지 감지. */
function isFmkoreaChallenge(html: string): boolean {
  return (
    /에펨코리아\s*보안\s*시스템/.test(html) ||
    /ddosCheckOnly/.test(html)
  );
}

/* =========================================================
 * 메인 흐름
 * ======================================================= */

const THROTTLE_MS: Record<string, number> = {
  ppomppu: 3000,
  ruliweb: 3000,
  fmkorea: 7000,
};

type DealSummary = {
  community: string;
  postId: string;
  url: string;
  httpStatus: number;
  challenge: boolean;
  title: string;
  products: number;
  deals: number;
  firstName: string | null;
  firstPrice: string;
  firstStore: string | null;
  firstUrlType: string | null;
  status: string;
};

const summaries: DealSummary[] = [];

async function crawlCommunity(
  community: "ppomppu" | "ruliweb" | "fmkorea",
  listUrl: string,
  parseList: (html: string) => PostRef[],
  isChallenge: (html: string) => boolean,
  decode: (buffer: Buffer) => string,
  parseDetail: (
    html: string,
    options: { sourceUrl: string },
  ) => { title: string; products: unknown[]; status: string },
  normalize: (post: never) => Array<{
    product: { name: string | null; store: string | null };
    price: { dealPrice: number | null; priceText: string; currency: string };
    purchase: { urlType: string };
  }>,
): Promise<void> {
  const throttle = THROTTLE_MS[community];

  console.log(`\n========== ${community} ==========`);
  console.log(`목록: ${listUrl}`);

  const list = await fetchPage(listUrl);

  if (list.status !== 200) {
    console.log(`목록 요청 실패: HTTP ${list.status}`);
    return;
  }

  const listHtml = decode(list.buffer);

  if (isChallenge(listHtml)) {
    console.log("목록이 챌린지/차단 페이지임 — 중단.");
    return;
  }

  const refs = parseList(listHtml);

  console.log(
    `게시글 링크 ${refs.length}개 발견 → 최대 3건 상세 수집`,
  );

  for (const ref of refs.slice(0, 3)) {
    await sleep(throttle);

    const detail = await fetchPage(ref.url);
    const detailHtml = decode(detail.buffer);
    const challenge = isChallenge(detailHtml);

    const summary: DealSummary = {
      community,
      postId: ref.id,
      url: ref.url,
      httpStatus: detail.status,
      challenge,
      title: "",
      products: 0,
      deals: 0,
      firstName: null,
      firstPrice: "",
      firstStore: null,
      firstUrlType: null,
      status: "",
    };

    if (detail.status !== 200 || challenge) {
      console.log(
        `  [${ref.id}] HTTP ${detail.status}` +
          (challenge ? " (챌린지 감지)" : ""),
      );
      summaries.push(summary);
      continue;
    }

    saveSnapshot(`${community}-${ref.id}.html`, detailHtml);

    const post = parseDetail(detailHtml, {
      sourceUrl: ref.url,
    }) as unknown as never;

    const deals = normalize(post);

    const typed = post as unknown as {
      title: string;
      products: Array<{
        name: string | null;
        price: number | null;
        currency: string | null;
        store: string | null;
        urlType: string;
      }>;
      status: string;
    };

    summary.title = typed.title.slice(0, 60);
    summary.products = typed.products.length;
    summary.deals = deals.length;
    summary.status = typed.status;

    const first = typed.products[0];

    if (first) {
      summary.firstName = first.name;
      summary.firstPrice = `${first.price ?? "?"} ${first.currency ?? ""}`.trim();
      summary.firstStore = first.store;
      summary.firstUrlType = first.urlType;
    }

    summaries.push(summary);

    console.log(
      `  [${ref.id}] ${summary.title}\n` +
        `      products=${summary.products} deals=${summary.deals} ` +
        `status=${summary.status} ` +
        (first
          ? `| ${first.name ?? "(이름 없음)"} / ${summary.firstPrice} / ${first.store ?? "?"}`
          : ""),
    );
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();

  console.log(`라이브 크롤링 테스트 시작: ${startedAt}`);

  await crawlCommunity(
    "ppomppu",
    "https://www.ppomppu.co.kr/zboard/zboard.php?id=pmarket",
    ppomppuListPostRefs,
    () => false,
    (buffer) => iconv.decode(buffer, "euc-kr"),
    (html, options) => parsePpomppuHtml(html, options),
    normalizePpomppuDeal as never,
  );

  await crawlCommunity(
    "ruliweb",
    "https://bbs.ruliweb.com/community/board/1020",
    ruliwebListPostRefs,
    () => false,
    (buffer) => buffer.toString("utf-8"),
    (html, options) => parseRuliwebHtml(html, options),
    normalizeRuliwebDeal as never,
  );

  await crawlCommunity(
    "fmkorea",
    "https://www.fmkorea.com/index.php?mid=hotdeal&listStyle=list",
    fmkoreaListPostRefs,
    isFmkoreaChallenge,
    (buffer) => buffer.toString("utf-8"),
    (html, options) => parseFmkoreaHtml(html, options),
    normalizeFmkoreaDeal as never,
  );

  console.log("\n========== 요약 ==========");

  const fetched = summaries.filter((s) => !s.challenge && s.httpStatus === 200);
  const parsed = fetched.filter((s) => s.products > 0);
  const skipped = fetched.filter((s) => s.products === 0);

  console.log(`상세 수집 성공: ${fetched.length}/${summaries.length}`);
  console.log(`딜 파싱됨(products≥1): ${parsed.length}`);
  console.log(`스킵(products=0 — 폼 미입력/자유형): ${skipped.length}`);

  for (const s of summaries.filter((x) => x.challenge)) {
    console.log(`차단/챌린지: ${s.community} ${s.postId}`);
  }

  console.log(`\n스냅샷 저장 위치: ${SNAPSHOT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
