import { NextRequest, NextResponse } from "next/server";
import { ingestIfStale } from "@/lib/trustcore-ingest";
import { framesForDid, knownDids, latestFrames, counterStats } from "@/lib/trustcore-db";
import { computeAgentMetrics, TIER_LABEL } from "@/lib/trustscore";

/**
 * GET /api/trustcore/leaderboard?limit=25  — most trusted agents, live.
 * GET /api/trustcore/activity?limit=30     — latest board frames.
 * Both public, read-only, opportunistic-scan.
 */

export async function GET(req: NextRequest): Promise<NextResponse> {
  const kind = req.nextUrl.searchParams.get("kind") ?? "leaderboard";

  const ingested = await ingestIfStale();

  if (kind === "activity") {
    const limit = Math.min(60, Number(req.nextUrl.searchParams.get("limit")) || 30);
    const frames = await latestFrames(limit);
    return NextResponse.json({
      ok: true,
      scanned: { cached: ingested.cached, error: ingested.error ?? null },
      frames: frames.map((f) => ({
        type: f.type,
        did: f.did,
        room: f.room,
        ts: f.ts,
        seq: f.seq,
        asset: f.asset ?? null,
        amount: f.amount ?? null,
        contractId: f.contractId ?? null,
        outcome: f.outcome ?? null,
      })),
    });
  }

  const limit = Math.min(50, Number(req.nextUrl.searchParams.get("limit")) || 25);
  const dids = await knownDids();
  const results = [];
  // bounded parallelism, each agent's own frames → own state machine
  const CHUNK = 5;
  for (let i = 0; i < dids.length; i += CHUNK) {
    const batch = dids.slice(i, i + CHUNK);
    const computed = await Promise.all(
      batch.map(async (did) => {
        const frames = await framesForDid(did);
        const m = computeAgentMetrics(did, frames);
        return {
          did,
          score: m.score,
          tier: m.tier,
          tierLabel: TIER_LABEL[m.tier],
          deals: m.deals,
          completed: m.completed,
          successRate: m.successRate,
          volumeClaimed: m.volumeClaimed,
          selfDealing: m.selfDealing,
        };
      }),
    );
    results.push(...computed);
  }

  const board = results
    .filter((r) => r.deals > 0)
    .sort((a, b) => b.score - a.score || b.deals - a.deals)
    .slice(0, limit);

  const counters = await counterStats();
  return NextResponse.json({
    ok: true,
    scanned: { cached: ingested.cached, error: ingested.error ?? null },
    counters,
    board,
  });
}