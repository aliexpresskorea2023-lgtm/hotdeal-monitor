import { notFound } from "next/navigation";
import { adminEnabled } from "@/src/lib/admin-gate";

/*
 * 어드민 레이아웃 — ADMIN_MODE=1(로컬)일 때만 열린다.
 * 프로덕션 빌드는 이 트리 전체가 404.
 */

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!adminEnabled()) notFound();

  return children;
}
