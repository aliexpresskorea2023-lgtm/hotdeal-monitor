import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { adminGate } from "@/src/lib/admin-gate";
import { DEALS_CACHE_TAG } from "@/src/db/cached";
import {
  getMergePreview,
  searchMergeDeals,
  type MergeDealInfo,
} from "@/src/db/admin-queries";
import { clearMergeKey, openAdminDb, setMergeKey } from "@/src/db/admin";

/*
 * 어드민 카드 병합 쓰기 (2단계).
 *
 * POST — 액션.
 *   { action: "merge", dealIds: number[], canonicalDealId: number }
 *       대표 딜의 유효 키를 canonicalKey로 삼아 dealIds 전부의
 *       product_key_override를 그 키로 맞춘다 → 피드·히스토리가 한
 *       카드로 합쳐진다. 대표 딜에 URL 키가 없으면(게시글 폴백)
 *       멤버 중 URL 키가 있는 것을 대표 키로 승격해 썸네일이 산다.
 *   { action: "unmerge", dealId: number }
 *       딜 하나의 수동 병합을 해제 — 자연 키(URL/게시글)로 복귀.
 *   { action: "search", q: string, limit?: number }
 *       수동 병합 모달의 라이브 검색 — 상품명·게시글 제목 부분 일치
 *       카드를 MergeDealInfo[] JSON으로 반환(캐시 없이 즉시). 쓰기가
 *       아니지만 GET 라우트를 숨기려 POST로 받고 adminGate를 지난다.
 *
 * 쓰기는 항상 product_key_override 컬럼에만 — 파서 값은 불변.
 */

/** 쓰기 전용 — 게이트와 무관하게 라우트 존재를 숨긴다. */
export function GET() {
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

function intArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;

  const out: number[] = [];
  for (const v of value) {
    const n = Number(v);
    if (!Number.isInteger(n)) return null;
    out.push(n);
  }
  return out;
}

export async function POST(req: Request) {
  const gate = await adminGate(req);
  if (gate) return gate;

  const body = (await req.json().catch(() => null)) as {
    action?: string;
    dealIds?: unknown;
    canonicalDealId?: unknown;
    dealId?: unknown;
    q?: unknown;
    limit?: unknown;
  } | null;

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }

  try {
    if (body.action === "search") {
      const q = typeof body.q === "string" ? body.q.trim() : "";
      if (q === "") {
        return NextResponse.json({ error: "검색어를 입력하세요" }, { status: 400 });
      }

      const rawLimit = Number(body.limit);
      const limit = Number.isInteger(rawLimit)
        ? Math.min(100, Math.max(1, rawLimit))
        : 50;

      const results: MergeDealInfo[] = searchMergeDeals(q, limit);
      return NextResponse.json({ ok: true, results, count: results.length });
    }

    if (body.action === "merge") {
      const dealIds = intArray(body.dealIds);
      const canonicalDealId = Number(body.canonicalDealId);

      if (!dealIds || dealIds.length < 2) {
        return NextResponse.json(
          { error: "병합할 카드를 2개 이상 선택하세요" },
          { status: 400 },
        );
      }
      if (!Number.isInteger(canonicalDealId)) {
        return NextResponse.json(
          { error: "대표 카드를 지정하세요" },
          { status: 400 },
        );
      }

      const uniqueIds = [...new Set(dealIds)];
      if (!uniqueIds.includes(canonicalDealId)) {
        return NextResponse.json(
          { error: "대표 카드는 선택한 카드 중 하나여야 합니다" },
          { status: 400 },
        );
      }

      /* 대표 키 산출 — 읽기 계층이 피드와 동일한 유효 키를 계산한다. */
      const preview = getMergePreview(uniqueIds, canonicalDealId);
      if (!preview || preview.canonicalKey === null) {
        return NextResponse.json(
          { error: "대표 카드의 병합 키를 계산할 수 없습니다" },
          { status: 400 },
        );
      }

      let canonicalKey = preview.canonicalKey;

      /*
       * 대표 딜이 게시글 폴백 키(post:…)면 그룹 썸네일이 죽는다.
       * 멤버 중 실제 URL 키가 있으면 그것을 대표 키로 승격 — 같은
       * 상품인데 링크 있는 카드를 기준으로 정체성을 맞춘다.
       */
      if (canonicalKey.startsWith("post:")) {
        const withUrl = preview.deals.find((d) => d.urlKey !== null);
        if (withUrl?.urlKey) canonicalKey = withUrl.urlKey;
      }

      const db = openAdminDb();
      try {
        const changed = setMergeKey(db, uniqueIds, canonicalKey);
        revalidateTag(DEALS_CACHE_TAG, { expire: 0 });
        return NextResponse.json({
          ok: true,
          changed,
          canonicalKey,
          count: uniqueIds.length,
        });
      } finally {
        db.close();
      }
    }

    if (body.action === "unmerge") {
      const dealId = Number(body.dealId);
      if (!Number.isInteger(dealId)) {
        return NextResponse.json({ error: "bad dealId" }, { status: 400 });
      }

      const db = openAdminDb();
      try {
        clearMergeKey(db, dealId);
        revalidateTag(DEALS_CACHE_TAG, { expire: 0 });
        return NextResponse.json({ ok: true });
      } finally {
        db.close();
      }
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  }
}
