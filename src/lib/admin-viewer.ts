import { cookies } from "next/headers";
import { adminAuthConfigured, adminEnabled } from "./admin-gate";
import { ADMIN_SESSION_COOKIE, verifySession } from "./admin-session";

/*
 * 현재 요청의 어드민 뷰어 상태 — 서버 컴포넌트(레이아웃·공개 페이지) 전용.
 *
 * 공개 페이지의 "수정" 버튼과 사이드바 어드민 메뉴는 ADMIN_MODE 여부가 아니라
 * 실제 로그인 여부로 노출을 결정해야 한다(미로그인에게 어드민 UI 노출 방지).
 *
 * 판별 순서: GitHub 세션 쿠키 → break-glass admin_token 쿠키.
 * 인증 수단이 아예 없는 로컬 개발은 로그인으로 간주한다.
 *
 * middleware가 쓰는 admin-gate/admin-session과 분리해, next/headers 의존이
 * Edge 번들(미들웨어)로 새지 않게 한다.
 */

export interface AdminViewer {
  /** ADMIN_MODE=1 여부(어드민 빌드). */
  enabled: boolean;
  /** 로그인 주체 표시명. 미로그인이면 null. */
  login: string | null;
}

export async function getAdminViewer(): Promise<AdminViewer> {
  if (!adminEnabled()) return { enabled: false, login: null };

  // 인증 미설정(로컬 개발) — 로그인으로 간주
  if (!adminAuthConfigured()) return { enabled: true, login: "(로컬)" };

  const store = await cookies();

  const sess = await verifySession(store.get(ADMIN_SESSION_COOKIE)?.value);
  if (sess) return { enabled: true, login: sess.login };

  const token = process.env.ADMIN_TOKEN;
  if (token && store.get("admin_token")?.value === token) {
    return { enabled: true, login: "토큰 로그인" };
  }

  return { enabled: true, login: null };
}
