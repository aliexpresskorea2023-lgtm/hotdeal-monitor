import { NextResponse } from "next/server";
import { adminEnabled } from "@/src/lib/admin-gate";
import { ADMIN_SESSION_COOKIE } from "@/src/lib/admin-session";

/*
 * POST /api/admin/auth/logout — 세션 쿠키를 지우고 홈으로.
 * break-glass admin_token 쿠키도 함께 정리한다.
 */

export async function POST(req: Request) {
  if (!adminEnabled()) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const origin = new URL(req.url).origin;
  const res = NextResponse.redirect(new URL("/", origin), { status: 302 });
  res.cookies.set(ADMIN_SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  res.cookies.set("admin_token", "", { path: "/", maxAge: 0 });
  return res;
}
