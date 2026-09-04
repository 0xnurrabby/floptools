import { NextRequest, NextResponse } from "next/server";
import { safeExec, safeQuery } from "@/lib/db";
import { ingestNow } from "@/lib/trustcore-ingest";
import { clientIp } from "@/lib/server-ip";

/**
 * POST /api/trustcore/ingest — manual "scan now" (bounded per IP).
 * Reads are done by the same read-only path as the rest of the app;
 * nothing here stores secrets, only public signed frames.
 */

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = clientIp(req.headers);
  const key = `tc:ingest:${ip}`;
  const rows = await safeQuery(
    "SELECT COUNT(*) AS n FROM task_events WHERE did = $1 AND created_at > now() - interval '10 minutes'",
    [key],
  );
  const used = Number(rows?.[0]?.["n"] ?? 0);
  if (used > 5) {
    return NextResponse.json({ ok: false, error: "Too many scans. Try again soon." }, { status: 429 });
  }
  await safeExec("INSERT INTO task_events (did, category) VALUES ($1, 'ingest')", [key]);
  const res = await ingestNow();
  return NextResponse.json({ ok: res.ok, frames: res.frames, error: res.error });
}