import { NextRequest, NextResponse } from "next/server";
import { ingestNow, isStale } from "@/lib/trustcore-ingest";
import { safeQuery } from "@/lib/db";
import { framesForDid } from "@/lib/trustcore-db";
import { computeAgentMetrics, NEUTRAL_SCORE, TIER_LABEL } from "@/lib/trustscore";
import { buildDealStates } from "@/lib/trustscore";
import { isValidDid, publicKeyFromDid } from "@/lib/didkey";

async function safeQueryFrameCount(): Promise<number> {
  const rows = (await safeQuery("SELECT COUNT(*) AS n FROM trustcore_frames")) ?? [];
  return Number(rows[0]?.["n"] ?? 0);
}

/**
 * GET /api/trustcore/agent?did=did:key:z6Mk…
 * Public: any did:key, live Trustcore profile (score, metrics, recent deals).
 * Left from a different process? None: read-only over public data + our DB.
 */

export async function GET(req: NextRequest): Promise<NextResponse> {
  const did = req.nextUrl.searchParams.get("did") ?? "";
  if (!isValidDid(did)) {
    return NextResponse.json({ ok: false, error: "invalid did:key" }, { status: 400 });
  }

  // Fast paint: never block on a cold scan; kick it off and report scanning.
  const counters = (await safeQueryFrameCount()) ?? 0;
  const scanning = counters === 0 && isStale();
  if (scanning) void ingestNow();

  const frames = await framesForDid(did);
  const metrics = computeAgentMetrics(did, frames);

  // recent deals for this did, for the profile timeline
  const { states } = buildDealStates(frames);
  const deals = states
    .filter((s) => s.payer === did || s.payee === did)
    .slice(0, 25)
    .map((s) => ({
      contractId: s.contractId,
      state: s.state,
      payer: s.payer ?? null,
      payee: s.payee ?? null,
      amount: s.amount ?? null,
      asset: s.asset ?? null,
      lockedAt: s.lockedAtMs ? new Date(s.lockedAtMs).toISOString() : null,
      revealedAt: s.revealedAtMs ? new Date(s.revealedAtMs).toISOString() : null,
      lastFrameAt: s.frames[s.frames.length - 1]?.ts ?? null,
      frames: s.frames.length,
    }));

  return NextResponse.json({
    ok: true,
    did,
    score: frames.length === 0 ? NEUTRAL_SCORE : metrics.score,
    tier: frames.length === 0 ? "unknown" : metrics.tier,
    tierLabel: TIER_LABEL[frames.length === 0 ? "unknown" : metrics.tier],
    metrics,
    deals,
    frames: frames
      .slice(0, 20)
      .map((f) => ({
        type: f.type,
        ts: f.ts,
        room: f.room,
        seq: f.seq,
        amount: f.amount ?? null,
        asset: f.asset ?? null,
      })),
    scanning,
    scanned: { error: null },
    ledgerCheck: { validDid: true, pubKeyBytes: publicKeyFromDid(did).length },
  });
}