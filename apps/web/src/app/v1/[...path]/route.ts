// The API, inside the office app, where the host runs no server of its own
// (Vercel). Anywhere else the API runs on its own and next.config.ts sends
// /v1 to it before this route is ever reached.

import { handle } from "@green-star/api/embedded";
import { apiEmbedded } from "@/lib/hosting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function serve(request: Request): Promise<Response> {
  if (!apiEmbedded()) return Response.json({ code: "not_found", message: "There is nothing at this address" }, { status: 404 });
  return handle(request);
}

export const GET = serve;
export const POST = serve;
export const PUT = serve;
export const PATCH = serve;
export const DELETE = serve;
export const OPTIONS = serve;
