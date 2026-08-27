/*
 * 일회성 탐사: 상품 페이지에서 og:image 썸네일을 얼마나 안정적으로
 * 추출할 수 있는지 도메인별 실측한다. (파이프라인 미포함 스크립트)
 *
 * 표본: 도메인별 최근 direct URL 1개 + 대형 몰 추가 표본.
 * 단계 1: 평범한 fetch + 브라우저 UA.
 * 단계 2(선택 --cffi): Python curl_cffi impersonate=chrome 재시도.
 */
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TARGET_HOSTS = [
  "link.coupang.com",
  "coupang.com",
  "smartstore.naver.com",
  "brand.naver.com",
  "toss.shopping",
  "store.ohou.se",
  "item.gmarket.co.kr",
  "lotteon.com",
  "s.lotteon.com",
  "11st.co.kr",
  "ko.aliexpress.com",
  "aliexpress.com",
  "store.kakao.com",
  "29cm.co.kr",
  "wconcept.co.kr",
  "compuzone.co.kr",
  "seorinexpress.com",
  "e-himart.co.kr",
];

function pickSamples(): { host: string; url: string; name: string | null }[] {
  const db = new DatabaseSync(path.join(ROOT, "data", "hotdeal.db"), {
    readOnly: true,
  });
  const rows = db
    .prepare(
      `SELECT d.product_url AS url, d.product_name AS name
       FROM deals d
       WHERE d.product_url IS NOT NULL AND d.url_type = 'direct'
       ORDER BY d.id DESC`,
    )
    .all() as { url: string; name: string | null }[];
  db.close();

  const seen = new Set<string>();
  const out: { host: string; url: string; name: string | null }[] = [];

  for (const host of TARGET_HOSTS) {
    const hit = rows.find((r) => {
      try {
        const h = new URL(r.url).host.replace(/^www\.|^m\./, "");
        return h === host && !seen.has(r.url);
      } catch {
        return false;
      }
    });
    if (hit) {
      seen.add(hit.url);
      out.push({ host, url: hit.url, name: hit.name });
    }
  }
  return out;
}

function extractImage(html: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)/i,
    /<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1].startsWith("http")) return m[1];
  }
  return null;
}

async function probeFetch(
  url: string,
): Promise<{ ok: boolean; status?: number; image?: string | null; error?: string }> {
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
    const body = await res.text();
    return { ok: res.ok, status: res.status, image: extractImage(body) };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 80) };
  }
}

async function main() {
  const useCffi = process.argv.includes("--cffi");
  const samples = pickSamples();
  console.log(`표본 ${samples.length}개 URL 탐사 시작${useCffi ? " (cffi 단계 포함)" : ""}\n`);

  let ok = 0;
  let img = 0;

  for (const s of samples) {
    const r = await probeFetch(s.url);
    let note = "";

    if (r.ok && r.image) {
      img++;
      ok++;
      note = `OG ✓ ${r.image.slice(0, 90)}`;
    } else if (r.ok) {
      ok++;
      note = `페이지 200, og:image 없음 (${r.status})`;
    } else {
      note = `실패 status=${r.status ?? "-"} ${r.error ?? ""}`;
    }

    console.log(
      `${s.host.padEnd(22)} ${note}  [${(s.name ?? "").slice(0, 30)}]`,
    );
  }

  console.log(
    `\n요약: 페이지 접근 ${ok}/${samples.length}, og:image 추출 ${img}/${samples.length}`,
  );

  if (!useCffi) return;

  /* 2단계: 1단계 실패 건만 curl_cffi로 재시도 */
  const py = path.join(ROOT, "collector", ".venv", "bin", "python");
  console.log("\n--- curl_cffi 재시도 (실패 건) ---");
  for (const s of samples) {
    const r = await probeFetch(s.url);
    if (r.ok && r.image) continue;

    try {
      const out = execFileSync(
        py,
        [
          "-c",
          `
import sys, re
from curl_cffi import requests
url = sys.argv[1]
try:
    resp = requests.get(url, impersonate="chrome", timeout=15, allow_redirects=True)
    html = resp.text
    m = re.search(r'property=["\\']og:image["\\'][^>]+content=["\\']([^"\\']+)', html) or \\
        re.search(r'content=["\\']([^"\\']+)["\\'][^>]+property=["\\']og:image["\\']', html)
    img = m.group(1) if m and m.group(1).startswith("http") else None
    print(f"{resp.status_code}|{img or ''}")
except Exception as e:
    print(f"ERR|{type(e).__name__}: {str(e)[:70]}")
`,
          s.url,
        ],
        { encoding: "utf-8", timeout: 30000 },
      ).trim();
      console.log(`${s.host.padEnd(22)} cffi: ${out.slice(0, 120)}`);
    } catch (e) {
      console.log(`${s.host.padEnd(22)} cffi 에러: ${String(e).slice(0, 60)}`);
    }
  }
}

main();
