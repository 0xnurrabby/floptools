import { NextRequest, NextResponse } from "next/server";
import {
  OFFERS_ROOM,
  contractId,
  decodeFrame,
  type AcceptFrame,
  type OfferFrame,
  type RecordInput,
} from "@/lib/tclk-deal";
import { isValidDid } from "@/lib/didkey";

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

// The venue's offers room is a busy ring; a plain tail read only covers a few
// minutes of it. All lookup modes scan the full retained export, so cache the
// body briefly (per instance) to keep refreshes cheap.
let exportCache: { at: number; body: string } | null = null;

async function fetchExportBody(): Promise<string> {
  const now = Date.now();
  if (exportCache && now - exportCache.at < 20_000) return exportCache.body;
  let res: Response;
  try {
    res = await fetch(`${BASE}/r/${OFFERS_ROOM}/export`, {
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
      headers: { Accept: "text/plain;q=0.9, application/json;q=0.5" },
    });
  } catch {
    throw new ExportError("could not reach the offers ring");
  }
  if (!res.ok) {
    throw new ExportError(`upstream export failed (HTTP ${res.status})`);
  }
  const body = await res.text();
  exportCache = { at: now, body };
  return body;
}

class ExportError extends Error {}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const contract = req.nextUrl.searchParams.get("contract");
  const offerId = req.nextUrl.searchParams.get("offerId");
  const did = req.nextUrl.searchParams.get("did");
  const offersParam = req.nextUrl.searchParams.get("offers");
  if (!contract && !offerId && !did && offersParam !== "1") {
    return NextResponse.json({ error: "pass ?contract=, ?offerId=, ?did= or ?offers=1" }, { status: 400 });
  }
  if ((contract || offerId) && !HEX64.test(contract ?? offerId ?? "")) {
    return NextResponse.json({ error: "id must be 0x + 64 lowercase hex" }, { status: 400 });
  }
  if (did && !isValidDid(did)) {
    return NextResponse.json({ error: "did must be a valid did:key" }, { status: 400 });
  }

  let body: string;
  try {
    body = await fetchExportBody();
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "could not read the offers ring" }, { status: 502 });
  }

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

  if (offersParam === "1") {
    const acceptRefs = new Set<string>();
    for (const r of records) {
      const f = decodeFrame(r.text);
      if (f?.type === "accept") acceptRefs.add(f.ref);
    }
    const byId = new Map<string, { offer: OfferFrame; from: string; seq: number; ts: string }>();
    for (const r of records) {
      const f = decodeFrame(r.text);
      if (!f || f.type !== "offer") continue;
      const prev = byId.get(f.id);
      if (!prev || r.seq > prev.seq) byId.set(f.id, { offer: f, from: r.from, seq: r.seq, ts: r.ts });
    }
    const out = [...byId.values()]
      .map((x) => ({ ...x, accepted: acceptRefs.has(x.offer.id) }))
      .sort((a, b) => (a.ts === b.ts ? b.seq - a.seq : a.ts < b.ts ? 1 : -1));
    return NextResponse.json({ offers: out.slice(0, 100) });
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

  if (offerId) {
    let foundOffer: OfferFrame | null = null;
    for (const r of records) {
      const f = decodeFrame(r.text);
      if (f?.type === "offer" && f.id === offerId) {
        foundOffer = f;
        break;
      }
    }
    const acceptEntry = records
      .map((r) => ({ record: r, frame: decodeFrame(r.text) }))
      .find((x): x is { record: RecordInput; frame: AcceptFrame } => x.frame?.type === "accept" && x.frame.ref === offerId);
    if (acceptEntry) {
      return NextResponse.json({ found: true, offerPresent: true, accept: acceptEntry.frame, acceptRecord: acceptEntry.record });
    }
    return NextResponse.json({ found: false, offerPresent: foundOffer !== null, ...(foundOffer ? { offer: foundOffer } : {}) });
  }

  // ?did= — every deal this identity is a party to, straight off the board
  // (the browser's own localStorage may be empty on another profile/device).
  const offers: { record: RecordInput; frame: OfferFrame }[] = [];
  const accepts: { record: RecordInput; frame: AcceptFrame }[] = [];
  for (const r of records) {
    const frame = decodeFrame(r.text);
    if (!frame) continue;
    if (frame.type === "offer") offers.push({ record: r, frame });
    else if (frame.type === "accept") accepts.push({ record: r, frame });
  }
  const acceptsByRef = new Map<string, { record: RecordInput; frame: AcceptFrame }[]>();
  for (const a of accepts) {
    const list = acceptsByRef.get(a.frame.ref) ?? [];
    list.push(a);
    acceptsByRef.set(a.frame.ref, list);
  }

  const deals: Array<{
    role: "payer" | "payee";
    offer: OfferFrame;
    accept: AcceptFrame | null;
    contract: string | null;
    offerTs: string;
    acceptTs: string | null;
    pending: boolean;
  }> = [];
  const seen = new Set<string>();

  for (const o of offers) {
    if (o.frame.from !== did) continue;
    const candidates = acceptsByRef.get(o.frame.id) ?? [];
    if (candidates.length === 0) {
      deals.push({ role: o.frame.role, offer: o.frame, accept: null, contract: null, offerTs: o.record.ts, acceptTs: null, pending: true });
      continue;
    }
    for (const a of candidates) {
      const computed = await contractId(o.frame, {
        from: a.frame.from,
        ref: a.frame.ref,
        statement: a.frame.statement,
        paymentKey: a.frame.paymentKey,
        nonce: a.frame.nonce,
      });
      if (seen.has(computed)) continue;
      seen.add(computed);
      deals.push({ role: o.frame.role, offer: o.frame, accept: a.frame, contract: computed, offerTs: o.record.ts, acceptTs: a.record.ts, pending: false });
    }
  }
  for (const a of accepts) {
    if (a.frame.from !== did) continue;
    const offerEntry = offers.find((o) => o.frame.id === a.frame.ref);
    if (!offerEntry) continue;
    const computed = await contractId(offerEntry.frame, {
      from: a.frame.from,
      ref: a.frame.ref,
      statement: a.frame.statement,
      paymentKey: a.frame.paymentKey,
      nonce: a.frame.nonce,
    });
    if (seen.has(computed)) continue;
    seen.add(computed);
    deals.push({
      role: offerEntry.frame.role === "payer" ? "payee" : "payer",
      offer: offerEntry.frame,
      accept: a.frame,
      contract: computed,
      offerTs: offerEntry.record.ts,
      acceptTs: a.record.ts,
      pending: false,
    });
  }

  deals.sort((x, y) => (x.acceptTs ?? x.offerTs) < (y.acceptTs ?? y.offerTs) ? 1 : -1);
  return NextResponse.json({ found: true, deals });
}
