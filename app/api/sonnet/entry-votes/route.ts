import { NextRequest, NextResponse } from "next/server";
import { entryVoterReport } from "@/lib/sonnet";

/**
 * GET /api/sonnet/entry-votes?entryId=… — who voted for an entry, with a
 * transparent clustering analysis over public registration and ballot timing
 * (tight vote bursts, shared request-id tags, batch registrations, rushed
 * onboarding). Heuristics to inspect, never proof.
 */

export const maxDuration = 60;

const ENTRY_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const entryId = (req.nextUrl.searchParams.get("entryId") ?? "").trim().toLowerCase();
  if (!ENTRY_RE.test(entryId)) {
    return NextResponse.json({ ok: false, error: "entryId must be a game id" }, { status: 400 });
  }
  try {
    const report = await entryVoterReport(entryId);
    return NextResponse.json({ ok: true, ...report });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message.slice(0, 200) },
      { status: 502 },
    );
  }
}
