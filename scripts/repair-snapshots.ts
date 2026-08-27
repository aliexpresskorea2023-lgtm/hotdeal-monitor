/*
 * 스냅샷 재파싱 리페어 (원타임 스크립트, 2026-08-27).
 *
 * 파서 결함으로 잘못 적재된 필드를 저장된 스냅샷(data/crawls)을
 * 재파싱해서 치유한다:
 * 1. 상태 — 펨코 종료 마커 div를 못 읽어서 active/unknown으로
 *    남은 게시글을 ended로 승격. (ended는 터미널 상태라
 *    승격만 하고 강등은 절대 하지 않는다.)
 * 2. 가격 — 룰리웹 맨 "N원" 제목 표기를 못 읽어서 deal_price가
 *    null로 남은 딜에 가격을 채운다. seq 인덱스는 인제스트와
 *    동일 규칙(제외 필터 후 순서)으로 대응시키고, 개수가
 *    맞지 않으면 해당 글은 건너뛴다.
 *
 * 가격 변경은 관측(price_observations)으로도 기록해서 최저가
 * 히스토리 시계열이 이어지게 한다.
 *
 * 실행:
 *   npx tsx scripts/repair-snapshots.ts            # 적용
 *   npx tsx scripts/repair-snapshots.ts --dry-run  # 보고만
 */

import fs from "node:fs";
import path from "node:path";
import { parseFmkoreaHtml } from "../src/parsers/fmkorea";
import { parsePpomppuHtml } from "../src/parsers/ppomppu";
import { parseRuliwebHtml } from "../src/parsers/ruliweb";
import { parseQuasarzoneHtml } from "../src/parsers/quasarzone";
import { parseArcaHtml } from "../src/parsers/arca";
import {
  normalizeFmkoreaDeal,
  normalizePpomppuDeal,
  normalizeRuliwebDeal,
  normalizeQuasarzoneDeal,
  normalizeArcaDeal,
} from "../src/parsers/normalize";
import type { Deal } from "../src/parsers/types";
import { DEFAULT_DB_PATH, nowKstIso, openDb } from "../src/db";
import { checkExclusion } from "../src/db/exclusion";

const dryRun = process.argv.includes("--dry-run");

type Community =
  | "fmkorea"
  | "ppomppu"
  | "ruliweb"
  | "quasarzone"
  | "arca";

interface NativePostView {
  title: string;
  status: "active" | "ended" | "unknown";
  stats: {
    views: number | null;
    recommendations: number | null;
    comments: number | null;
  };
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

interface ManifestEntry {
  community: Community;
  postId: string;
  url: string;
  snapshot: string | null;
}

const db = openDb(DEFAULT_DB_PATH);

if (!db) {
  console.error(`DB를 열 수 없습니다: ${DEFAULT_DB_PATH}`);
  process.exit(1);
}

const crawlsRoot = path.join(process.cwd(), "data", "crawls");

/* 타임스탬프 run id라 사전순 = 시간순. 오래된 것부터 처리해서 최신 스냅샷이 최종 반영되게 한다. */
const runIds = fs
  .readdirSync(crawlsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const summary = {
  parsed: 0,
  statusUpgraded: 0,
  priceFilled: 0,
  skippedSeqMismatch: 0,
};

for (const runId of runIds) {
  const manifestPath = path.join(crawlsRoot, runId, "manifest.json");

  if (!fs.existsSync(manifestPath)) continue;

  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, "utf-8"),
  ) as { runId: string; entries: ManifestEntry[] };

  for (const entry of manifest.entries) {
    if (!entry.snapshot) continue;
    if (!(entry.community in PIPELINE)) continue;

    const snapshotFile = path.join(crawlsRoot, runId, entry.snapshot);

    if (!fs.existsSync(snapshotFile)) continue;

    const pipeline = PIPELINE[entry.community];

    let post: NativePostView;
    let deals: Deal[];

    try {
      post = pipeline.parse(
        fs.readFileSync(snapshotFile, "utf-8"),
        { sourceUrl: entry.url },
      ) as NativePostView;
      deals = pipeline.normalize(post as unknown as never);
    } catch {
      continue;
    }

    const postRow = db
      .prepare(
        `SELECT id, status FROM posts WHERE community = ? AND post_id = ?`,
      )
      .get(entry.community, entry.postId) as
      | { id: number; status: string }
      | undefined;

    if (!postRow) continue;

    summary.parsed += 1;

    /* 1. 상태 승격 (ended만, 강등 금지). */
    if (post.status === "ended" && postRow.status !== "ended") {
      summary.statusUpgraded += 1;
      console.log(
        `  ended  ${entry.community} ${entry.postId} (${postRow.status} → ended)`,
      );

      if (!dryRun) {
        db.prepare(
          `UPDATE posts SET status = 'ended' WHERE id = ?`,
        ).run(postRow.id);
      }
    }

    /* 2. 가격 보강 — 인제스트와 동일하게 제외 필터 후 seq 대응. */
    const kept = deals.filter(
      (deal) =>
        !checkExclusion({
          community: entry.community,
          category: deal.product.category,
          title: post.title,
          price: deal.price.dealPrice,
        }).excluded,
    );

    const stored = db
      .prepare(
        `SELECT id, seq, deal_price FROM deals
         WHERE post_rowid = ? ORDER BY seq`,
      )
      .all(postRow.id) as Array<{
      id: number;
      seq: number;
      deal_price: number | null;
    }>;

    if (stored.length !== kept.length) {
      summary.skippedSeqMismatch += 1;
      continue;
    }

    for (const [index, deal] of kept.entries()) {
      const row = stored[index];

      if (row.deal_price !== null || deal.price.dealPrice === null) {
        continue;
      }

      summary.priceFilled += 1;
      console.log(
        `  price  ${entry.community} ${entry.postId} #${row.seq} → ${deal.price.dealPrice} (${post.title.slice(0, 40)})`,
      );

      if (dryRun) continue;

      db.prepare(
        `UPDATE deals SET
           deal_price = ?, currency = ?, price_text = ?,
           estimated_krw = ?, raw_price = ?
         WHERE id = ?`,
      ).run(
        deal.price.dealPrice,
        deal.price.currency,
        deal.price.priceText,
        deal.price.estimatedKrw,
        deal.sourceMeta.rawPrice,
        row.id,
      );

      /* 관측 시계열에도 기록 (가격 변경 이벤트). */
      db.prepare(
        `INSERT INTO price_observations (
           deal_rowid, observed_at, post_status,
           deal_price, currency, estimated_krw, shipping,
           views, recommendations, comments
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        nowKstIso(),
        post.status,
        deal.price.dealPrice,
        deal.price.currency,
        deal.price.estimatedKrw,
        deal.price.shipping,
        post.stats.views,
        post.stats.recommendations,
        post.stats.comments,
      );
    }
  }
}

console.log(
  `완료${dryRun ? "(dry-run)" : ""}: 스냅샷 ${summary.parsed}개 재파싱, ` +
    `상태 승격 ${summary.statusUpgraded}건, 가격 보강 ${summary.priceFilled}건, ` +
    `seq 불일치 스킵 ${summary.skippedSeqMismatch}건.`,
);
