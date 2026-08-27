/*
 * 쿼리스트링 기반 필터/정렬 헬퍼.
 * 필터 상태는 URL에만 존재한다 — 서버 컴포넌트로 렌더하고
 * 클라이언트 JS를 쓰지 않는 구조라, 링크가 곧 상태 전이다.
 */

export function firstParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * 현재 쿼리를 유지한 채 한 축만 교체한 경로를 만든다.
 * 값이 null/빈문자면 그 축을 제거(= 기본값)한다.
 */
export function hrefFor(
  basePath: string,
  current: Record<string, string>,
  patch: Record<string, string | null>,
): string {
  const next = new URLSearchParams();

  for (const [key, value] of Object.entries({ ...current, ...patch })) {
    if (value) next.set(key, value);
  }

  const qs = next.toString();

  return qs ? `${basePath}?${qs}` : basePath;
}
