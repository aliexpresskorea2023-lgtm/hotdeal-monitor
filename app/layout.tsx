import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { Sidebar } from "@/components/sidebar";
import { adminAuthConfigured } from "@/src/lib/admin-gate";
import { ADMIN_SESSION_COOKIE, verifySession } from "@/src/lib/admin-session";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "사우론의 눈",
    template: "%s · 사우론의 눈",
  },
  description:
    "커뮤니티 특가 통합 모니터 — 핫딜 모음·실시간 순위·최저가 히스토리.",
};

/* 첫 페인트 전에 저장된 테마를 적용 — 다크 모드 FOUC 방지. */
const themeScript = `try{if(localStorage.getItem("theme")==="dark")document.documentElement.classList.add("dark")}catch(e){}`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const adminMode = process.env.ADMIN_MODE === "1";

  /*
   * 로그인 주체 — GitHub 세션 쿠키 우선, break-glass admin_token 쿠키 폴백.
   * 사이드바가 미로그인(로그인 버튼) / 로그인(어드민 메뉴) 중 무엇을
   * 그릴지 결정한다. 모든 페이지가 force-dynamic이라 쿠키 읽기 비용은 무해.
   */
  let adminUser: string | null = null;
  if (adminMode && adminAuthConfigured()) {
    const store = await cookies();
    const sess = await verifySession(store.get(ADMIN_SESSION_COOKIE)?.value);
    if (sess) {
      adminUser = sess.login;
    } else {
      const token = process.env.ADMIN_TOKEN;
      if (token && store.get("admin_token")?.value === token) {
        adminUser = "토큰 로그인";
      }
    }
  }

  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <div className="shell">
          <Sidebar adminMode={adminMode} adminUser={adminUser} />
          <div className="main">{children}</div>
        </div>
      </body>
    </html>
  );
}
