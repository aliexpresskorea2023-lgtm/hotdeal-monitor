import type { Db } from "./driver";

/*
 * 단축링크 해석·구매링크 점검 공용 계층.
 *
 * 제휴 단축링크(link.coupang.com/a/... 등)는 오프라인 정규화로
 * 상품 정체성을 알 수 없어 병합 키가 갈라진다. 해석 결과
 * (link_resolutions)는 키 합성에서만 참조하고, 노출 구매링크는
 * 제휴 귀속 유지를 위해 원본을 유지한다.
 *
 * 구매링크 점검 상태(link_checks)는 피드의 상태 합성이 참조한다 —
 * 커뮤니티 글에 종료 마커가 없어도 링크가 죽으면 종료 분류.
 */

/** 해석 대상 호스트 — 오프라인 정규화가 불가능한 제휴 래퍼. */
const SHORT_LINK_HOSTS = [
  "link.coupang.com",
  "coupa.ng",
  "link.gmarket.co.kr",
  "naver.me",
] as const;

/** 단축링크 해석 대상 여부 (호스트 화이트리스트). */
export function isShortLinkUrl(raw: string): boolean {
  try {
    const host = new URL(raw).host.toLowerCase();
    return (SHORT_LINK_HOSTS as readonly string[]).includes(host);
  } catch {
    return false;
  }
}

/**
 * 해석 결과 일괄 조회 — source_url → resolved_url.
 * 실패 기록(resolved_url NULL)은 지도에 넣지 않는다.
 * 테이블 미생성 환경(구 스냅샷 읽기 전용)은 빈 지도로 흡수.
 */
export function loadResolutions(
  db: Db,
  urls: Iterable<string | null | undefined>,
): Map<string, string> {
  const targets = [
    ...new Set(
      [...urls].filter((u): u is string => typeof u === "string" && u !== ""),
    ),
  ].filter(isShortLinkUrl);

  const result = new Map<string, string>();

  if (targets.length === 0) return result;

  /* sqlite 바인드 변수 상한 대비 청크 분할. */
  for (let i = 0; i < targets.length; i += 900) {
    const chunk = targets.slice(i, i + 900);
    const ph = chunk.map(() => "?").join(", ");

    let rows: { source_url: string; resolved_url: string }[];

    try {
      rows = db
        .prepare(
          `SELECT source_url, resolved_url FROM link_resolutions
           WHERE source_url IN (${ph}) AND resolved_url IS NOT NULL`,
        )
        .all(...chunk) as { source_url: string; resolved_url: string }[];
    } catch {
      return result;
    }

    for (const row of rows) {
      result.set(row.source_url, row.resolved_url);
    }
  }

  return result;
}

/** dead=1(확인된 사망 링크) 판정 키 집합 — 피드 상태 합성용. */
export function loadDeadKeys(db: Db): Set<string> {
  try {
    const rows = db
      .prepare(`SELECT product_key FROM link_checks WHERE dead = 1`)
      .all() as { product_key: string }[];

    return new Set(rows.map((r) => r.product_key));
  } catch {
    return new Set();
  }
}
