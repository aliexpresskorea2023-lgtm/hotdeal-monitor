import {
  ALL_NORM_CATEGORIES,
  CATEGORIES,
  COMMUNITIES,
  COMMUNITY_LOGOS,
  OTHER_STORE_FILTER,
  STORE_ALIASES,
  STORE_FILTER_LOGOS,
  STORE_FILTERS,
} from "@/src/db/taxonomy";
import { sourceLabel } from "@/src/lib/format";

/*
 * 어드민 — 택소노미 (읽기 전용).
 *
 * 분류 체계는 코드(src/db/taxonomy.ts)가 단일 진실 소스다.
 * 여기서는 현재 적용 중인 카테고리·쇼핑몰·별칭·커뮤니티를
 * 조회만 할 수 있다. 수정은 코드 변경 후 배포로 반영된다.
 */

export const dynamic = "force-dynamic";

const CATEGORY_SET: ReadonlySet<string> = new Set(CATEGORIES);
const EXCLUDED_CATEGORIES = ALL_NORM_CATEGORIES.filter(
  (c) => !CATEGORY_SET.has(c),
);

export default function AdminTaxonomyPage() {
  /* 별칭 → 대표 표기 역색인 (표시 순서는 STORE_FILTERS 고정 순서). */
  const aliasGroups = new Map<string, string[]>();

  for (const [alias, canonical] of Object.entries(STORE_ALIASES)) {
    if (alias === canonical) continue;
    const list = aliasGroups.get(canonical) ?? [];
    list.push(alias);
    aliasGroups.set(canonical, list);
  }

  return (
    <div>
      <div className="admin-head">
        <h1>택소노미</h1>
        <span className="admin-count">
          읽기 전용 · 수정은 코드 변경 후 배포로 반영
        </span>
      </div>

      <div className="admin-card" style={{ marginBottom: 16 }}>
        <h2>노출 카테고리 ({CATEGORIES.length})</h2>
        <div className="abtn-row" style={{ marginTop: 0 }}>
          {CATEGORIES.map((c) => (
            <span key={c} className="badge live" style={{ fontSize: 12.5, padding: "4px 10px" }}>
              {c}
            </span>
          ))}
        </div>
        <div className="sub" style={{ marginTop: 12, fontSize: 12.5, color: "var(--muted-foreground)" }}>
          수집에서 제외되는 무형 카테고리 — 판정용 매핑만 유지:
          {" "}
          {EXCLUDED_CATEGORIES.map((c) => (
            <span key={c} className="badge danger" style={{ marginRight: 4 }}>
              {c}
            </span>
          ))}
        </div>
      </div>

      <div className="admin-card" style={{ marginBottom: 16 }}>
        <h2>쇼핑몰 필터 ({STORE_FILTERS.length} + {OTHER_STORE_FILTER})</h2>
        <table className="admin-table">
          <thead>
            <tr>
              <th />
              <th>쇼핑몰</th>
              <th>표기 별칭</th>
            </tr>
          </thead>
          <tbody>
            {[...STORE_FILTERS, OTHER_STORE_FILTER].map((store) => (
              <tr key={store}>
                <td className="thumb-cell">
                  {STORE_FILTER_LOGOS[store] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={STORE_FILTER_LOGOS[store]} alt="" />
                  ) : null}
                </td>
                <td style={{ fontWeight: 600 }}>{store}</td>
                <td style={{ color: "var(--muted-foreground)" }}>
                  {aliasGroups.get(store)?.join(", ") ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--muted-foreground)" }}>
          위 목록과 별칭에 없는 표기는 전부 “{OTHER_STORE_FILTER}”로 묶입니다.
        </div>
      </div>

      <div className="admin-card">
        <h2>커뮤니티 ({COMMUNITIES.length})</h2>
        <table className="admin-table">
          <thead>
            <tr>
              <th />
              <th>커뮤니티</th>
              <th>내부 ID</th>
            </tr>
          </thead>
          <tbody>
            {COMMUNITIES.map((c) => (
              <tr key={c}>
                <td className="thumb-cell">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={COMMUNITY_LOGOS[c]} alt="" />
                </td>
                <td style={{ fontWeight: 600 }}>{sourceLabel(c)}</td>
                <td style={{ color: "var(--muted-foreground)" }}>{c}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
