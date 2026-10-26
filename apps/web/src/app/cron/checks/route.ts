// The deep check, once a day, from Vercel's daily timer (vercel.json). With
// CRON_SECRET set, only Vercel's timer, which sends it, can start it.

import { dailyChecks } from "@green-star/api/embedded";
import { apiEmbedded } from "@/lib/hosting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  if (!apiEmbedded()) return Response.json({ code: "not_found", message: "There is nothing at this address" }, { status: 404 });
  const secret = process.env.CRON_SECRET;
  if (secret !== undefined && secret !== "" && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ code: "not_signed_in", message: "Only the daily timer runs this" }, { status: 401 });
  }
  await dailyChecks();
  return Response.json({ ok: true });
}
