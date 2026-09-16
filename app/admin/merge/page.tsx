import { getCachedMergeIndex } from "@/src/db/admin-cached";
import { firstParam } from "@/src/lib/query";
import { MergeBoard } from "@/components/admin/merge-board";

/*
 * 어드민 — 카드 병합 관리 (2단계, 2026-09-16).
 *
 * 같은 상품인데 구매링크가 없거나 달라서 카드가 갈라진 경우를 찾아
 * 수동으로 묶는다. 묶으면 deals.product_key_override가 대표 키로
 * 통일되어 공개 피드와 최저가 히스토리가 한 카드로 합쳐진다.
 *
 * 두 탭 구성 — "자동 추천"(상품번호 일치 후보 + 수동 그룹/찢기)과
 * "수동 병합"(상품명 검색 → 카드 → 모달에서 임의 카드 조합). 탭과
 * 검색어는 ?tab=·?q=로 보존해 히스토리 등에서 딥링크할 수 있다.
 * 서버는 인덱스(후보·그룹)만 읽고, 선택/병합/해제/라이브 검색은
 * MergeBoard(클라이언트)가 POST /api/admin/merge 로 담당한다.
 */

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminMergePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const query = (firstParam(sp.q) ?? "").trim();
  const rawTab = firstParam(sp.tab);
  const initialTab = rawTab === "manual" ? "manual" : "recommend";

  const index = await getCachedMergeIndex();
  const manualCount = index.groups.filter((g) => g.manual).length;

  return (
    <div>
      <div className="admin-head">
        <h1>카드 병합 관리</h1>
        <span className="admin-count">
          후보 {index.candidates.length} · 수동 그룹 {manualCount}
        </span>
      </div>

      <MergeBoard
        candidates={index.candidates}
        groups={index.groups}
        scanned={index.scanned}
        initialTab={initialTab}
        initialQuery={query}
      />
    </div>
  );
}
