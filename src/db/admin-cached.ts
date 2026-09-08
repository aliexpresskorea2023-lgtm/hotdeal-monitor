import { unstable_cache } from "next/cache";
import { DEALS_CACHE_TAG } from "./cached";
import {
  buildThumbnailRows,
  countAdminDeals,
  listAdminDeals,
  type AdminDealRow,
  type AdminListOptions,
  type AdminListResult,
  type AdminThumbnailRow,
} from "./admin-queries";

/*
 * 어드민 읽기 캐시 (2026-09-08, D1 row-read 절감 4단계).
 *
 * 배경: /admin/excluded·/thumbnails·/deals는 force-dynamic + searchParams라
 * 페이지네이션·탭 전환마다 전체 COUNT+SELECT를 재실행한다. 단일 사용자
 * 트래픽이라 공개 페이지만큼 치명적이지는 않지만, D1 무료 티어 5M
 * row-read 한도가 공개 트래픽과 합산되는 만큼 여유분을 확보해둔다.
 *
 * 설계:
 * - unstable_cache + DEALS_CACHE_TAG — 어드민 쓰기 API가 이미
 *   revalidateTag(DEALS_CACHE_TAG)를 호출하므로 편집 결과가 즉시 반영된다.
 * - TTL 60초 — 수집 파이프라인(2시간)보다 훨씬 짧아 파이프라인 적재
 *   지연이 체감되지 않고, 어드민 쓰기 tag 무효화와 결합해 일관성 유지.
 * - buildThumbnailRows는 인자가 없어 캐시 키가 유일하다 — 페이지네이션·
 *   탭 전환이 모두 같은 엔트리를 공유한다.
 * - listAdminDeals/countAdminDeals는 options가 캐시 키에 포함된다.
 *   자유 텍스트 q가 키 공간에 들어가지만, 어드민은 단일 사용자라
 *   공개 피드처럼 무한대로 갈라지지는 않는다.
 */

/** 어드민 읽기 TTL(초). 쓰기 시 tag 무효화로 즉시 반영. */
export const ADMIN_REVALIDATE = 60;

/** listAdminDeals 캐싱 래퍼. */
export const getCachedAdminDealList = unstable_cache(
  async (options: AdminListOptions): Promise<AdminListResult> =>
    listAdminDeals(options),
  ["admin-deal-list"],
  { revalidate: ADMIN_REVALIDATE, tags: [DEALS_CACHE_TAG] },
);

/** countAdminDeals 캐싱 래퍼 — 탭 카운트용. */
export const getCachedAdminDealCount = unstable_cache(
  async (options: AdminListOptions): Promise<number> =>
    countAdminDeals(options),
  ["admin-deal-count"],
  { revalidate: ADMIN_REVALIDATE, tags: [DEALS_CACHE_TAG] },
);

/**
 * buildThumbnailRows 캐싱 래퍼 — 유일한 캐시 키.
 * /admin/thumbnails의 countThumbnails·listThumbnails가 이 결과를
 * 공유해 D1 row-read를 페이지 렌더당 1회로 고정한다.
 */
export const getCachedThumbnailRows = unstable_cache(
  async (): Promise<AdminThumbnailRow[]> => buildThumbnailRows(),
  ["admin-thumbnail-rows"],
  { revalidate: ADMIN_REVALIDATE, tags: [DEALS_CACHE_TAG] },
);

/* re-export — 페이지가 캐시 래퍼와 원본 함수를 함께 import할 필요 없이
 * 이 모듈 하나로 어드민 읽기를 해결할 수 있게. */
export type { AdminDealRow, AdminListOptions, AdminListResult, AdminThumbnailRow };
