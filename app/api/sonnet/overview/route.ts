import { NextRequest, NextResponse } from "next/server";
import { ingestBoards, loadSonnetOverview, refreshWriters, sonnetOverviewCached } from "@/lib/sonnet";

/**
 * GET /api/sonnet/overview — the whole sonnet-2 board (teams, poems, votes).
 * Read-only public data; the aggregate is cached ~60s per instance and falls
 * back to the last good snapshot when the venue hiccups.
 */

export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  // ?writers=1 also awaits the registration index (declared X accounts) —
  // called once in the background by the vote page when handles are missing.
  const withWriters = req.nextUrl.searchParams.get("writers") === "1";
  const withBoards = req.nextUrl.searchParams.get("boards") === "1";
  try {
    if (withWriters) await refreshWriters();
    // ?boards=1 persists the votes/submissions/discovery rooms (heavy, run
    // once in the background on demand); after that every read is instant.
    if (withBoards) await ingestBoards({ fresh: true });
    const data = await loadSonnetOverview({ fresh: fresh || withWriters || withBoards });
    return NextResponse.json({ ok: true, ...data });
  } catch (e) {
    const cached = sonnetOverviewCached();
    if (cached) return NextResponse.json({ ok: true, stale: true, ...cached });
    return NextResponse.json(
      { ok: false, error: (e as Error).message.slice(0, 200) },
      { status: 502 },
    );
  }
}
