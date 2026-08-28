/*
 * 어드민 게이트 — 모든 어드민 라우트(페이지·API)의 진입점.
 *
 * ADMIN_MODE=1일 때만 어드민이 열린다. 프로덕션(Vercel)은
 * 환경변수 미설정이라 빌드에는 코드가 포함돼도 입구가 없다.
 */

export function adminEnabled(): boolean {
  return process.env.ADMIN_MODE === "1";
}

/** API 라우트용 — 비활성 시 404 응답을 돌려준다. */
export function adminGate(): Response | null {
  if (adminEnabled()) return null;

  return new Response("Not Found", { status: 404 });
}
