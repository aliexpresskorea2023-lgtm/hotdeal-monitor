/*
 * 바깥에서 보이는 사이트 주소.
 *
 * 홈서버에서는 Cloudflare 터널 뒤에서 localhost:3002 로 요청을 받기 때문에
 * new URL(req.url).origin 이 내부 주소(127.0.0.1:3002)가 된다.
 * 그래서 리다이렉트·GitHub OAuth callback 주소는 이 함수로 만든다.
 *
 * 우선순위: PUBLIC_ORIGIN 환경변수 → X-Forwarded-Host/Proto 헤더 → 요청 URL.
 * PUBLIC_ORIGIN 이 없으면(로컬 개발·Vercel) 기존 동작과 같다.
 * Edge(middleware)에서도 쓰므로 Node 전용 API 를 쓰지 않는다.
 */
export function publicOrigin(req: Request): string {
  const env = process.env.PUBLIC_ORIGIN?.trim();
  if (env) return env.replace(/\/+$/, "");
  const host = req.headers.get("x-forwarded-host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto") || "https";
    return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
  }
  return new URL(req.url).origin;
}
