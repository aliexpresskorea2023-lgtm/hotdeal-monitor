import { NextResponse } from "next/server";
import { adminEnabled } from "@/src/lib/admin-gate";
import {
  exchangeCode,
  fetchLogin,
  githubConfig,
  hasRepoWrite,
  OAUTH_STATE_COOKIE,
} from "@/src/lib/admin-github";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_AGE,
  signSession,
} from "@/src/lib/admin-session";

/*
 * GET /api/admin/auth/callback — GitHub가 code·state와 함께 돌려보낸다.
 *
 * 1) state 대조(CSRF) → 2) code를 access_token으로 교환
 * → 3) 로그인 핸들 조회 → 4) 대상 저장소 쓰기 권한 확인
 * → 5) 통과 시 HMAC 세션 쿠키 발급 후 /admin으로.
 *
 * GitHub 토큰 자체는 쿠키에 담지 않는다(세션은 login+exp만).
 */

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const c = part.trim();
    if (c.startsWith(`${name}=`)) return c.slice(name.length + 1);
  }
  return null;
}

export async function GET(req: Request) {
  if (!adminEnabled()) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const cfg = githubConfig();
  if (!cfg) {
    return new NextResponse("GitHub OAuth 미설정", { status: 500 });
  }

  const url = new URL(req.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stateCookie = readCookie(req, OAUTH_STATE_COOKIE);

  const fail = (reason: string) => {
    const res = NextResponse.redirect(
      new URL(`/admin/login?error=${reason}`, origin),
      { status: 302 },
    );
    res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  };

  // CSRF 검증
  if (!code || !state || !stateCookie || state !== stateCookie) {
    return fail("state");
  }

  // code → token
  const token = await exchangeCode(cfg, code, origin);
  if (!token) return fail("exchange");

  // 핸들 + 저장소 쓰기 권한
  const login = await fetchLogin(token);
  if (!login) return fail("user");

  const allowed = await hasRepoWrite(cfg, token);
  if (!allowed) return fail("forbidden");

  // 세션 발급
  const sessionToken = await signSession(login, ADMIN_SESSION_MAX_AGE);
  const res = NextResponse.redirect(new URL("/admin", origin), { status: 302 });
  res.cookies.set(ADMIN_SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_SESSION_MAX_AGE,
  });
  res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
