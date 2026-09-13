import { NextRequest, NextResponse } from "next/server";
import { ingestBoards, refreshWriters, sonnetOverviewFast, sonnetOverviewShell } from "@/lib/sonnet";

/**
 * GET /api/sonnet/overview — the whole sonnet-2 board (teams, poems, votes).
 * Read-only public data. Always answered from the warm/persisted snapshot so
 * the response is instant: a stale snapshot refreshes in the background and
 * `building: true` says so. ?writers=1 / ?boards=1 only kick background work,
 * they never block the response.
 */

export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const withWriters = req.nextUrl.searchParams.get("writers") === "1";
  const withBoards = req.nextUrl.searchParams.get("boards") === "1";
  try {
    if (withWriters) void refreshWriters().catch(() => {});
    if (withBoards) void ingestBoards({ fresh: true }).catch(() => {});
    const { data, building } = await sonnetOverviewFast();
    return NextResponse.json({ ok: true, building, ...(data ?? sonnetOverviewShell()) });
  } catch (e) {
    try {
      return NextResponse.json({ ok: true, building: true, ...sonnetOverviewShell() });
    } catch {
      return NextResponse.json(
        { ok: false, error: (e as Error).message.slice(0, 200) },
        { status: 502 },
      );
    }
  }
}
