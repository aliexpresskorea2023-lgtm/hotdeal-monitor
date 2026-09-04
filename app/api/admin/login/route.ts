import { NextResponse } from "next/server";
import { adminEnabled } from "@/src/lib/admin-gate";

/*
 * POST /api/admin/login — 토큰 검증 후 admin_token 쿠키 설정.
 * 성공 시 /admin으로, 실패 시 /admin/login?error=1로 리다이렉트.
 */

export async function POST(req: Request) {
  if (!adminEnabled()) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const token = process.env.ADMIN_TOKEN;

  // 토큰 미설정(로컬) — 인증 불필요, 바로 통과
  if (!token) {
    return NextResponse.redirect(new URL("/admin", req.url), { status: 302 });
  }

  const form = await req.formData();
  const submitted = form.get("token");

  if (submitted !== token) {
    return NextResponse.redirect(
      new URL("/admin/login?error=1", req.url),
      { status: 302 },
    );
  }

  const res = NextResponse.redirect(new URL("/admin", req.url), {
    status: 302,
  });

  // httpOnly 쿠키 — 30일 유효
  res.cookies.set("admin_token", token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  return res;
}
