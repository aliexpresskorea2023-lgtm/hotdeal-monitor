import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  /*
   * Vercel serverless 번들에 DB를 포함시킨다.
   * 런타임에 process.cwd()/data/hotdeal.db를 node:sqlite로 읽는다.
   */
  outputFileTracingIncludes: {
    "/*": ["./data/hotdeal.db"],
  },
};

export default nextConfig;
