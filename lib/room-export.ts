/**
 * Server-side reader for a public room's full retained ring (`/r/<room>/export`).
 *
 * A plain room read returns only the newest ~200 messages (minutes on a busy
 * room). The export returns everything the venue still retains (~10 MiB ring),
 * which is what a check must scan to show activity that is genuinely still on
 * the ledger. Bodies are a few MB, so each room is cached per instance and
 * concurrent requests coalesce into one upstream fetch. If the venue hiccups,
 * the last good snapshot is served rather than failing the scan.
 */

const TTL_MS = 90_000;
const FETCH_TIMEOUT_MS = 30_000;

const cache = new Map<string, { at: number; body: string }>();
const inflight = new Map<string, Promise<string>>();

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

  const running = inflight.get(room);
  if (running) return running;

  const promise = (async () => {
    try {
      const res = await fetch(`${BASE}/r/${room}/export`, {
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: "text/plain;q=0.9, application/json;q=0.5" },
      });
      if (!res.ok) throw new Error(`upstream export failed (HTTP ${res.status})`);
      const body = await res.text();
      cache.set(room, { at: Date.now(), body });
      return body;
    } catch (e) {
      // The venue is occasionally slow: a stale snapshot beats an error.
      if (hit) return hit.body;
      throw e;
    }
  })().finally(() => {
    inflight.delete(room);
  });

  inflight.set(room, promise);
  return promise;
}
