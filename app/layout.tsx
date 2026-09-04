import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Sidebar } from "@/components/sidebar";
import { getAdminViewer } from "@/src/lib/admin-viewer";
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

/*
 * 첫 페인트 전 부트스트랩 — FOUC 방지.
 * 1) 저장된 테마(다크) 적용.
 * 2) ?embed=1이면 <html>에 embed 클래스 — 공개 페이지의 수정 모달이
 *    편집 페이지를 iframe으로 띄울 때 사이드바 등 chrome을 숨긴다.
 */
const bootstrapScript = `try{if(localStorage.getItem("theme")==="dark")document.documentElement.classList.add("dark");if(/[?&]embed=1(&|$)/.test(location.search))document.documentElement.classList.add("embed")}catch(e){}`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  /*
   * 로그인 주체 — GitHub 세션 쿠키 우선, break-glass admin_token 쿠키 폴백.
   * 사이드바가 미로그인(로그인 버튼) / 로그인(어드민 메뉴) 중 무엇을
   * 그릴지 결정한다. 모든 페이지가 force-dynamic이라 쿠키 읽기 비용은 무해.
   */
  const viewer = await getAdminViewer();

  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <script dangerouslySetInnerHTML={{ __html: bootstrapScript }} />
        <div className="shell">
          <Sidebar adminMode={viewer.enabled} adminUser={viewer.login} />
          <div className="main">{children}</div>
        </div>
      </body>
    </html>
  );
}
