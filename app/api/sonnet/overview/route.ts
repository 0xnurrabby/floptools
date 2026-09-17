import { NextRequest, NextResponse } from "next/server";
import { lastDbError } from "@/lib/db";
import {
  ingestBoards,
  loadSonnetOverview,
  refreshWriters,
  sonnetOverviewFast,
  sonnetOverviewShell,
} from "@/lib/sonnet";

/**
 * GET /api/sonnet/overview — the whole sonnet-2 board (teams, poems, votes).
 * Read-only public data. Answered from the warm/persisted snapshot so the
 * response is instant: a stale snapshot refreshes in the background and
 * `building: true` says so. ?fresh=1 awaits a rebuild (explicit Refresh).
 * ?writers=1 / ?boards=1 only kick background work, they never block.
 */

export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  const withWriters = req.nextUrl.searchParams.get("writers") === "1";
  const withBoards = req.nextUrl.searchParams.get("boards") === "1";
  try {
    if (withWriters) void refreshWriters().catch(() => {});
    if (withBoards) void ingestBoards({ fresh: true }).catch(() => {});
    if (fresh) {
      const data = await loadSonnetOverview({ fresh: true });
      return NextResponse.json({ ok: true, building: false, dbError: lastDbError, ...data });
    }
    const { data, building } = await sonnetOverviewFast();
    return NextResponse.json({
      ok: true,
      building,
      dbError: lastDbError,
      ...(data ?? sonnetOverviewShell()),
    });
  } catch (e) {
    try {
      return NextResponse.json({
        ok: true,
        building: true,
        dbError: lastDbError,
        ...sonnetOverviewShell(),
      });
    } catch {
      return NextResponse.json(
        { ok: false, error: (e as Error).message.slice(0, 200) },
        { status: 502 },
      );
    }
  }
}
