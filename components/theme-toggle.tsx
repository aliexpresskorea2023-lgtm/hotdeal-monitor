"use client";

import { useEffect, useState } from "react";
import { MoonStar, SunMedium } from "lucide-react";

/*
 * 단일 테마 토글(사이드바 하단).
 * <html>의 .dark 클래스를 토글하고 localStorage에 저장 —
 * 첫 페인트 적용은 layout의 인라인 스크립트가 담당한다.
 */

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* 시크릿 모드 등 — 저장 실패는 무시 */
    }
  }

  return (
    <div className="theme-box">
      <span className="theme-label">
        {dark ? <MoonStar size={15} /> : <SunMedium size={15} />}
        {dark ? "다크 모드" : "라이트 모드"}
      </span>
      <button
        type="button"
        className="theme-switch"
        onClick={toggle}
        aria-label="테마 전환"
      />
    </div>
  );
}
