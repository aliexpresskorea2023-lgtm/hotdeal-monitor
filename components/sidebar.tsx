"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartLine, Flame, Trophy } from "lucide-react";
import { ThemeToggle } from "./theme-toggle";

/*
 * 좌측 사이드바 — v1.0 IA의 3개 메뉴.
 * 활성 메뉴는 usePathname으로 판단(클라이언트 컴포넌트).
 * 테마 토글은 여기 하나만 둔다(상단 중복 제거 — 2026-08-27 결정).
 */

const MENU = [
  { href: "/", label: "핫딜 모음", icon: Flame },
  { href: "/ranking", label: "핫딜 실시간 순위", icon: Trophy },
  { href: "/history", label: "최저가 히스토리", icon: ChartLine },
] as const;

export function Sidebar() {
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
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="side-foot">
        <ThemeToggle />
      </div>
    </aside>
  );
}
