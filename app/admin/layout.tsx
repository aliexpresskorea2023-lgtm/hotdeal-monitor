import { notFound } from "next/navigation";
import { adminEnabled } from "@/src/lib/admin-gate";

/*
 * 어드민 레이아웃 — ADMIN_MODE=1일 때만 열린다.
 * 프로덕션 빌드는 ADMIN_MODE 미설정 시 이 트리 전체가 404.
 *
 * 토큰 인증(리다이렉트)은 middleware.ts가 담당한다.
 * 레이아웃에서 인증 리다이렉트를 하면 /admin/login이
 * 자기 자신으로 루프를 타므로, 여기선 활성 게이트만 본다.
 */

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!adminEnabled()) notFound();

  return children;
}
