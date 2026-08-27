import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
  title: "핫딜 모니터 · 커뮤니티 특가 통합",
  description:
    "펨코·뽐뿌·루리웹·퀘이사존·아카라이브의 특가 글을 상품 단위로 합쳐 보여주고, 가격 관측 시계열로 최저가 히스토리를 추적합니다.",
};

export const viewport = {
  themeColor: "#eff3f9",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
