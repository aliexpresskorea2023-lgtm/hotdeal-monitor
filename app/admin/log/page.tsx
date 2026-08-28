/*
 * 어드민 — 로그 (플레이스홀더).
 *
 * 메뉴는 열어 두되 기능은 한국 VPS 이전 시점에 오픈한다.
 * 로컬 수동 수정 이력은 이미 admin_audit 테이블에 기록 중 —
 * 그 화면화는 수집기와 어드민이 같은 서버에서 돌 때 의미가 있다.
 */

export const dynamic = "force-dynamic";

export default function AdminLogPage() {
  return (
    <div>
      <div className="admin-head">
        <h1>로그</h1>
      </div>

      <div className="empty-note" style={{ marginTop: 12 }}>
        개발 중입니다 — 수집기·어드민의 한국 VPS 이전 시 오픈 예정.
        <br />
        로컬 수동 수정 이력은 그동안 admin_audit 테이블에 계속 기록됩니다.
      </div>
    </div>
  );
}
