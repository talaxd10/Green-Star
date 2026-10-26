import type { NextConfig } from "next";

// The browser only ever talks to this app. Requests to /v1 are passed on to
// the API, so the session cookie belongs to the office app's own address and
// is never sent across sites.
const api = (process.env.API_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
// On Vercel the API runs inside this app (src/app/v1). See src/lib/hosting.ts.
const embedded = process.env.VERCEL === "1" || process.env.EMBED_API === "1";

const config: NextConfig = {
  // The end-to-end run builds into its own folder, so it never disturbs `next dev`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // NEXT_OUTPUT=standalone packs only what the server needs, the way a host does: used to check that the API inside the app has everything it loads.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
  transpilePackages: ["@green-star/contracts", "@green-star/domain", "@green-star/api", "@green-star/db"],
  // Loaded from node_modules as they are, not bundled.
  serverExternalPackages: ["fastify", "@fastify/cookie", "@fastify/cors", "pg", "playwright-core", "xlsx"],
  poweredByHeader: false,
  // No generated notes for coding tools: this repo keeps its own.
  agentRules: false,
  devIndicators: false,
  async rewrites() {
    // Before this app's own routes, so the API that runs on its own answers /v1, not src/app/v1.
    return { beforeFiles: embedded ? [] : [{ source: "/v1/:path*", destination: `${api}/v1/:path*` }], afterFiles: [], fallback: [] };
  },
};

export default config;
