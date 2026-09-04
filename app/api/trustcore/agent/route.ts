import { NextRequest, NextResponse } from "next/server";
import { ingestIfStale } from "@/lib/trustcore-ingest";
import { framesForDid } from "@/lib/trustcore-db";
import { computeAgentMetrics, NEUTRAL_SCORE, TIER_LABEL } from "@/lib/trustscore";
import { buildDealStates } from "@/lib/trustscore";
import { isValidDid, publicKeyFromDid } from "@/lib/didkey";

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

  const ingested = await ingestIfStale();
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
    scanned: { cached: ingested.cached, error: ingested.error ?? null },
    ledgerCheck: { validDid: true, pubKeyBytes: publicKeyFromDid(did).length },
  });
}