import { NextRequest, NextResponse } from "next/server";
import { safeExec } from "@/lib/db";
import { clientIp } from "@/lib/server-ip";
import { isValidDid } from "@/lib/didkey";

/**
 * POST /api/track — anonymous usage events for the admin dashboard.
 * Kinds:
 *   pageview    — client fires at most once per 30 min per path
 *   did_created — fired after a successful create or import; carries the
 *                 PUBLIC did:key only (never a private key), deduped in SQL
 *
 * Domain-independent; safe to call from any deployment URL.
 */

const KINDS = new Set(["pageview", "did_created"]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { kind?: string; path?: string; did?: string; detail?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  if (!body.kind || !KINDS.has(body.kind)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const ip = clientIp(req.headers);
  if (body.kind === "pageview") {
    const path = typeof body.path === "string" ? body.path.slice(0, 200) : "/";
    await safeExec("INSERT INTO pageviews (ip, path) VALUES ($1, $2)", [ip, path]);
  } else if (body.kind === "did_created") {
    const did = typeof body.did === "string" && isValidDid(body.did) ? body.did : "";
    if (!did) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    const detail = typeof body.detail === "string" ? body.detail.slice(0, 80) : "import";
    // Imports and restores are unlimited: record the DID anonymously (no IP
    // attribution), so they never count toward the per-IP creation cap.
    await safeExec("INSERT INTO dids (did, ip) VALUES ($1, NULL) ON CONFLICT (did) DO NOTHING", [did]);
    await safeExec("INSERT INTO pageviews (ip, path) VALUES ($1, $2)", [ip, `did:${detail}`]);
  }
  return NextResponse.json({ ok: true });
}