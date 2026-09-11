/**
 * Shared server-side reader for the public tclk-offers ring.
 *
 * The venue keeps `tclk-offers` as a rolling ring of only the newest ~10 MiB,
 * and a plain room read returns just the tail (the newest ~200 messages —
 * minutes of activity). `GET /r/tclk-offers/export` returns the whole retained
 * ring as JSONL, which is the only way to see deals older than the tail. The
 * export is several MB, so it is cached briefly per instance.
 *
 * Used by /api/tc/deal-lookup and the Trustcore ingest. Reads only; nothing
 * here signs or stores secrets.
 */

import type { RecordInput } from "./tclk-deal";

export const OFFERS_ROOM = "tclk-offers";

const TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;

let exportCache: { at: number; body: string } | null = null;
let inflight: Promise<string> | null = null;

const BASE = (
  process.env.TECHNOCORE_BASE_URL ??
  process.env.NEXT_PUBLIC_TECHNOCORE_BASE_URL ??
  "https://technocore.chat"
).replace(/\/+$/, "");

export async function fetchOffersExport(opts: { fresh?: boolean } = {}): Promise<string> {
  const now = Date.now();
  // Exact lookups (contract / offerId / did) must see a frame posted seconds
  // ago, so they bypass the browse snapshot cache — but still coalesce bursts
  // within a few seconds, and the deal-room mirror covers the immediate case.
  const minAge = opts.fresh ? 5_000 : TTL_MS;
  if (exportCache && now - exportCache.at < minAge) return exportCache.body;
  if (inflight) return inflight;
  const previous = exportCache;
  inflight = (async () => {
    try {
      const res = await fetch(`${BASE}/r/${OFFERS_ROOM}/export`, {
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: "text/plain;q=0.9, application/json;q=0.5" },
      });
      if (!res.ok) {
        throw new Error(`upstream export failed (HTTP ${res.status})`);
      }
      const body = await res.text();
      exportCache = { at: Date.now(), body };
      return body;
    } catch (e) {
      // Venue hiccup: serve the last snapshot if we have one.
      if (previous) return previous.body;
      throw e;
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function parseOffersExport(body: string): RecordInput[] {
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
  return records;
}
