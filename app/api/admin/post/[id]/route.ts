import { NextResponse } from "next/server";
import { adminGate } from "@/src/lib/admin-gate";
import { openAdminDb, patchPost } from "@/src/db/admin";

/*
 * 어드민 게시글 쓰기 — 상태 지정·숨김.
 * PATCH { status_override?: "active"|"ended"|null, hidden?: 0|1 }
 */

type Params = { params: Promise<{ id: string }> };

/** 쓰기 전용 — 게이트와 무관하게 라우트 존재를 숨긴다. */
export function GET() {
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function PATCH(req: Request, { params }: Params) {
  const gate = adminGate(req);
  if (gate) return gate;

  const { id } = await params;
  const postId = Number(id);
  if (!Number.isInteger(postId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }

  const body = (await req.json()) as Record<string, unknown>;

  const status =
    body.status_override === "active" || body.status_override === "ended"
      ? body.status_override
      : body.status_override === null
        ? null
        : undefined;

  const db = openAdminDb();

  try {
    patchPost(db, postId, {
      status_override: status,
      hidden:
        body.hidden === 0 || body.hidden === 1 ? body.hidden : undefined,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 400 });
  } finally {
    db.close();
  }
}
