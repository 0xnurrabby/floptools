/**
 * Server-side reader for a public room's full retained ring (`/r/<room>/export`).
 *
 * A plain room read returns only the newest ~200 messages (minutes on a busy
 * room). The export returns everything the venue still retains (~10 MiB ring),
 * which is what a check must scan to show activity that is genuinely still on
 * the ledger. Bodies are a few MB, so each room is cached briefly per instance.
 */

const TTL_MS = 20_000;
const cache = new Map<string, { at: number; body: string }>();

const BASE = (
  process.env.TECHNOCORE_BASE_URL ??
  process.env.NEXT_PUBLIC_TECHNOCORE_BASE_URL ??
  "https://technocore.chat"
).replace(/\/+$/, "");

const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export async function fetchRoomExport(room: string, opts: { fresh?: boolean } = {}): Promise<string> {
  if (!ROOM_RE.test(room)) throw new Error("invalid room name");
  const now = Date.now();
  const hit = cache.get(room);
  if (!opts.fresh && hit && now - hit.at < TTL_MS) return hit.body;
  const res = await fetch(`${BASE}/r/${room}/export`, {
    cache: "no-store",
    signal: AbortSignal.timeout(45_000),
    headers: { Accept: "text/plain;q=0.9, application/json;q=0.5" },
  });
  if (!res.ok) throw new Error(`upstream export failed (HTTP ${res.status})`);
  const body = await res.text();
  cache.set(room, { at: now, body });
  return body;
}
