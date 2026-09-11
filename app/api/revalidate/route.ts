import { NextResponse } from "next/server";
import { revalidateTag, revalidatePath } from "next/cache";
import { DEALS_CACHE_TAG } from "@/src/db/cached";

/*
 * 온디맨드 캐시 무효화 엔드포인트 (2026-09-11).
 *
 * 배경: 로컬 수집 파이프라인은 D1에 직적재하지만, Vercel Data Cache
 * (unstable_cache, TTL 3600s)는 서버리스 컨텍스트 밖에서 돌기 때문에
 * 파이프라인이 직접 bust할 수 없다. 그래서 D1 quota 장애 후 복구 시나
 * 백로그 적재 직후처럼 "원본은 최신인데 화면은 stale"인 경우가 생긴다.
 *
 * 이 라우트는 시크릿 토큰(REVALIDATE_SECRET)으로 보호되며, 호출 시
 * DEALS_CACHE_TAG를 즉시 만료(expire:0)시켜 다음 렌더가 D1을 다시 읽게 한다.
 * 파이프라인 [5/5] 단계가 ingest 후 이 엔드포인트를 curl로 호출하면
 * 캐시 lag 없이 prod가 곧바로 최신 데이터를 서빙한다.
 *
 * 인증: POST 헤더 `x-revalidate-secret` 또는 쿼리 `?secret=` 이
 * process.env.REVALIDATE_SECRET과 일치해야 한다.
 */

/** 라우트 존재를 숨긴다 — 쓰기(무효화) 전용. */
export function GET() {
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function POST(req: Request) {
  const expected = process.env.REVALIDATE_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "revalidate endpoint not configured" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const provided =
    req.headers.get("x-revalidate-secret") ?? url.searchParams.get("secret") ?? "";

  if (provided !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 태그 기반 캐시(feeds/history/admin)를 즉시 만료.
  revalidateTag(DEALS_CACHE_TAG, { expire: 0 });
  // 주요 공개 경로도 함께 갱신 트리거.
  revalidatePath("/", "layout");

  return NextResponse.json({
    ok: true,
    tag: DEALS_CACHE_TAG,
    revalidatedAt: new Date().toISOString(),
  });
}
