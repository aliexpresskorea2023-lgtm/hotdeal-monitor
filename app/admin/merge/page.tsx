import { Search } from "lucide-react";
import { getCachedMergeIndex, getCachedMergeSearch } from "@/src/db/admin-cached";
import { firstParam } from "@/src/lib/query";
import { MergeBoard } from "@/components/admin/merge-board";

/*
 * 어드민 — 카드 병합 관리 (2단계, 2026-09-16).
 *
 * 같은 상품인데 구매링크가 없거나 달라서 카드가 갈라진 경우를 찾아
 * 수동으로 묶는다. 묶으면 deals.product_key_override가 대표 키로
 * 통일되어 공개 피드와 최저가 히스토리가 한 카드로 합쳐진다.
 *
 * 서버가 후보·그룹·검색 결과를 읽고, MergeBoard(클라이언트)가
 * 선택/병합/해제를 담당한다. 쓰기는 POST /api/admin/merge.
 */

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminMergePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const query = (firstParam(sp.q) ?? "").trim();

  const index = await getCachedMergeIndex();
  const manualGroups = index.groups.filter((g) => g.manual);
  const autoGroupCount = index.groups.length - manualGroups.length;

  const searchResults = query.length > 0 ? await getCachedMergeSearch(query) : null;

  return (
    <div>
      <div className="admin-head">
        <h1>카드 병합 관리</h1>
        <span className="admin-count">
          후보 {index.candidates.length} · 수동 그룹 {manualGroups.length}
        </span>
      </div>

      <div className="toolbar">
        <form className="searchbar" action="/admin/merge" method="get" role="search">
          <Search size={15} />
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="상품명·게시글 제목으로 병합할 카드 검색"
            aria-label="검색"
          />
          <button type="submit">검색</button>
        </form>
      </div>

      <MergeBoard
        candidates={index.candidates}
        manualGroups={manualGroups}
        autoGroupCount={autoGroupCount}
        searchResults={searchResults}
        query={query}
        scanned={index.scanned}
      />
    </div>
  );
}
