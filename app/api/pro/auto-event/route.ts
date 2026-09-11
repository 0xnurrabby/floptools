import { NextRequest, NextResponse } from "next/server";
import { isProRequest } from "@/lib/pro-auth";
import { recordProEvent } from "@/lib/pro-events";
import { clientIp } from "@/lib/server-ip";

/**
 * POST /api/pro/auto-event — anonymous Pro auto-run telemetry.
 * Records a COUNT only (wallets, import vs generate); no DIDs, no wallets,
 * no activity data — the ledger is the only place wallet activity lives.
 */

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isProRequest(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  let wallets = 0;
  let imported = false;
  try {
    const body = (await req.json()) as { wallets?: unknown; imported?: unknown };
    wallets = Number(body?.wallets);
    imported = body?.imported === true;
  } catch {
    /* defaults */
  }
  if (!Number.isFinite(wallets) || wallets < 0) wallets = 0;
  wallets = Math.min(1000, Math.floor(wallets));
  await recordProEvent(clientIp(req.headers), "auto_run", `${wallets} wallets · ${imported ? "import" : "generate"}`);
  return NextResponse.json({ ok: true });
}
