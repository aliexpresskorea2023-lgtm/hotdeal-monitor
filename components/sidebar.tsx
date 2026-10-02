"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChartLine,
  Combine,
  Flame,
  Image,
  Layers,
  LogIn,
  LogOut,
  Menu,
  ScrollText,
  Shapes,
  SquarePen,
  TrendingUp,
  Trophy,
  X,
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
 *
 * 모바일(≤900px, 2026-10-02): 상단바에는 로고 + ☰ 버튼만 남기고
 * 메뉴·테마 토글은 오른쪽에서 밀려 들어오는 패널(.side-panel)로 연다.
 * PC에서는 .side-panel 이 display:contents 라 기존 레이아웃 그대로.
 */

const MENU = [
  { href: "/", label: "핫딜 모음", icon: Flame },
  { href: "/ranking", label: "핫딜 실시간 순위", icon: Trophy },
  { href: "/history", label: "최저가 히스토리", icon: ChartLine },
  { href: "/trends", label: "네이버 키워드 트렌드", icon: TrendingUp },
] as const;

const ADMIN_MENU = [
  { href: "/admin/deals", label: "핫딜 카드 관리", icon: SquarePen },
  { href: "/admin/merge", label: "카드 병합 관리", icon: Combine },
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
  const [open, setOpen] = useState(false);

  // 페이지를 이동하면 패널을 닫는다.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // 열려 있는 동안 뒤 화면 스크롤 잠금 + Esc 로 닫기.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

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

      <button
        type="button"
        className="menu-btn"
        aria-label="메뉴 열기"
        aria-expanded={open}
        aria-controls="side-panel"
        onClick={() => setOpen(true)}
      >
        <Menu size={22} />
      </button>

      <div
        className={open ? "side-backdrop open" : "side-backdrop"}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      <div id="side-panel" className={open ? "side-panel open" : "side-panel"}>
        <div className="side-panel-head">
          <span className="side-panel-title">메뉴</span>
          <button
            type="button"
            className="menu-close"
            aria-label="메뉴 닫기"
            onClick={() => setOpen(false)}
          >
            <X size={20} />
          </button>
        </div>

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
      </div>
    </aside>
  );
}
