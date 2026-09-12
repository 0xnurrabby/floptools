import { NextRequest, NextResponse } from "next/server";
import { contractFromDealRoom } from "@/lib/tclk";
import { rememberDealRoom } from "@/lib/trustcore-db";
import { safeExec, safeQuery } from "@/lib/db";
import { clientIp } from "@/lib/server-ip";

/**
 * POST /api/trustcore/rooms  {"room":"mb-p-tclk-<16 hex>"}
 *
 * Tells Trustcore that a deal room exists, so future ingests scan it. The
 * deal page calls this as soon as it folds a contract: a deal's
 * lock/reveal/receipt frames live in that room, and once the offer+accept
 * scrolls out of the tclk-offers tail the room is the only place they remain.
 *
 * Stores only the room NAME — never frames, never keys. The room itself is
 * public and read-only for us.
 */

export async function POST(req: NextRequest): Promise<NextResponse> {
  let room = "";
  try {
    const body = (await req.json()) as { room?: unknown };
    room = typeof body?.room === "string" ? body.room : "";
  } catch {
    room = "";
  }
  if (!room || contractFromDealRoom(room) === null) {
    return NextResponse.json(
      { ok: false, error: "room must be an mb-p-tclk-<16 hex> deal room" },
      { status: 400 },
    );
  }

  // Bounded per IP: the deal page calls this once per contract; a spammer
  // must not fill the table with junk names.
  const ip = clientIp(req.headers);
  const key = `tc:rooms:${ip}`;
  const rows = await safeQuery(
    "SELECT COUNT(*) AS n FROM task_events WHERE did = $1 AND created_at > now() - interval '10 minutes'",
    [key],
  );
  const used = Number(rows?.[0]?.["n"] ?? 0);
  if (used > 20) {
    return NextResponse.json({ ok: false, error: "Too many room reports. Try again soon." }, { status: 429 });
  }
  await safeExec("INSERT INTO task_events (did, category) VALUES ($1, 'rooms')", [key]);

  await rememberDealRoom(room);
  return NextResponse.json({ ok: true });
}
