import { NextRequest, NextResponse } from "next/server";
import { PROADMIN_COOKIE, verifySessionToken } from "@/lib/admin-auth";
import { proBypassByFeature, proOverview, proRecent, proTopIps } from "@/lib/pro-events";
import { geoForMany } from "@/lib/ip-geo";

/**
 * GET /api/proadmin/stats — PRO-panel data only (unlocks, failed attempts,
 * locks, limit-bypass usage). The app-wide stats stay on /api/admin/stats;
 * the two trackers never mix.
 */

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!verifySessionToken(req.cookies.get(PROADMIN_COOKIE)?.value, "proadmin")) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const [overview, recentRows, topIpsRows, byFeatureRows] = await Promise.all([
    proOverview(),
    proRecent(50),
    proTopIps(12),
    proBypassByFeature(),
  ]);

  const ips = [
    ...recentRows.map((r) => String(r["ip"] ?? "")),
    ...topIpsRows.map((r) => String(r["ip"] ?? "")),
  ];
  const geo = await geoForMany(ips);

  return NextResponse.json({
    ok: true,
    overview,
    byFeature: byFeatureRows.map((r) => ({
      feature: String(r["feature"] ?? "unknown"),
      n: Number(r["n"] ?? 0),
    })),
    recent: recentRows.map((r) => {
      const ip = String(r["ip"] ?? "");
      return {
        ip,
        kind: String(r["kind"] ?? ""),
        detail: (r["detail"] as string) ?? null,
        createdAt: r["created_at"] ? new Date(String(r["created_at"])).toISOString() : "",
        geo: geo.get(ip) ?? null,
      };
    }),
    topIps: topIpsRows.map((r) => {
      const ip = String(r["ip"] ?? "");
      return {
        ip,
        unlocks: Number(r["unlocks"] ?? 0),
        bypasses: Number(r["bypasses"] ?? 0),
        failures: Number(r["failures"] ?? 0),
        events: Number(r["events"] ?? 0),
        lastSeen: r["last_seen"] ? new Date(String(r["last_seen"])).toISOString() : "",
        geo: geo.get(ip) ?? null,
      };
    }),
  });
}
