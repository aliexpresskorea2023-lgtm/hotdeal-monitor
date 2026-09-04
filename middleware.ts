import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/*
 * 어드민 인증 미들웨어 — 레이아웃보다 먼저 실행된다.
 *
 * 역할: ADMIN_TOKEN이 설정된 환경(프로덕션)에서 /admin/* 접근을
 * 쿠키로 검증하고, 미인증이면 /admin/login으로 보낸다.
 *
 * 레이아웃(app/admin/layout.tsx)은 ADMIN_MODE 게이트(404)만 담당하고,
 * 인증 리다이렉트는 여기서 처리한다. 그래야 /admin/login이
 * 레이아웃의 리다이렉트와 충돌해 무한 루프에 빠지지 않는다.
 *
 * API(/api/admin/*)는 matcher에 잡히지 않으며, 각 라우트의
 * adminGate(req)가 Bearer/쿠키를 검사한다.
 */

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 로그인 페이지는 인증 검사 제외 (무한 루프 방지)
  if (pathname === "/admin/login") {
    return NextResponse.next();
  }

  // 토큰 미설정(로컬 개발)이면 인증 불요
  const token = process.env.ADMIN_TOKEN;
  if (!token) return NextResponse.next();

  // 쿠키 검증
  const cookie = request.cookies.get("admin_token")?.value;
  if (cookie === token) return NextResponse.next();

  // 미인증 → 로그인으로
  const loginUrl = new URL("/admin/login", request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: "/admin/:path*",
};
