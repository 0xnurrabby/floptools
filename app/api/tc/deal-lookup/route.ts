import { NextRequest, NextResponse } from "next/server";
import {
  OFFERS_ROOM,
  contractId,
  decodeFrame,
  type AcceptFrame,
  type OfferFrame,
  type RecordInput,
} from "@/lib/tclk-deal";

/**
 * Locate a tclk/1 offer+accept pair on the public board by contract id (or
 * find an accept by its offer id), without shipping the whole offers ring to
 * the browser.
 *
 * Why this exists: `tclk-offers` is world-writable and busy — a plain room
 * read returns only the tail (~200 latest messages), and the venue keeps only
 * the newest ~10 MiB of the room as a ring. A deal page must therefore match
 * records by recomputing the contract id, never by "the first offer in the
 * tail". The venue's own `GET /r/<room>/export` returns the whole retained
 * ring as JSONL; we scan it server-side (the ring is ~9 MB, too big for a
 * browser response) and return only the matched pair.
 *
 * Security posture: GET only, strictly validated 64-hex input, no secrets
 * involved, marked no-store. This route reads public frames — it never signs.
 */

const BASE = (
  process.env.TECHNOCORE_BASE_URL ??
  process.env.NEXT_PUBLIC_TECHNOCORE_BASE_URL ??
  "https://technocore.chat"
).replace(/\/+$/, "");

const HEX64 = /^0x[0-9a-f]{64}$/;

// The retained ring export is several MB and the venue is occasionally slow;
// give the function room to fetch and scan it once.
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const contract = req.nextUrl.searchParams.get("contract");
  const offerId = req.nextUrl.searchParams.get("offerId");
  if (!contract && !offerId) {
    return NextResponse.json({ error: "pass ?contract= or ?offerId= (0x + 64 hex)" }, { status: 400 });
  }
  const target = contract ?? offerId;
  if (!target || !HEX64.test(target)) {
    return NextResponse.json({ error: "id must be 0x + 64 lowercase hex" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}/r/${OFFERS_ROOM}/export`, {
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
      headers: { Accept: "text/plain;q=0.9, application/json;q=0.5" },
    });
  } catch {
    return NextResponse.json({ error: "could not reach the offers ring" }, { status: 502 });
  }
  if (!res.ok) {
    return NextResponse.json({ error: `upstream export failed (HTTP ${res.status})` }, { status: 502 });
  }

  const body = await res.text();
  const records: RecordInput[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as { seq?: number; ts?: string; from?: string; text?: string; sig?: string };
      if (typeof m?.text !== "string") continue;
      records.push({
        room: OFFERS_ROOM,
        from: typeof m.from === "string" ? m.from : "",
        text: m.text,
        seq: typeof m.seq === "number" ? m.seq : 0,
        ts: typeof m.ts === "string" ? m.ts : "",
        ...(typeof m.sig === "string" ? { sig: m.sig } : {}),
      });
    } catch {
      /* skip malformed line */
    }
  }

  if (contract) {
    const offers: { record: RecordInput; frame: OfferFrame }[] = [];
    const acceptsByRef = new Map<string, { record: RecordInput; frame: AcceptFrame }[]>();
    for (const r of records) {
      const frame = decodeFrame(r.text);
      if (!frame) continue;
      if (frame.type === "offer") offers.push({ record: r, frame });
      else if (frame.type === "accept") {
        const list = acceptsByRef.get(frame.ref) ?? [];
        list.push({ record: r, frame });
        acceptsByRef.set(frame.ref, list);
      }
    }
    for (const o of offers) {
      for (const a of acceptsByRef.get(o.frame.id) ?? []) {
        const computed = await contractId(o.frame, {
          from: a.frame.from,
          ref: a.frame.ref,
          statement: a.frame.statement,
          paymentKey: a.frame.paymentKey,
          nonce: a.frame.nonce,
        });
        if (computed.toLowerCase() === contract.toLowerCase()) {
          return NextResponse.json({ found: true, offer: o.frame, offerRecord: o.record, accept: a.frame, acceptRecord: a.record });
        }
      }
    }
    return NextResponse.json({ found: false });
  }

  const acceptEntry = records
    .map((r) => ({ record: r, frame: decodeFrame(r.text) }))
    .find((x): x is { record: RecordInput; frame: AcceptFrame } => x.frame?.type === "accept" && x.frame.ref === offerId);
  if (acceptEntry) {
    return NextResponse.json({ found: true, accept: acceptEntry.frame, acceptRecord: acceptEntry.record });
  }
  return NextResponse.json({ found: false });
}
