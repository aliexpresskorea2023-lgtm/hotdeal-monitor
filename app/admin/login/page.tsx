import { notFound, redirect } from "next/navigation";
import { adminEnabled } from "@/src/lib/admin-gate";
import { githubConfig } from "@/src/lib/admin-github";

/*
 * 어드민 로그인 — GitHub OAuth가 주 인증, 토큰은 break-glass.
 *
 * "GitHub로 로그인" → /api/admin/auth/github → GitHub 인가 → 콜백 → 세션 쿠키.
 * 하단 토큰 폼은 GitHub 장애 시 긴급 진입용(ADMIN_TOKEN 설정 시에만 노출).
 */

export const dynamic = "force-dynamic";

const ERROR_MSG: Record<string, string> = {
  forbidden: "이 GitHub 계정은 저장소 쓰기 권한이 없습니다.",
  state: "로그인 시도가 만료되었습니다. 다시 시도해 주세요.",
  exchange: "GitHub 인증에 실패했습니다. 다시 시도해 주세요.",
  user: "GitHub 사용자 정보를 가져오지 못했습니다.",
  "1": "토큰이 올바르지 않습니다.",
};

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!adminEnabled()) notFound();

  const cfg = githubConfig();
  const hasToken = Boolean(process.env.ADMIN_TOKEN);

  // 인증 수단이 아무것도 없으면(로컬) 로그인 불필요 — 바로 통과
  if (!cfg && !hasToken) redirect("/admin");

  const params = await searchParams;
  const errKey = typeof params.error === "string" ? params.error : "";
  const error = errKey ? ERROR_MSG[errKey] ?? "로그인에 실패했습니다." : null;

  return (
    <div style={{ maxWidth: 360, margin: "80px auto", padding: "0 16px" }}>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>어드민 로그인</h1>
      <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 24 }}>
        저장소 쓰기 권한이 있는 GitHub 계정으로 로그인하세요.
      </p>

      {error && (
        <p style={{ color: "#e53e3e", fontSize: 13, marginBottom: 12 }}>
          {error}
        </p>
      )}

      {cfg ? (
        <a
          href="/api/admin/auth/github"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            width: "100%",
            padding: "11px",
            background: "#1a1a2e",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: "none",
            boxSizing: "border-box",
          }}
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          GitHub로 로그인
        </a>
      ) : (
        <p style={{ fontSize: 13, color: "#6b7280" }}>
          GitHub OAuth가 설정되지 않았습니다. 아래 토큰으로 로그인하세요.
        </p>
      )}

      {hasToken && (
        <details style={{ marginTop: 24 }}>
          <summary
            style={{ fontSize: 12, color: "#6b7280", cursor: "pointer" }}
          >
            토큰으로 로그인 (긴급)
          </summary>
          <form action="/api/admin/login" method="post" style={{ marginTop: 12 }}>
            <input
              type="password"
              name="token"
              placeholder="관리자 토큰"
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
                background: "#fff",
                color: "#1a1a2e",
                border: "1px solid #d1d5db",
                borderRadius: 6,
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              토큰 로그인
            </button>
          </form>
        </details>
      )}
    </div>
  );
}
