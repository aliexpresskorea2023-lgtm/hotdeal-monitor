/*
 * 어드민 게이트 — 모든 어드민 API 라우트의 진입점.
 *
 * ADMIN_MODE=1일 때만 어드민이 열린다(미설정 빌드는 404로 존재를 숨김).
 *
 * 인증 수단(하나라도 통과하면 허용):
 *   1) GitHub OAuth 세션 쿠키(admin_session, HMAC 서명) — 사람 사용자.
 *   2) Authorization: Bearer <ADMIN_TOKEN> — 스크립트·자동화.
 *   3) admin_token 쿠키 = ADMIN_TOKEN — 브라우저 break-glass.
 *
 * 위 어느 것도 설정되지 않은 로컬 개발(ADMIN_MODE=1만)은 통과시킨다.
 *
 * 브라우저 페이지 인증(쿠키 → /admin/login 리다이렉트)은 middleware.ts가
 * 담당한다. 이 모듈은 API 라우트 게이트 전용.
 */

import { ADMIN_SESSION_COOKIE, verifySession } from "./admin-session";

export function adminEnabled(): boolean {
  return process.env.ADMIN_MODE === "1";
}

function adminToken(): string | null {
  return process.env.ADMIN_TOKEN || null;
}

/** 인증 수단이 하나라도 설정돼 있는지(프로덕션 여부 판별용). */
export function adminAuthConfigured(): boolean {
  return Boolean(
    adminToken() ||
      process.env.ADMIN_SESSION_SECRET ||
      process.env.GITHUB_CLIENT_ID,
  );
}

function readCookie(req: Request | undefined, name: string): string | null {
  const header = req?.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const c = part.trim();
    if (c.startsWith(`${name}=`)) return c.slice(name.length + 1);
  }
  return null;
}

/**
 * API 라우트용 게이트. 비활성 404 / 미인증 401 / 통과 null.
 * 세션 검증이 비동기(Web Crypto)라 async.
 */
export async function adminGate(req?: Request): Promise<Response | null> {
  if (!adminEnabled()) {
    return new Response("Not Found", { status: 404 });
  }

  // 1) GitHub 세션 쿠키
  const session = await verifySession(readCookie(req, ADMIN_SESSION_COOKIE));
  if (session) return null;

  const token = adminToken();

  // 2) Bearer 헤더
  if (token && req) {
    const auth = req.headers.get("authorization");
    if (auth === `Bearer ${token}`) return null;
  }

  // 3) break-glass admin_token 쿠키
  if (token && readCookie(req, "admin_token") === token) return null;

  // 아무 인증도 설정되지 않은 로컬 개발 — 통과
  if (!adminAuthConfigured()) return null;

  return new Response("Unauthorized", { status: 401 });
}
