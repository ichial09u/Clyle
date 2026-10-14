import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // WCO (South Park's source) hotlink-filters its video CDN by Referer:
  // any request carrying a foreign origin (e.g. ours) gets 404 while the
  // same URL with no referer streams fine (verified 2026-10-09). The
  // browser's default strict-origin-when-cross-origin policy leaks our
  // origin on <video> requests, which left the dub player empty. Sending
  // no referer at all fixes every browser; the <video> element also carries
  // referrerPolicy="no-referrer" as belt-and-braces.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Ship the pre-seeded Zoko catalog (SQLite) inside the server bundle.
  // On Vercel, src/lib/db.ts copies it to /tmp at boot so reads AND writes work.
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./db/custom.db",
      // Prisma query engine + generated client are not always traced
      // into the standalone output — without them every API query 500s.
      "./node_modules/.prisma/**/*",
      "./node_modules/@prisma/**/*",
    ],
  },
};

export default nextConfig;
