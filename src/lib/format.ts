/*
 * 표시 전용 포맷터 모음.
 * 특가 모음 / 최저가 히스토리 두 화면이 같은 규칙으로 숫자·시간·
 * 커뮤니티 이름을 표기하도록 한곳에 모았다.
 */

export function formatNumber(value: number | null): string {
  if (value === null) return "-";

  return new Intl.NumberFormat("ko-KR").format(value);
}

/** 원화는 보조 단위가 없다 — 표기 단계에서 정수로 떨어뜨린다. */
function formatKrw(value: number): string {
  return formatNumber(Math.round(value));
}

export function formatTime(dateString: string): string {
  return new Date(dateString).toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeAgo(dateString: string): string {
  const diffMs = Date.now() - new Date(dateString).getTime();
  const minutes = Math.floor(diffMs / 60_000);

  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;

  return `${Math.floor(hours / 24)}일 전`;
}

const COMMUNITY_LABELS: Record<string, string> = {
  fmkorea: "펨코",
  ppomppu: "뽐뿌",
  arca: "아카라이브",
  quasarzone: "퀘이사존",
  mlbpark: "MLB파크",
  theqoo: "더쿠",
  slrclub: "SLR클럽",
  ruliweb: "루리웹",
};

export function sourceLabel(source: string): string {
  return COMMUNITY_LABELS[source] ?? source;
}

/** 임시 정책: 상태 모름은 진행중으로 노출. 종료 확인 건만 종료. */
export function statusLabel(status: string): string {
  return status === "ended" ? "종료" : "진행중";
}

/**
 * 가격 표기. 원문 통화를 그대로 살린다 —
 * 원화 환산은 정렬 전용이고 화면에는 노출하지 않는다.
 */
export function formatPrice(
  price: number | null,
  currency: string,
  priceText: string,
): string {
  if (price === null) return "가격 확인 필요";

  if (currency === "USD") return `$${price.toFixed(2)}`;
  if (currency === "KRW") return `${formatKrw(price)}원`;

  return priceText;
}
