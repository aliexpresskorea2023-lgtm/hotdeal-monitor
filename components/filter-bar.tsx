import Link from "next/link";
import {
  CATEGORIES,
  OTHER_STORE_FILTER,
  STORE_FILTER_LOGOS,
  STORE_FILTERS,
  type NormCategory,
} from "@/src/db/taxonomy";
import { hrefFor } from "@/src/lib/query";

/*
 * 필터 패널 — 세 줄로 역할을 분리했다.
 *   1줄: 상태(세그먼트) + 정렬(세그먼트)  … 목록의 성격을 정하는 축
 *   2줄: 카테고리 필                       … 무엇을 볼지
 *   3줄: 쇼핑몰 로고 칩                    … 어디서 파는지
 * 각 줄 왼쪽에 라벨을 달아, 알약 버튼이 뒤섞여 보이던 문제를 없앤다.
 */

type StatusValue = "all" | "active" | "ended";
type SortValue = "latest" | "hot" | "price";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "active", label: "진행중" },
  { value: "ended", label: "종료" },
];

const SORT_OPTIONS: { value: SortValue; label: string }[] = [
  { value: "latest", label: "최신순" },
  { value: "hot", label: "인기순" },
  { value: "price", label: "낮은가격순" },
];

export function FilterBar({
  current,
  category,
  store,
  status,
  sort,
}: {
  current: Record<string, string>;
  category: NormCategory | null;
  store: string | null;
  status: StatusValue;
  sort: SortValue;
}) {
  const href = (patch: Record<string, string | null>) =>
    hrefFor("/", current, patch);

  return (
    <section className="filters" aria-label="필터 및 정렬">
      <div className="filter-row filter-row-top">
        <div className="filter-group">
          <span className="filter-label">상태</span>

          <div className="segment">
            {STATUS_OPTIONS.map((option) => (
              <Link
                key={option.value}
                href={href({
                  status: option.value === "all" ? null : option.value,
                })}
                className={status === option.value ? "seg active" : "seg"}
                aria-current={status === option.value ? "true" : undefined}
              >
                {option.label}
              </Link>
            ))}
          </div>
        </div>

        <div className="filter-group">
          <span className="filter-label">정렬</span>

          <div className="segment">
            {SORT_OPTIONS.map((option) => (
              <Link
                key={option.value}
                href={href({
                  sort: option.value === "latest" ? null : option.value,
                })}
                className={sort === option.value ? "seg active" : "seg"}
                aria-current={sort === option.value ? "true" : undefined}
              >
                {option.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="filter-row">
        <span className="filter-label">분류</span>

        <div className="pill-scroll">
          <Link
            href={href({ cat: null })}
            className={category === null ? "pill active" : "pill"}
          >
            전체
          </Link>

          {CATEGORIES.map((cat) => (
            <Link
              key={cat}
              href={href({ cat })}
              className={category === cat ? "pill active" : "pill"}
            >
              {cat}
            </Link>
          ))}
        </div>
      </div>

      <div className="filter-row">
        <span className="filter-label">쇼핑몰</span>

        <div className="chip-scroll">
          <Link
            href={href({ store: null })}
            className={store === null ? "chip active" : "chip"}
            title="전체 쇼핑몰"
          >
            <img src={STORE_FILTER_LOGOS["전체"]} alt="전체 쇼핑몰" />
          </Link>

          {[...STORE_FILTERS, OTHER_STORE_FILTER].map((name) => (
            <Link
              key={name}
              href={href({ store: name })}
              className={store === name ? "chip active" : "chip"}
              title={name}
            >
              <img src={STORE_FILTER_LOGOS[name]} alt={name} />
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
