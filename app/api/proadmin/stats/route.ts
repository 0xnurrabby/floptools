import { NextRequest, NextResponse } from "next/server";
import { GET as adminStatsGET } from "../../admin/stats/route";
import { PROADMIN_COOKIE, verifySessionToken } from "@/lib/admin-auth";

/**
 * GET /api/proadmin/stats — same dashboard data as /api/admin/stats, gated by
 * the pro admin cookie. The admin stats endpoint also accepts this cookie, so
 * whichever panel you signed into works.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!verifySessionToken(req.cookies.get(PROADMIN_COOKIE)?.value, "proadmin")) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return adminStatsGET(req);
}
