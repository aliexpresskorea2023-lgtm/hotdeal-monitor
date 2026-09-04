import { notFound, redirect } from "next/navigation";
import { adminEnabled } from "@/src/lib/admin-gate";

/*
 * 어드민 로그인 — ADMIN_TOKEN이 설정된 프로덕션에서만 의미 있다.
 * 토큰을 입력받아 쿠키로 설정하고 /admin으로 리다이렉트.
 * 로컬(토큰 없음)은 즉시 /admin으로 통과.
 */

export const dynamic = "force-dynamic";

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!adminEnabled()) notFound();

  // 토큰 미설정(로컬)이면 로그인 불필요 — 바로 통과
  if (!process.env.ADMIN_TOKEN) redirect("/admin");

  const params = await searchParams;
  const error = params.error === "1";

  return (
    <div style={{ maxWidth: 340, margin: "80px auto", padding: "0 16px" }}>
      <h1 style={{ fontSize: 18, marginBottom: 24 }}>어드민 로그인</h1>

      {error && (
        <p style={{ color: "#e53e3e", fontSize: 13, marginBottom: 12 }}>
          토큰이 올바르지 않습니다.
        </p>
      )}

      <form action="/api/admin/login" method="post">
        <input
          type="password"
          name="token"
          placeholder="관리자 토큰"
          autoFocus
          style={{
            width: "100%",
            padding: "10px 12px",
            border: "1px solid #d1d5db",
            borderRadius: 6,
            fontSize: 14,
            marginBottom: 12,
            boxSizing: "border-box",
          }}
        />
        <button
          type="submit"
          style={{
            width: "100%",
            padding: "10px",
            background: "#1a1a2e",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          로그인
        </button>
      </form>
    </div>
  );
}
