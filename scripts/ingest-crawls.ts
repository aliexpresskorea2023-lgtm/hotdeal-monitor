import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { parseFmkoreaHtml } from "../src/parsers/fmkorea";
import { parsePpomppuHtml } from "../src/parsers/ppomppu";
import { parseRuliwebHtml } from "../src/parsers/ruliweb";
import { parseQuasarzoneHtml } from "../src/parsers/quasarzone";
import { parseArcaHtml } from "../src/parsers/arca";
import {
  normalizeArcaDeal,
  normalizeFmkoreaDeal,
  normalizePpomppuDeal,
  normalizeQuasarzoneDeal,
  normalizeRuliwebDeal,
} from "../src/parsers/normalize";
import type { Deal } from "../src/parsers/types";
import { DEFAULT_DB_PATH, nowKstIso, openDb } from "../src/db";
import { checkExclusion } from "../src/db/exclusion";

/*
 * 크롤 run → SQLite 적재 (인제스트)
 *
 * 수집 워커가 저장한 run 스냅샷을 파싱해 data/hotdeal.db에
 * 멱등 upsert한다. 주기 수집에서의 중복은 여기서 정리된다:
 *
 * - posts: (community, post_id) 유일. 다시 만나면 상태/stats만 갱신.
 * - deals: (post_rowid, seq) 유일로 제자리 갱신.
 * - price_observations: 가격/배송/상태가 변했을 때만 append.
 *
 * products=0 글(폼 미입력/자유형)도 post 행은 적재한다 —
 * 수집 워커가 "이미 본 글(동결)"로 판단하는 근거가 되기 때문.
 *
 * 실행:
 *   npx tsx scripts/ingest-crawls.ts                 # 미적재 run 전부
 *   npx tsx scripts/ingest-crawls.ts data/crawls/<run-id>   # 특정 run
 */

type Community =
  | "fmkorea"
  | "ppomppu"
  | "ruliweb"
  | "quasarzone"
  | "arca";

interface ManifestEntry {
  community: Community;
  postId: string;
  url: string;
  snapshot: string | null;
}

interface Manifest {
  runId: string;
  entries: ManifestEntry[];
}

/* 포스트 수준 필드만 보는 parser-native 뷰. */
interface NativePostView {
  title: string;
  postedAt: string | null;
  status: "active" | "ended" | "unknown";
  stats: {
    views: number | null;
    recommendations: number | null;
    comments: number | null;
  };
  products: unknown[];
  sourceMeta?: { affiliate?: boolean; rawUrl?: string | null };
  affiliate?: { enabled: boolean; rawUrl: string | null };
}

const PIPELINE: Record<
  Community,
  {
    parse: (html: string, options: { sourceUrl: string }) => unknown;
    normalize: (post: never) => Deal[];
  }
> = {
  fmkorea: {
    parse: (html, options) => parseFmkoreaHtml(html, options),
    normalize: normalizeFmkoreaDeal as never,
  },
  ppomppu: {
    parse: (html, options) => parsePpomppuHtml(html, options),
    normalize: normalizePpomppuDeal as never,
  },
  ruliweb: {
    parse: (html, options) => parseRuliwebHtml(html, options),
    normalize: normalizeRuliwebDeal as never,
  },
  quasarzone: {
    parse: (html, options) => parseQuasarzoneHtml(html, options),
    normalize: normalizeQuasarzoneDeal as never,
  },
  arca: {
    parse: (html, options) => parseArcaHtml(html, options),
    normalize: normalizeArcaDeal as never,
  },
};

const ajv = new Ajv2020({ allErrors: true, strict: false });

const schema = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "data", "schema", "hotdeal.schema_v2.0.json"),
    "utf-8",
  ),
);

const validate = ajv.compile(schema);

type Db = ReturnType<typeof openDb>;

interface RunSummary {
  runId: string;
  snapshots: number;
  posts: number;
  deals: number;
  observations: number;
  skippedInvalid: number;
}

function affiliateOf(post: NativePostView): {
  enabled: boolean;
  rawUrl: string | null;
} {
  /* 커뮤니티별 native 필드명 차이 흡수 (affiliate vs sourceMeta.affiliate). */
  if (post.affiliate) {
    return post.affiliate;
  }

  if (post.sourceMeta) {
    return {
      enabled: Boolean(post.sourceMeta.affiliate),
      rawUrl: post.sourceMeta.rawUrl ?? null,
    };
  }

  return { enabled: false, rawUrl: null };
}

function upsertPost(
  db: Db,
  community: Community,
  entry: ManifestEntry,
  post: NativePostView,
  snapshotPath: string,
  /** 제외 규칙 적용 후 실제로 적재한 상품 수 (워커 동결 기준). */
  productsCount: number,
): number {
  const now = nowKstIso();
  const affiliate = affiliateOf(post);

  db.prepare(
    `INSERT INTO posts (
       community, post_id, url, title, posted_at, status,
       views, recommendations, comments,
       affiliate_enabled, affiliate_raw_url, products_count,
       first_seen_at, last_seen_at, snapshot_path
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(community, post_id) DO UPDATE SET
       url = excluded.url,
       title = excluded.title,
       posted_at = excluded.posted_at,
       status = excluded.status,
       views = excluded.views,
       recommendations = excluded.recommendations,
       comments = excluded.comments,
       affiliate_enabled = excluded.affiliate_enabled,
       affiliate_raw_url = excluded.affiliate_raw_url,
       products_count = excluded.products_count,
       last_seen_at = excluded.last_seen_at,
       snapshot_path = excluded.snapshot_path`,
  ).run(
    community,
    entry.postId,
    entry.url,
    post.title,
    post.postedAt,
    post.status,
    post.stats.views,
    post.stats.recommendations,
    post.stats.comments,
    affiliate.enabled ? 1 : 0,
    affiliate.rawUrl,
    productsCount,
    now,
    now,
    snapshotPath,
  );

  const row = db
    .prepare(
      `SELECT id FROM posts WHERE community = ? AND post_id = ?`,
    )
    .get(community, entry.postId) as { id: number };

  return row.id;
}

function upsertDeal(db: Db, postRowid: number, seq: number, deal: Deal): number {
  db.prepare(
    `INSERT INTO deals (
       post_rowid, seq,
       product_name, normalized_name, category, store, product_id, item_id,
       deal_price, currency, price_text, estimated_krw,
       shipping, shipping_text, condition,
       product_url, url_type, original_product_url,
       raw_price, raw_shipping,
       discount_types, discount_codes, discount_stackable,
       discount_alternatives, discount_description
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(post_rowid, seq) DO UPDATE SET
       product_name = excluded.product_name,
       normalized_name = excluded.normalized_name,
       category = excluded.category,
       store = excluded.store,
       product_id = excluded.product_id,
       item_id = excluded.item_id,
       deal_price = excluded.deal_price,
       currency = excluded.currency,
       price_text = excluded.price_text,
       estimated_krw = excluded.estimated_krw,
       shipping = excluded.shipping,
       shipping_text = excluded.shipping_text,
       condition = excluded.condition,
       product_url = excluded.product_url,
       url_type = excluded.url_type,
       original_product_url = excluded.original_product_url,
       raw_price = excluded.raw_price,
       raw_shipping = excluded.raw_shipping,
       discount_types = excluded.discount_types,
       discount_codes = excluded.discount_codes,
       discount_stackable = excluded.discount_stackable,
       discount_alternatives = excluded.discount_alternatives,
       discount_description = excluded.discount_description`,
  ).run(
    postRowid,
    seq,
    deal.product.name,
    deal.product.normalizedName,
    deal.product.category,
    deal.product.store,
    deal.product.productId,
    deal.purchase.itemId,
    deal.price.dealPrice,
    deal.price.currency,
    deal.price.priceText,
    deal.price.estimatedKrw,
    deal.price.shipping,
    deal.price.shippingText,
    deal.price.condition,
    deal.purchase.productUrl,
    deal.purchase.urlType,
    deal.sourceMeta.originalProductUrl,
    deal.sourceMeta.rawPrice,
    deal.sourceMeta.rawShipping,
    JSON.stringify(deal.discount.types),
    JSON.stringify(deal.discount.codes),
    JSON.stringify(deal.discount.stackable),
    JSON.stringify(deal.discount.alternatives),
    deal.discount.description,
  );

  const row = db
    .prepare(`SELECT id FROM deals WHERE post_rowid = ? AND seq = ?`)
    .get(postRowid, seq) as { id: number };

  return row.id;
}

function maybeAddObservation(
  db: Db,
  dealRowid: number,
  deal: Deal,
): boolean {
  const last = db
    .prepare(
      `SELECT deal_price, estimated_krw, shipping, post_status
       FROM price_observations
       WHERE deal_rowid = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(dealRowid) as
    | {
        deal_price: number | null;
        estimated_krw: number | null;
        shipping: number | null;
        post_status: string;
      }
    | undefined;

  const status = deal.sourcePost.status;
  const price = deal.price.dealPrice;
  const krw = deal.price.estimatedKrw;
  const shipping = deal.price.shipping;

  const changed =
    !last ||
    last.deal_price !== price ||
    last.estimated_krw !== krw ||
    last.shipping !== shipping ||
    last.post_status !== status;

  if (!changed) {
    return false;
  }

  db.prepare(
    `INSERT INTO price_observations (
       deal_rowid, observed_at, post_status,
       deal_price, currency, estimated_krw, shipping,
       views, recommendations, comments
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    dealRowid,
    nowKstIso(),
    status,
    price,
    deal.price.currency,
    krw,
    shipping,
    deal.sourcePost.stats.views,
    deal.sourcePost.stats.recommendations,
    deal.sourcePost.stats.comments,
  );

  return true;
}

function ingestRun(db: Db, runDir: string): RunSummary {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(runDir, "manifest.json"), "utf-8"),
  ) as Manifest;

  const summary: RunSummary = {
    runId: manifest.runId,
    snapshots: 0,
    posts: 0,
    deals: 0,
    observations: 0,
    skippedInvalid: 0,
  };

  for (const entry of manifest.entries) {
    if (!entry.snapshot) {
      continue;
    }

    const snapshotFile = path.join(runDir, entry.snapshot);

    if (!fs.existsSync(snapshotFile)) {
      console.log(`  MISS  ${entry.community} ${entry.postId}: 스냅샷 없음`);
      summary.skippedInvalid += 1;
      continue;
    }

    const html = fs.readFileSync(snapshotFile, "utf-8");
    const pipeline = PIPELINE[entry.community];

    let post: NativePostView;

    try {
      post = pipeline.parse(html, { sourceUrl: entry.url }) as NativePostView;
    } catch (error) {
      console.log(
        `  ERR   ${entry.community} ${entry.postId}: 파싱 예외 — ${String(error)}`,
      );
      summary.skippedInvalid += 1;
      continue;
    }

    if (!validate(post)) {
      console.log(
        `  FAIL  ${entry.community} ${entry.postId}: 스키마 위반 — 적재 건너뜀`,
      );
      summary.skippedInvalid += 1;
      continue;
    }

    const deals = pipeline.normalize(post as unknown as never);

    /*
     * 무형·비핫딜 제외 (정책 2026-08-27): 상품권·SW·포인트, 홍보글,
     * 항공권·이용권류, 0원 딜. 제외 딜도 행은 적재하되 사유를
     * 기록한다 — 어드민에서 검토·복원할 수 있어야 하기 때문.
     * 복원된 딜(exclusion_restored=1)은 규칙에 다시 걸려도 제외하지
     * 않는다. 남은(노출되는) 상품이 0개면 products_count=0 →
     * 수집 워커가 재확인 없이 동결.
     */
    const judged = deals.map((deal) => ({
      deal,
      exclusion: checkExclusion({
        community: entry.community,
        category: deal.product.category,
        title: post.title,
        price: deal.price.dealPrice,
      }),
    }));

    const snapshotPath = `${manifest.runId}/${entry.snapshot}`;

    /* products_count는 딜 처리 후 실제 노출 수로 확정한다. */
    const postRowid = upsertPost(
      db,
      entry.community,
      entry,
      post,
      snapshotPath,
      0,
    );

    summary.snapshots += 1;
    summary.posts += 1;

    /* 이전 적재 때 더 많은 상품이 있었다면 잔여 deal 행 정리. */
    db.prepare(
      `DELETE FROM deals WHERE post_rowid = ? AND seq >= ?`,
    ).run(postRowid, judged.length);

    let visibleCount = 0;

    for (const [seq, item] of judged.entries()) {
      const dealRowid = upsertDeal(db, postRowid, seq, item.deal);

      summary.deals += 1;

      const row = db
        .prepare(`SELECT exclusion_restored FROM deals WHERE id = ?`)
        .get(dealRowid) as { exclusion_restored: number };

      const restored = row.exclusion_restored === 1;

      if (item.exclusion.excluded && !restored) {
        /* 규칙 제외 + 복원 이력 없음 → 사유 기록 (공개 피드에서 빠짐). */
        db.prepare(
          `UPDATE deals SET excluded_reason = ? WHERE id = ?`,
        ).run(item.exclusion.reason, dealRowid);
        continue;
      }

      /*
       * 노출 딜 (규칙 통과 또는 어드민 복원): 사유 해제. 규칙이
       * 나중에 풀린 케이스도 여기서 정리된다. 복원 딜은 관찰도
       * 계속 붙어 가격 기록이 이어진다.
       */
      db.prepare(
        `UPDATE deals SET excluded_reason = NULL WHERE id = ?`,
      ).run(dealRowid);

      visibleCount += 1;

      if (maybeAddObservation(db, dealRowid, item.deal)) {
        summary.observations += 1;
      }
    }

    db.prepare(
      `UPDATE posts SET products_count = ? WHERE id = ?`,
    ).run(visibleCount, postRowid);
  }

  db.prepare(
    `INSERT INTO ingest_runs (
       run_id, ingested_at, snapshots, posts_upserted,
       deals_upserted, observations_added
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       ingested_at = excluded.ingested_at,
       snapshots = excluded.snapshots,
       posts_upserted = excluded.posts_upserted,
       deals_upserted = excluded.deals_upserted,
       observations_added = excluded.observations_added`,
  ).run(
    manifest.runId,
    nowKstIso(),
    summary.snapshots,
    summary.posts,
    summary.deals,
    summary.observations,
  );

  return summary;
}

function listRunDirs(crawlsRoot: string): string[] {
  if (!fs.existsSync(crawlsRoot)) {
    return [];
  }

  return fs
    .readdirSync(crawlsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => path.join(crawlsRoot, name));
}

function main(): void {
  /* 테스트·어드민용으로 사본 DB 적재가 필요할 때 환경변수로 지정. */
  const dbPath = process.env.HOTDEAL_DB_PATH || DEFAULT_DB_PATH;
  const db = openDb(dbPath);

  const crawlsRoot = path.join(process.cwd(), "data", "crawls");

  const requested = process.argv.slice(2).map((p) => path.resolve(p));

  const ingestedRunIds = new Set(
    (
      db.prepare(`SELECT run_id FROM ingest_runs`).all() as Array<{
        run_id: string;
      }>
    ).map((r) => r.run_id),
  );

  let targets: string[];

  if (requested.length > 0) {
    targets = requested;
  } else {
    targets = listRunDirs(crawlsRoot).filter((dir) => {
      const manifestPath = path.join(dir, "manifest.json");

      if (!fs.existsSync(manifestPath)) {
        return false;
      }

      const manifest = JSON.parse(
        fs.readFileSync(manifestPath, "utf-8"),
      ) as Manifest;

      return !ingestedRunIds.has(manifest.runId);
    });
  }

  if (targets.length === 0) {
    console.log("적재할 새 run이 없습니다.");
    return;
  }

  console.log(`DB: ${dbPath}`);

  let totals = { snapshots: 0, posts: 0, deals: 0, observations: 0, invalid: 0 };

  for (const runDir of targets) {
    console.log(`\n========== run ${path.basename(runDir)} ==========`);

    const s = ingestRun(db, runDir);

    console.log(
      `  스냅샷 ${s.snapshots}건 → posts ${s.posts} upsert, ` +
        `deals ${s.deals} upsert, 관측 +${s.observations}` +
        (s.skippedInvalid > 0 ? `, 스킵 ${s.skippedInvalid}` : ""),
    );

    totals.snapshots += s.snapshots;
    totals.posts += s.posts;
    totals.deals += s.deals;
    totals.observations += s.observations;
    totals.invalid += s.skippedInvalid;
  }

  const postCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM posts`).get() as { n: number }
  ).n;
  const dealCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM deals`).get() as { n: number }
  ).n;
  const obsCount = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM price_observations`)
      .get() as { n: number }
  ).n;

  console.log("\n========== 적재 요약 ==========");
  console.log(
    `이번 적재: 스냅샷 ${totals.snapshots} / posts ${totals.posts} / ` +
      `deals ${totals.deals} / 관측 +${totals.observations}` +
      (totals.invalid > 0 ? ` / 스킵 ${totals.invalid}` : ""),
  );
  console.log(`DB 누적: posts ${postCount} / deals ${dealCount} / 관측 ${obsCount}`);
}

main();
