"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChartLine,
  Flame,
  Image,
  Layers,
  ScrollText,
  Shapes,
  SquarePen,
  TrendingUp,
  Trophy,
} from "lucide-react";
import { ThemeToggle } from "./theme-toggle";

/*
 * 좌측 사이드바 — 공개 메뉴 3개 + 어드민 메뉴.
 * 활성 메뉴는 usePathname으로 판단(클라이언트 컴포넌트).
 * 테마 토글은 여기 하나만 둔다(상단 중복 제거 — 2026-08-27 결정).
 *
 * 어드민 메뉴는 ADMIN_MODE=1 빌드(로컬)에서만 렌더된다.
 * 프로덕션 빌드에는 adminMode=false라 흔적이 남지 않는다.
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

export function Sidebar({ adminMode = false }: { adminMode?: boolean }) {
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

        {adminMode && (
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
        <ThemeToggle />
      </div>
    </aside>
  );
}
