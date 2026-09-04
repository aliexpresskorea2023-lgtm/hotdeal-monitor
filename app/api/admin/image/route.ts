import { NextResponse } from "next/server";
import { adminGate } from "@/src/lib/admin-gate";
import {
  openAdminDb,
  resetImageCache,
  setImageOverride,
} from "@/src/db/admin";

/*
 * 어드민 썸네일 쓰기.
 * POST { key, url }       — 수동 썸네일 지정
 * POST { key, url: null } — 수동 지정 해제
 * POST { key, reset: 1 }  — 캐시 초기화 (자동 수집 재시도)
 */

/** 쓰기 전용 — 게이트와 무관하게 라우트 존재를 숨긴다. */
export function GET() {
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function POST(req: Request) {
  const gate = await adminGate(req);
  if (gate) return gate;

  const body = (await req.json()) as {
    key?: unknown;
    url?: unknown;
    reset?: unknown;
  };

  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key) {
    return NextResponse.json({ error: "key required" }, { status: 400 });
  }

  const db = openAdminDb();

  try {
    if (body.reset === 1 || body.reset === true) {
      resetImageCache(db, key);
    } else if (body.url === null) {
      setImageOverride(db, key, null);
    } else if (typeof body.url === "string" && /^https?:\/\//.test(body.url.trim())) {
      setImageOverride(db, key, body.url.trim());
    } else {
      return NextResponse.json(
        { error: "url must be an absolute http(s) URL or null" },
        { status: 400 },
      );
    }

    return NextResponse.json({ ok: true });
  } finally {
    db.close();
  }
}
