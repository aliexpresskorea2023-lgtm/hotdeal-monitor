import { redirect } from "next/navigation";

/* 빌드 시점에 404가 고정되지 않도록 — 게이트는 요청 시점 판단. */
export const dynamic = "force-dynamic";

export default function AdminIndexPage() {
  redirect("/admin/deals");
}
