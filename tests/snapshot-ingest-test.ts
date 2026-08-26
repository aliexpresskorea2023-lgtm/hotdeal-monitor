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

/*
 * 스냅샷 인제스트 테스트
 *
 * Python 수집 워커(collector/collect.py)가 저장한 HTML 스냅샷을
 * 기존 TS 순수 파서가 문제없이 Deal[]로 변환하는지 검증한다.
 *
 * 흐름: data/crawls/<run-id>/manifest.json → 각 entry의 snapshot을
 *       커뮤니티별 파서로 파싱 → schema v2.0 검증 → normalize → 요약.
 *
 * 파서/스키마 자체의 회귀는 schema-validation-test.ts가 fixture로
 * 담당하므로, 이 스크립트는 "워커 산출물 → 파서" 접합부 검증이 목적.
 * assertion 실패 시(스키마 위반/파싱 예외) exit code 1.
 *
 * 실행: npx tsx tests/snapshot-ingest-test.ts [crawls/<run-id> 경로]
 *       경로 미지정 시 data/crawls 아래 최신 run 자동 선택.
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
  httpStatus?: number;
  challenge?: boolean;
  snapshot: string | null;
}

interface Manifest {
  runId: string;
  entries: ManifestEntry[];
}

/* 파서-native 공통 뷰 (요약 출력용). */
interface NativePostView {
  title: string;
  status: string;
  products: Array<{
    name: string | null;
    price: number | null;
    currency: string | null;
    store: string | null;
    urlType: string;
  }>;
}

const PIPELINE: Record<
  Community,
  {
    parse: (
      html: string,
      options: { sourceUrl: string },
    ) => unknown;
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
    path.join(
      process.cwd(),
      "data",
      "schema",
      "hotdeal.schema_v2.0.json",
    ),
    "utf-8",
  ),
);

const validate = ajv.compile(schema);

function latestRunDir(): string {
  const crawlsDir = path.join(process.cwd(), "data", "crawls");

  const runs = fs
    .readdirSync(crawlsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const latest = runs[runs.length - 1];

  if (!latest) {
    throw new Error(`run 디렉터리가 없습니다: ${crawlsDir}`);
  }

  return path.join(crawlsDir, latest);
}

function main(): void {
  const runDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : latestRunDir();

  const manifestPath = path.join(runDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    console.error(`manifest가 없습니다: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, "utf-8"),
  ) as Manifest;

  console.log(`run: ${manifest.runId} (${runDir})`);

  let schemaFailures = 0;
  let parseErrors = 0;
  let parsedDeals = 0;
  let skippedNoForm = 0;
  let processed = 0;

  for (const entry of manifest.entries) {
    if (!entry.snapshot) {
      continue;
    }

    const snapshotPath = path.join(runDir, entry.snapshot);

    if (!fs.existsSync(snapshotPath)) {
      console.log(
        `MISS  ${entry.community} ${entry.postId}: 스냅샷 없음 (${entry.snapshot})`,
      );
      parseErrors += 1;
      continue;
    }

    const html = fs.readFileSync(snapshotPath, "utf-8");
    const pipeline = PIPELINE[entry.community];

    let post: NativePostView;

    try {
      post = pipeline.parse(html, {
        sourceUrl: entry.url,
      }) as NativePostView;
    } catch (error) {
      console.log(
        `ERR   ${entry.community} ${entry.postId}: 파싱 예외 — ${String(error)}`,
      );
      parseErrors += 1;
      continue;
    }

    processed += 1;

    if (!validate(post)) {
      schemaFailures += 1;
      console.log(
        `FAIL  ${entry.community} ${entry.postId}: schema v2.0 위반`,
      );
      console.log(JSON.stringify(validate.errors, null, 2));
      continue;
    }

    const deals = pipeline.normalize(post as unknown as never);

    if (deals.length === 0) {
      skippedNoForm += 1;
    } else {
      parsedDeals += 1;
    }

    const first = deals[0];

    console.log(
      `PASS  ${entry.community} ${entry.postId} | ${post.status} | ` +
        `products=${post.products.length} deals=${deals.length}` +
        (first
          ? ` | ${first.product.name ?? "(이름 없음)"} / ` +
            `${first.price.priceText} / ` +
            `${first.product.store ?? "?"} / ${first.purchase.urlType}`
          : ` | "${post.title.slice(0, 50)}" (폼 미입력/자유형 — 스킵 정상)`),
    );
  }

  console.log("\n========== 인제스트 요약 ==========");
  console.log(`스냅샷 처리: ${processed}건`);
  console.log(`딜 파싱 성공(products≥1): ${parsedDeals}건`);
  console.log(`스킵(products=0 — 폼 미입력/자유형): ${skippedNoForm}건`);
  console.log(`스키마 위반: ${schemaFailures}건`);
  console.log(`파싱 오류/누락: ${parseErrors}건`);

  if (schemaFailures > 0 || parseErrors > 0) {
    console.log("\n인제스트 검증 실패");
    process.exit(1);
  }

  console.log("\n모든 스냅샷이 파서 파이프라인을 통과했습니다.");
}

main();
