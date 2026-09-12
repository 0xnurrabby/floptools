import { NextRequest, NextResponse } from "next/server";
import { isProRequest } from "@/lib/pro-auth";
import { safeExec } from "@/lib/db";

/**
 * POST /api/sonnet/backfill — restore rows the venue's ring dropped before
 * capture (Pro only). Accepts parsed ballots and receipts captured from a
 * room snapshot and upserts them into the durable index. Public data only.
 */

interface BallotIn {
  seq?: number;
  ts?: string;
  did?: string;
  entryId?: string;
  requestId?: string;
}
interface ReceiptIn {
  requestId?: string;
  senderDid?: string;
  entryId?: string | null;
  reason?: string;
  intakeSeq?: number | null;
  receivedAt?: number | null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isProRequest(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  let body: { ballots?: BallotIn[]; receipts?: ReceiptIn[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new NextResponse(JSON.stringify({ ok: false, error: "bad json" }), { status: 400 });
  }
  const ballots = (body.ballots ?? []).slice(0, 500).filter((b) => b.requestId && b.did);
  const receipts = (body.receipts ?? []).slice(0, 500).filter((r) => r.requestId && r.senderDid);

  let inserted = 0;
  for (const b of ballots) {
    await safeExec(
      `INSERT INTO sonnet_ballots (seq, ts, did, entry_id, request_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [b.seq ?? 0, b.ts ?? "", b.did, b.entryId ?? null, b.requestId],
    );
    inserted++;
  }
  for (const r of receipts) {
    await safeExec(
      `INSERT INTO sonnet_ballot_receipts (request_id, sender_did, entry_id, reason, intake_seq, received_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (request_id, sender_did) DO UPDATE SET entry_id = EXCLUDED.entry_id, reason = EXCLUDED.reason,
         intake_seq = EXCLUDED.intake_seq, received_at = EXCLUDED.received_at`,
      [r.requestId, r.senderDid, r.entryId ?? null, r.reason ?? "", r.intakeSeq ?? null, r.receivedAt ?? null],
    );
    inserted++;
  }
  return NextResponse.json({ ok: true, inserted });
}
