import { unstable_cache } from "next/cache";
import { getDealFeed, type FeedOptions, type FeedResult } from "./queries";
import {
  getPriceHistory,
  type HistoryOptions,
  type HistoryResult,
} from "./history";

/*
 * 공개 페이지 데이터 레이어 캐시 (2026-09-04, D1 row-read 한도 장애 대응).
 *
 * 문제: /, /history, /ranking은 force-dynamic + searchParams라 요청마다 서버
 * 렌더되고, getDealFeed는 게시글 500건과 그에 딸린 딜/관측/이미지/링크
 * 해석을 통째로 DB에서 읽는다. D1 백엔드에서 이건 무료 티어 일일 row-read
 * 한도(5M)를 하루 만에 소진시켰다(→ HTTP 400 [7500], 전 페이지 500).
 *
 * 해결: 데이터 조회 결과를 unstable_cache(Vercel Data Cache — 서버리스
 * 인스턴스 간 공유·지속)로 감싼다. 페이지 셸은 여전히 동적(필터/검색 쿼리)
 * 이지만, 동일 필터 조합의 실제 DB 읽기는 revalidate 초에 1회로 제한되어
 * row-read가 자릿수로 줄어든다. 캐시 키는 keyParts + 인자(options)로
 * 자동 생성되므로 필터별로 독립적으로 캐싱된다.
 *
 * 실시간성: 어드민 쓰기(API route)는 성공 후 revalidateTag(DEALS_CACHE_TAG)
 * 로 캐시를 즉시 무효화한다 → 편집 결과가 다음 렌더에 곧바로 반영된다
 * (모달 닫을 때의 router.refresh()와 맞물림). 수집 파이프라인 갱신은 TTL
 * 경과로 반영되는데, 수집 주기(2시간)가 TTL보다 훨씬 길어 체감 지연이 없다.
 *
 * 주의: unstable_cache에 넘기는 함수는 async여야 하고 반환값은 JSON 직렬화
 * 가능해야 한다(ItemView/FeedResult·HistoryResult는 모두 순수 데이터).
 * 인자(options)는 항상 명시적 객체로 넘겨 키가 안정적으로 나오게 한다.
 */

/** 어드민 쓰기 시 무효화할 캐시 태그. */
export const DEALS_CACHE_TAG = "deals";

/** 메인 피드 TTL(초). 필터 조합당 이 주기마다 D1을 1회 읽는다. */
export const FEED_REVALIDATE = 120;

/** 최저가 히스토리 TTL(초). 값 변화가 드물어 피드보다 길게 잡는다. */
export const HISTORY_REVALIDATE = 300;

/** getDealFeed 캐싱 래퍼 — 공개 피드/랭킹용. */
export const getCachedDealFeed = unstable_cache(
  async (options: FeedOptions): Promise<FeedResult> => getDealFeed(options),
  ["deal-feed"],
  { revalidate: FEED_REVALIDATE, tags: [DEALS_CACHE_TAG] },
);

/** getPriceHistory 캐싱 래퍼 — 최저가 히스토리용. */
export const getCachedPriceHistory = unstable_cache(
  async (options: HistoryOptions): Promise<HistoryResult> =>
    getPriceHistory(options),
  ["price-history"],
  { revalidate: HISTORY_REVALIDATE, tags: [DEALS_CACHE_TAG] },
);
