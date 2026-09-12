import { NextRequest, NextResponse } from "next/server";
import { isValidDid } from "@/lib/didkey";
import { mySonnetStatus, refreshRegistration } from "@/lib/sonnet";

/**
 * GET /api/sonnet/me?did=… — the connected identity's own sonnet-2 status:
 * registered role, the last public ballot it cast and the referee receipt for
 * it, plus that entry's current standing. All from the public ledger.
 */

export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const did = (req.nextUrl.searchParams.get("did") ?? "").trim();
  if (!isValidDid(did)) {
    return NextResponse.json({ ok: false, error: "invalid did:key" }, { status: 400 });
  }
  try {
    // ?refresh=1 forces a fresh registration-room read (a just-posted voter
    // registration must appear immediately, not on the room cache's cycle).
    if (req.nextUrl.searchParams.get("refresh") === "1") {
      await refreshRegistration();
    }
    const status = await mySonnetStatus(did);
    return NextResponse.json({ ok: true, ...status });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message.slice(0, 200) },
      { status: 502 },
    );
  }
}
