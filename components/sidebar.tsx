"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChartLine,
  Flame,
  Image,
  Layers,
  LogIn,
  LogOut,
  ScrollText,
  Shapes,
  SquarePen,
  TrendingUp,
  Trophy,
} from "lucide-react";
import { ThemeToggle } from "./theme-toggle";

/*
 * 좌측 사이드바 — 공개 메뉴 + 어드민 영역.
 * 활성 메뉴는 usePathname으로 판단(클라이언트 컴포넌트).
 * 테마 토글은 여기 하나만 둔다(상단 중복 제거 — 2026-08-27 결정).
 *
 * 어드민 영역(2026-09-04 개편):
 *   - ADMIN_MODE=1이고 미로그인 → "어드민 로그인" 버튼만.
 *   - 로그인(adminUser) → 어드민 메뉴 + 핸들 + 로그아웃.
 * 프로덕션 빌드에서 ADMIN_MODE 미설정 시 어드민 흔적이 남지 않는다.
 */

const MENU = [
  { href: "/", label: "핫딜 모음", icon: Flame },
  { href: "/ranking", label: "핫딜 실시간 순위", icon: Trophy },
  { href: "/history", label: "최저가 히스토리", icon: ChartLine },
  { href: "/trends", label: "네이버 키워드 트렌드", icon: TrendingUp },
] as const;

const ADMIN_MENU = [
  { href: "/admin/deals", label: "핫딜 카드 관리", icon: SquarePen },
  { href: "/admin/thumbnails", label: "썸네일 관리", icon: Image },
  { href: "/admin/excluded", label: "제외/미분류 상품", icon: Shapes },
  { href: "/admin/taxonomy", label: "택소노미", icon: Layers },
  { href: "/admin/log", label: "로그", icon: ScrollText },
] as const;

export function Sidebar({
  adminMode = false,
  adminUser = null,
}: {
  adminMode?: boolean;
  adminUser?: string | null;
}) {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <Link className="brand" href="/">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="brand-logo" src="/sauron-eye.png" alt="사우론의 눈 로고" />
        <span className="brand-name">
          사우론의 눈
          <small>EYE OF SAURON</small>
        </span>
      </Link>

      <nav className="side-nav">
        {MENU.map(({ href, label, icon: Icon }) => {
          const active =
            href === "/" ? pathname === "/" : pathname.startsWith(href);

          return (
            <Link
              key={href}
              href={href}
              className={active ? "nav-item active" : "nav-item"}
            >
              <Icon size={17} />
              <span className="nav-label">{label}</span>
            </Link>
          );
        })}

        {adminMode && !adminUser && (
          <>
            <div className="nav-divider">어드민</div>
            <Link
              href="/admin/login"
              className={
                pathname.startsWith("/admin/login")
                  ? "nav-item active"
                  : "nav-item"
              }
            >
              <LogIn size={17} />
              <span className="nav-label">어드민 로그인</span>
            </Link>
          </>
        )}

        {adminMode && adminUser && (
          <>
            <div className="nav-divider">어드민</div>
            {ADMIN_MENU.map(({ href, label, icon: Icon }) => {
              const active = pathname.startsWith(href);

              return (
                <Link
                  key={href}
                  href={href}
                  className={active ? "nav-item active" : "nav-item"}
                >
                  <Icon size={17} />
                  <span className="nav-label">{label}</span>
                </Link>
              );
            })}
          </>
        )}
      </nav>

      <div className="side-foot">
        {adminMode && adminUser && (
          <div className="admin-user">
            <span className="admin-handle" title={adminUser}>
              {adminUser}
            </span>
            <form action="/api/admin/auth/logout" method="post">
              <button
                type="submit"
                className="admin-logout"
                title="로그아웃"
                aria-label="로그아웃"
              >
                <LogOut size={15} />
              </button>
            </form>
          </div>
        )}
        <ThemeToggle />
      </div>
    </aside>
  );
}
