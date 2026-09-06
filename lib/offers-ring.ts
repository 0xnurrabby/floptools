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

const TTL_MS = 20_000;

let exportCache: { at: number; body: string } | null = null;

const BASE = (
  process.env.TECHNOCORE_BASE_URL ??
  process.env.NEXT_PUBLIC_TECHNOCORE_BASE_URL ??
  "https://technocore.chat"
).replace(/\/+$/, "");

export async function fetchOffersExport(): Promise<string> {
  const now = Date.now();
  if (exportCache && now - exportCache.at < TTL_MS) return exportCache.body;
  const res = await fetch(`${BASE}/r/${OFFERS_ROOM}/export`, {
    cache: "no-store",
    signal: AbortSignal.timeout(45_000),
    headers: { Accept: "text/plain;q=0.9, application/json;q=0.5" },
  });
  if (!res.ok) {
    throw new Error(`upstream export failed (HTTP ${res.status})`);
  }
  const body = await res.text();
  exportCache = { at: now, body };
  return body;
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
