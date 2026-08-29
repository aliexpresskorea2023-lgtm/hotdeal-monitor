/*
 * 구매링크 사망 점검 — 피드 노출 중인 딜의 구매링크가 살아 있는지 확인한다.
 *
 * 배경: 커뮤니티 글에 종료 마커가 없어도 판매가 끝난 상품이 있다
 * (쿠팡 등은 기간 종료 시 상품 페이지 자체가 사라짐). 링크 접근 불가가
 * 확인되면 피드 상태 합성이 종료 취급한다 (커뮤 판정과 독립 신호).
 *
 * 신호 정책 (보수적 — 오탐으로 살아있는 딜을 종료시키지 않는 게 우선):
 * - 404/410 → 사망 신호. 2회 연속 확인 시 dead=1 확정.
 * - 200~399 (봇 챌린지 아님) → 생존 신호. 사망 카운트 초기화(부활).
 * - 봇 챌린지(200 + 작은 페이지 + 마커)·403·429·5xx·타임아웃·오류
 *   → 무신호. 상태를 바꾸지 않고 점검 시각만 갱신한다.
 *   (쿠팡 상품 페이지는 살아 있어도 Akamai 챌린지가 뜨므로
 *   무신호 처리가 필수 — 상태 코드만 보면 전량 오탐.)
 *
 * 대상: 피드 후보창(최근 500글, 종료 뒤로) 안의 노출 딜.
 * 단축링크는 해석 결과 우선으로 점검하며, 12시간 내 재점검 생략.
 *
 * 사용법:
 *   npx tsx scripts/check-dead-links.ts [--limit N]
 *   --limit: 최대 점검 수 (기본 40 — 08/22 스윕용 소량 배치)
 */
import { openDb, nowKstIso } from "../src/db/index";
import { checkExclusion } from "../src/db/exclusion";
import { loadResolutions } from "../src/db/link-resolution";
import { productKeyFromUrl } from "../src/db/queries";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const THROTTLE_MS = 1500;
const FETCH_TIMEOUT_MS = 15000;

/** 이 안에 점검한 키는 다시 보지 않는다. */
const RECHECK_HOURS = 12;

/** 봇 챌린지 인터스티셜은 본문이 거의 스크립트뿐이라 매우 작다. */
const CHALLENGE_SMALL_PAGE_BYTES = 64 * 1024;

/** 챌린지 페이지 본문 마커 — collect.py와 동일 계열. */
const CHALLENGE_MARKERS = [
  /* Cloudflare */
  "just a moment",
  "cf-chl",
  "_cf_chl",
  "/cdn-cgi/challenge-platform",
  /* Akamai Bot Manager (쿠팡 상품 페이지 챌린지) */
  "sec-if-cpt-container",
  "powered and protected by akamai",
  /* fmkorea 자체 WAF (구매링크로는 안 가지만 방어적으로) */
  "ddoscheckonly",
];

const CHALLENGE_TITLE_PATTERNS = [
  "just a moment",
  "attention required",
  "verify you are human",
  "checking your browser",
  "one more step",
  "请稍候",
];

/** 최종 응답이 봇 챌린지 인터스티셜인지 — 상태 코드만으로 못 잡는 경우. */
function isChallengePage(status: number, html: string): boolean {
  if (status < 200 || status >= 400) return false;
  if (html.length >= CHALLENGE_SMALL_PAGE_BYTES) return false;

  const low = html.toLowerCase();

  if (CHALLENGE_MARKERS.some((m) => low.includes(m))) return true;

  const title = low.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "";
  return CHALLENGE_TITLE_PATTERNS.some((p) => title.includes(p));
}

interface Candidate {
  key: string;
  /** 점검 대상 URL — 해석 결과 우선, 없으면 원본. */
  target: string;
}

interface CheckRow {
  dead_signals: number;
  dead: number;
}

type Verdict =
  | { kind: "dead"; status: number }
  | { kind: "alive"; status: number }
  | { kind: "unknown"; status: number | null; note: string };

async function checkOnce(url: string): Promise<Verdict> {
  let res: Response;

  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.name : "오류";
    return { kind: "unknown", status: null, note: msg };
  }

  /* 사망 신호는 404/410뿐 — 보수적 기준. */
  if (res.status === 404 || res.status === 410) {
    return { kind: "dead", status: res.status };
  }

  if (res.status >= 200 && res.status < 400) {
    /* 챌린지 여부는 본문으로 판정 — 200이라도 챌린지면 무신호. */
    let html = "";

    try {
      html = await res.text();
    } catch {
      return { kind: "unknown", status: res.status, note: "본문 읽기 실패" };
    }

    if (isChallengePage(res.status, html)) {
      return { kind: "unknown", status: res.status, note: "봇 챌린지" };
    }

    return { kind: "alive", status: res.status };
  }

  /* 403/429/5xx 등 — 차단·과부하인지 사망인지 구분 불가. */
  return { kind: "unknown", status: res.status, note: `HTTP ${res.status}` };
}

function parseLimit(argv: string[]): number {
  const i = argv.indexOf("--limit");
  if (i < 0) return 40;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 40;
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv.slice(2));
  const db = openDb();

  try {
    /* 피드 후보창과 동일한 500글 창에서 노출 딜의 구매링크를 모은다. */
    const rows = db
      .prepare(
        `WITH window_posts AS (
           SELECT id, community, title FROM posts
           WHERE hidden = 0
             AND EXISTS (SELECT 1 FROM deals d WHERE d.post_rowid = posts.id)
           ORDER BY CASE status WHEN 'ended' THEN 1 ELSE 0 END,
                    COALESCE(posted_at, first_seen_at) DESC, id DESC
           LIMIT 500
         )
         SELECT COALESCE(d.url_override, d.product_url) AS url,
                p.community AS community, p.title AS title,
                d.category AS category, d.deal_price AS price,
                d.exclusion_restored AS restored
         FROM deals d
         JOIN window_posts p ON p.id = d.post_rowid
         WHERE d.hidden = 0
           AND d.excluded_reason IS NULL
           AND COALESCE(d.url_override, d.product_url) IS NOT NULL`,
      )
      .all() as {
      url: string;
      community: string;
      title: string;
      category: string | null;
      price: number | null;
      restored: number;
    }[];

    /* 피드와 같은 제외 규칙 적용 — 노출되지 않는 딜은 점검할 이유도 없다. */
    const visible = rows.filter(
      (r) =>
        r.restored === 1 ||
        !checkExclusion({
          community: r.community,
          category: r.category,
          title: r.title,
          price: r.price,
        }).excluded,
    );

    const resolutions = loadResolutions(
      db,
      visible.map((r) => r.url),
    );

    /* 상품 키 단위로 중복 제거 — 같은 상품은 한 번만 점검. */
    const candidates: Candidate[] = [];
    const seen = new Set<string>();

    for (const r of visible) {
      let parsed: URL;

      try {
        parsed = new URL(r.url);
      } catch {
        continue;
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        continue;
      }

      const resolved = resolutions.get(r.url);
      const key = productKeyFromUrl(resolved ?? r.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      candidates.push({ key, target: resolved ?? r.url });
    }

    /* 최근 점검분 스킵. 시각 문자열은 +09:00 표기로 통일되어 있어
     * 동일 표기끼리 비교해야 사전식 순서가 실제 순서와 같아진다. */
    const cutoff = new Date(
      Date.now() - RECHECK_HOURS * 3600 * 1000 + 9 * 3600 * 1000,
    )
      .toISOString()
      .replace("Z", "+09:00");

    const fresh = candidates.filter((c) => {
      const row = db
        .prepare(
          `SELECT last_checked_at FROM link_checks WHERE product_key = ?`,
        )
        .get(c.key) as { last_checked_at: string | null } | undefined;

      return !row?.last_checked_at || row.last_checked_at < cutoff;
    });

    const batch = fresh.slice(0, limit);

    console.log(
      `[사망 점검] 후보 ${candidates.length}건 (재점검 제외 ${fresh.length}) 중 ${batch.length}건 시도 (상한 ${limit})`,
    );

    if (batch.length === 0) return;

    const upsert = db.prepare(
      `INSERT INTO link_checks
         (product_key, target_url, last_checked_at, last_status, dead_signals, dead)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(product_key) DO UPDATE SET
         target_url = excluded.target_url,
         last_checked_at = excluded.last_checked_at,
         last_status = excluded.last_status,
         dead_signals = excluded.dead_signals,
         dead = excluded.dead`,
    );

    let deadCount = 0;
    let aliveCount = 0;
    let revivedCount = 0;
    let unknownCount = 0;

    for (let i = 0; i < batch.length; i++) {
      const c = batch[i];
      const verdict = await checkOnce(c.target);
      const prev = db
        .prepare(
          `SELECT dead_signals, dead FROM link_checks WHERE product_key = ?`,
        )
        .get(c.key) as CheckRow | undefined;

      const prevSignals = prev?.dead_signals ?? 0;
      const prevDead = prev?.dead ?? 0;
      const now = nowKstIso();

      let deadSignals = prevSignals;
      let dead = prevDead;

      if (verdict.kind === "dead") {
        deadSignals = prevSignals + 1;
        dead = deadSignals >= 2 ? 1 : 0;
        deadCount++;
        console.log(
          `[사망 점검] (${i + 1}/${batch.length}) ✗ ${verdict.status} 신호 ${deadSignals}회${dead ? " → 사망 확정" : ""}: ${c.target}`,
        );
      } else if (verdict.kind === "alive") {
        deadSignals = 0;
        dead = 0;
        if (prevDead === 1) {
          revivedCount++;
          console.log(
            `[사망 점검] (${i + 1}/${batch.length}) ↺ 부활 (${verdict.status}): ${c.target}`,
          );
        } else {
          aliveCount++;
        }
      } else {
        unknownCount++;
        console.log(
          `[사망 점검] (${i + 1}/${batch.length}) ? 무신호 (${verdict.note}): ${c.target}`,
        );
      }

      upsert.run(
        c.key,
        c.target,
        now,
        verdict.status,
        deadSignals,
        dead,
      );

      if (i < batch.length - 1) {
        await new Promise((r) => setTimeout(r, THROTTLE_MS));
      }
    }

    console.log(
      `[사망 점검] 완료: 사망 신호 ${deadCount}, 생존 ${aliveCount}, 부활 ${revivedCount}, 무신호 ${unknownCount}`,
    );
  } finally {
    db.close();
  }
}

main();
