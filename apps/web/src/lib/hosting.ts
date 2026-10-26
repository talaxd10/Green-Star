// Whether the API runs inside the office app: on Vercel (which sets VERCEL=1
// when it builds and runs the app), or wherever EMBED_API=1 says so.
export function apiEmbedded(): boolean {
  return process.env.VERCEL === "1" || process.env.EMBED_API === "1";
}
