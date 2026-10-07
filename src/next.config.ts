import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Ship the pre-seeded Zoko catalog (SQLite) inside the server bundle.
  // On Vercel, src/lib/db.ts copies it to /tmp at boot so reads AND writes work.
  outputFileTracingIncludes: {
    "/api/**/*": ["./db/custom.db"],
  },
};

export default nextConfig;
