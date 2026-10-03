import type { NextConfig } from "next";

// The browser only ever talks to this app. Requests to /v1 are passed on to
// the API, so the session cookie belongs to the office app's own address and
// is never sent across sites.
const api = (process.env.API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");

const config: NextConfig = {
  // The end-to-end run builds into its own folder, so it never disturbs `next dev`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  transpilePackages: ["@green-star/contracts", "@green-star/domain"],
  poweredByHeader: false,
  // No generated notes for coding tools: this repo keeps its own.
  agentRules: false,
  devIndicators: false,
  async rewrites() {
    return [{ source: "/v1/:path*", destination: `${api}/v1/:path*` }];
  },
};

export default config;
