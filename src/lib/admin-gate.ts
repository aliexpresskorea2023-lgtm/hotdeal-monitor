/*
 * 어드민 게이트 — 모든 어드민 라우트(페이지·API)의 진입점.
 *
 * ADMIN_MODE=1일 때만 어드민이 열린다.
 * ADMIN_TOKEN이 설정되면(프로덕션) 토큰 인증을 요구한다:
 *   - API: Authorization: Bearer <token> 헤더
 *   - 브라우저: admin_token 쿠키 (로그인 페이지에서 설정)
 * ADMIN_TOKEN 미설정(로컬 개발)이면 토큰 없이 접근 허용.
 *
 * 브라우저 페이지 인증(쿠키 → /admin/login 리다이렉트)은
 * middleware.ts가 처리한다. 이 모듈은 API 라우트 게이트 전용.
 */

export function adminEnabled(): boolean {
  return process.env.ADMIN_MODE === "1";
}

function adminToken(): string | null {
  return process.env.ADMIN_TOKEN || null;
}

/** API 라우트용 — 비활성·미인증 시 404/401 응답을 돌려준다. */
export function adminGate(req?: Request): Response | null {
  if (!adminEnabled()) {
    return new Response("Not Found", { status: 404 });
  }

  const token = adminToken();
  if (!token) return null; // 로컬 개발 — 토큰 불요

  // Bearer 헤더 확인
  if (req) {
    const auth = req.headers.get("authorization");
    if (auth === `Bearer ${token}`) return null;
  }

  // 쿠키 확인 (API에서도 폴백)
  const cookieVal = req?.headers.get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("admin_token="))
    ?.slice("admin_token=".length);

  if (cookieVal === token) return null;

  return new Response("Unauthorized", { status: 401 });
}
