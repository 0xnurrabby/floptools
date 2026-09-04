import { NextRequest, NextResponse } from "next/server";
import { ingestNow, isStale } from "@/lib/trustcore-ingest";
import { safeQuery } from "@/lib/db";
import { buildDealStates, metricsFromStates, TIER_LABEL, type DealState } from "@/lib/trustscore";
import { frameFromRow } from "@/lib/trustcore-db";
import type { TclkFrame } from "@/lib/tclk";

/**
 * GET /api/trustcore/leaderboard?limit=25  — most trusted agents.
 * GET /api/trustcore/leaderboard?kind=activity&limit=30 — latest frames.
 *
 * Fast by design:
 *  - the result is cached in-instance for 30s;
 *  - the first-ever scan is kicked off asynchronously (page paints instantly
 *    and re-polls), so nothing waits on a cold DB;
 *  - computation is a single buildDealStates pass over all frames.
 */

const BOARD_TTL_MS = 30_000;
let boardCache: { at: number; board: unknown[] } | null = null;

async function allFrames(limit = 6000): Promise<TclkFrame[]> {
  const rows = (await safeQuery(
    `SELECT * FROM trustcore_frames ORDER BY created_at DESC LIMIT ${Math.min(limit, 12000)}`,
  )) ?? [];
  return rows.map(frameFromRow);
}

async function computeBoard(limit: number): Promise<unknown[]> {
  const frames = await allFrames();
  const { states } = buildDealStates(frames);
  // one pass: aggregate every agent over the same state list
  const totals = new Map<string, { completed: number; deals: number }>();
  const byDid = new Map<string, DealState[]>();
  for (const st of states) {
    if (!st.payer || !st.payee) continue;
    for (const [did, other] of [
      [st.payer, st.payee],
      [st.payee, st.payer],
    ] as const) {
      void other;
      const list = byDid.get(did) ?? [];
      list.push(st);
      byDid.set(did, list);
      const t = totals.get(did) ?? { completed: 0, deals: 0 };
      t.deals++;
      if (st.state === "claimed") t.completed++;
      totals.set(did, t);
    }
  }
  const agents: unknown[] = [];
  for (const [did, statesForDid] of byDid) {
    const m = metricsFromStates(did, statesForDid);
    agents.push({
      did,
      score: m.score,
      tier: m.tier,
      tierLabel: TIER_LABEL[m.tier],
      deals: m.deals,
      completed: m.completed,
      successRate: m.successRate,
      volumeClaimed: m.volumeClaimed,
      selfDealing: m.selfDealing,
    });
  }
  agents.sort(
    (a, b) =>
      (b as { score: number }).score - (a as { score: number }).score ||
      (b as { deals: number }).deals - (a as { deals: number }).deals,
  );
  return agents.slice(0, limit);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const kind = req.nextUrl.searchParams.get("kind") ?? "leaderboard";

  // Lightweight DB probe instead of a blocking scan.
  const realCounters = (
    (await safeQuery(
      `SELECT
         (SELECT COUNT(*) FROM trustcore_frames) AS frames,
         (SELECT COUNT(DISTINCT did) FROM trustcore_frames) AS agents,
         (SELECT COUNT(DISTINCT contract_id) FROM trustcore_frames WHERE contract_id IS NOT NULL) AS contracts`,
    )) ?? []
  )[0];
  const frameCount = Number(realCounters?.["frames"] ?? 0);
  const agentsCount = Number(realCounters?.["agents"] ?? 0);
  const contractsCount = Number(realCounters?.["contracts"] ?? 0);
  const stale = isStale();

  if (frameCount === 0 && stale) {
    // First visit: start scanning without blocking the response.
    void ingestNow();
  }

  if (kind === "activity") {
    const limit = Math.min(60, Number(req.nextUrl.searchParams.get("limit")) || 30);
    const frames = await allFrames(limit);
    return NextResponse.json({
      ok: true,
      scanning: frameCount === 0 && stale,
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
  const now = Date.now();
  if (!boardCache || now - boardCache.at > BOARD_TTL_MS) {
    if (frameCount === 0 && stale) {
      boardCache = { at: now, board: [] }; // avoid rebuild-spam while cold
    } else {
      // Await only when there is already data (warm DB — fast), else compute
      // from the (likely completed or in-flight) scan.
      const board = await computeBoard(limit);
      boardCache = { at: now, board };
    }
  }
  const boardRow = (boardCache?.board ?? []) as {
    did: string;
    score: number;
    tier: string;
    tierLabel: string;
    deals: number;
    completed: number;
    successRate: number | null;
    volumeClaimed: number;
    selfDealing: boolean;
  }[];

  return NextResponse.json({
    ok: true,
    scanning: frameCount === 0 && stale,
    counters: {
      frames: frameCount,
      agents: agentsCount,
      contracts: contractsCount,
    },
    board: boardRow,
  });
}