import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { adminAuthConfigured } from "@/src/lib/admin-gate";
import { ADMIN_SESSION_COOKIE, verifySession } from "@/src/lib/admin-session";

/*
 * 어드민 인증 미들웨어 — 레이아웃보다 먼저 실행된다(Edge 런타임).
 *
 * 통과 조건(하나라도):
 *   - GitHub OAuth 세션 쿠키(admin_session, HMAC) 유효
 *   - break-glass admin_token 쿠키 === ADMIN_TOKEN
 * 인증 수단이 아예 없는 로컬 개발은 통과.
 *
 * 미인증은 /admin/login으로. 단 /admin/login 자체는 검사 제외(무한루프 방지).
 * 인증 리다이렉트를 여기서 처리하므로 레이아웃은 ADMIN_MODE 게이트만 본다.
 *
 * API(/api/admin/*)는 matcher에 잡히지 않으며 각 라우트의 adminGate(req)가
 * Bearer/세션/쿠키를 검사한다.
 */

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 로그인 페이지·정적 자산은 검사 제외
  if (pathname === "/admin/login") {
    return NextResponse.next();
  }

  // 인증 수단이 없는 로컬 개발 — 통과
  if (!adminAuthConfigured()) return NextResponse.next();

  // 1) GitHub 세션 쿠키
  const sessionCookie = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (await verifySession(sessionCookie)) return NextResponse.next();

  // 2) break-glass admin_token 쿠키
  const token = process.env.ADMIN_TOKEN;
  const tokenCookie = request.cookies.get("admin_token")?.value;
  if (token && tokenCookie === token) return NextResponse.next();

  // 미인증 → 로그인으로
  return NextResponse.redirect(new URL("/admin/login", request.url));
}

export const config = {
  matcher: "/admin/:path*",
};
