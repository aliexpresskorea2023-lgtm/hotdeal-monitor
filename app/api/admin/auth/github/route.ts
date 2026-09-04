import { NextResponse } from "next/server";
import { adminEnabled } from "@/src/lib/admin-gate";
import {
  OAUTH_STATE_COOKIE,
  authorizeUrl,
  githubConfig,
} from "@/src/lib/admin-github";

/*
 * GET /api/admin/auth/github — GitHub OAuth 인가 페이지로 보낸다.
 * CSRF 방지를 위해 랜덤 state를 생성, 짧은 수명 쿠키에 담아
 * 콜백에서 대조한다.
 */

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function GET(req: Request) {
  if (!adminEnabled()) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const cfg = githubConfig();
  if (!cfg) {
    return new NextResponse("GitHub OAuth 미설정", { status: 500 });
  }

  const origin = new URL(req.url).origin;
  const state = randomState();
  const url = authorizeUrl(cfg, origin, state);

  const res = NextResponse.redirect(url, { status: 302 });
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10분
  });
  return res;
}

