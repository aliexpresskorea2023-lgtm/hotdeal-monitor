import Link from "next/link";

/*
 * 상단 메뉴바. 메뉴는 두 개만 — 특가 모음 / 최저가 히스토리.
 * 서버 컴포넌트로 두고 활성 메뉴는 페이지가 prop으로 알려준다
 * (usePathname용 클라이언트 경계를 만들지 않기 위함).
 */

const MENU = [
  { key: "deals", href: "/", label: "핫딜 모음" },
  { key: "history", href: "/history", label: "최저가 히스토리" },
] as const;

export type MenuKey = (typeof MENU)[number]["key"];

export function SiteNav({
  active,
  statusText,
  live,
}: {
  active: MenuKey;
  statusText: string;
  live: boolean;
}) {
  return (
    <div className="nav-shell">
      <nav className="nav" aria-label="주요 메뉴">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            HD
          </span>
          <span className="brand-text">
            <strong>핫딜 모니터</strong>
          </span>
        </Link>

        <ul className="nav-menu">
          {MENU.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                className={item.key === active ? "nav-link active" : "nav-link"}
                aria-current={item.key === active ? "page" : undefined}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>

        <span className={live ? "nav-status" : "nav-status off"}>
          <span className="status-dot" aria-hidden="true" />
          {statusText}
        </span>
      </nav>
    </div>
  );
}
