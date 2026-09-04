import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  /*
   * D1 컷오버(2026-09-03) 이후 DB 파일 번들링 불필요.
   * 프로덕션은 Cloudflare D1 REST API로 접근하고,
   * 로컬 개발은 DB_BACKEND 미설정 시 data/hotdeal.db를 읽는다.
   */
};

export default nextConfig;
