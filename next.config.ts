import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  /*
   * D1 백엔드 일시 정지(2026-09-04): Cloudflare D1 무료 티어 일일
   * row-read 한도(5M) 소진으로 공개 페이지가 500을 반환. 한도 리셋
   * (UTC 자정 = 09:00 KST)까지 번들 SQLite로 읽기 폴백한다.
   *
   * DB_BACKEND가 미설정/sqlite일 때 런타임에 process.cwd()/data/hotdeal.db를
   * node:sqlite(read-only)로 읽는다. 서버리스 번들에 DB 파일을 포함시키려면
   * outputFileTracingIncludes가 반드시 필요하다(.vercelignore는 이 파일을
   * 업로드 대상에 남겨둔다).
   *
   * 주의: 서버리스 fs는 읽기 전용이라 이 모드에서는 어드민 쓰기/실시간
   * 동기화가 동작하지 않는다. D1 한도 리셋 후 DB_BACKEND=d1로 되돌린다.
   */
  outputFileTracingIncludes: {
    "/*": ["./data/hotdeal.db"],
  },
};

export default nextConfig;
