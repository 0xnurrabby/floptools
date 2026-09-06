/**
 * Trustcore ingest logic (shared between the API routes and the server page).
 * Scans the public tclk board (tclk-offers + derived deal rooms) and stores
 * every signed frame into trustcore_frames, deduplicated by content hash.
 * The DB keeps history beyond the venue's ring — that is what makes lifetime
 * reputation possible at all.
 *
 * Why the full export: the venue keeps `tclk-offers` as a rolling ring of only
 * the newest ~10 MiB, and a plain room read returns just the tail (~200 newest
 * messages). A deal's offer+accept therefore leaves the tail within hours, and
 * its lock/reveal/receipt live in the derived deal room (mb-p-tclk-<16hex>).
 * We scan the whole retained export (like /api/tc/deal-lookup) to discover
 * every still-live contract, plus every deal room the app has seen (stored in
 * trustcore_rooms by the deal pages), so completed deals are not lost when
 * their pair scrolls out of the tail.
 */

import { safeExec, safeQuery } from "./db";
import { TechnocoreClient } from "./technocore";
import { parseFrame, dealRoomForContract, type TclkFrame } from "./tclk";
import { fetchOffersExport, parseOffersExport } from "./offers-ring";
import { knownDealRooms } from "./trustcore-db";

const MAX_DEAL_ROOMS = 100;
const MAX_ROOM_LIMIT = 200;
const STALE_AFTER_MS = 90_000;

let lastIngest = 0;
let inflight: Promise<{ ok: boolean; frames: number; error?: string }> | null = null;

function baseUrl(): string {
  return process.env.NEXT_PUBLIC_TECHNOCORE_BASE_URL ?? "https://technocore.chat";
}

/** Last ingest timestamp as recorded in the DB (shared across instances). */
async function dbLastIngestMs(): Promise<number> {
  const rows = (await safeQuery(`SELECT value FROM trustcore_meta WHERE key = 'last_ingest_ms'`)) ?? [];
  const v = Number(rows[0]?.["value"]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

async function markIngested(): Promise<void> {
  await safeExec(
    `INSERT INTO trustcore_meta (key, value, updated_at)
     VALUES ('last_ingest_ms', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [String(Date.now())],
  );
}

export async function ingestNow(): Promise<{ ok: boolean; frames: number; error?: string }> {
  if (inflight) return inflight;
  inflight = (async () => {
    const client = new TechnocoreClient({ baseUrl: baseUrl(), mode: "direct" });
    const frames: TclkFrame[] = [];
    let error: string | undefined;
    try {
      // 1. The whole retained offers ring. Fall back to the tail read only if
      //    the export is unavailable (the tail still catches the newest deals).
      let offerRecords;
      try {
        offerRecords = parseOffersExport(await fetchOffersExport());
      } catch {
        const tail = await client.readRoom("tclk-offers", { limit: MAX_ROOM_LIMIT });
        offerRecords = tail.messages.map((m) => ({
          room: "tclk-offers",
          from: m.from,
          text: m.text,
          seq: m.seq,
          ts: m.ts,
          ...(m.sig ? { sig: m.sig } : {}),
        }));
      }
      const dealRooms = new Set<string>();
      for (const m of offerRecords) {
        const f = parseFrame({ ...m });
        if (f) {
          frames.push(f);
          if (f.contractId) {
            const room = dealRoomForContract(f.contractId);
            if (room) dealRooms.add(room);
          }
        }
      }
      // 2. Deal rooms the app has seen (deal pages remember them) — these can
      //    hold a deal's lock/reveal/receipt even after its pair left the tail.
      for (const room of await knownDealRooms()) dealRooms.add(room);

      // 3. Read every deal room and keep its frames. A reaped room just
      //    returns empty — harmless.
      for (const room of [...dealRooms].slice(0, MAX_DEAL_ROOMS)) {
        try {
          const read = await client.readRoom(room, { limit: MAX_ROOM_LIMIT });
          for (const m of read.messages) {
            const f = parseFrame({ ...m, room });
            if (f) frames.push(f);
          }
        } catch {
          /* a bad deal room must not fail the whole ingest */
        }
      }

      // Batch insert: one round-trip per 150 frames instead of one per frame.
      let stored = 0;
      for (let i = 0; i < frames.length; i += 150) {
        const chunk = frames.slice(i, i + 150);
        const values: unknown[] = [];
        const placeholders = chunk.map((_, j) => {
          const b = j * 17;
          values.push(
            chunk[j].hash,
            chunk[j].room,
            chunk[j].seq,
            chunk[j].did,
            chunk[j].type,
            chunk[j].contractId ?? null,
            chunk[j].offerId ?? null,
            chunk[j].ref ?? null,
            chunk[j].amount ?? null,
            chunk[j].asset ?? null,
            chunk[j].role ?? null,
            chunk[j].outcome ?? null,
            chunk[j].rail ?? null,
            chunk[j].lockKind ?? null,
            null,
            chunk[j].ts,
            chunk[j].rawText,
          );
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14},$${b + 15},$${b + 16},$${b + 17})`;
        });
        try {
          await safeExec(
            `INSERT INTO trustcore_frames
               (hash, room, seq, did, frame_type, contract_id, offer_id, ref, amount, asset, role, outcome, rail, lock_kind, nonce, ts, raw_text)
             VALUES ${placeholders.join(",")}
             ON CONFLICT (hash) DO NOTHING`,
            values,
          );
          stored += chunk.length;
        } catch {
          /* chunk failed — skip */
        }
      }
      lastIngest = Date.now();
      await markIngested();
      return { ok: true, frames: stored, error };
    } catch (e) {
      error = (e as Error).message.slice(0, 220);
      lastIngest = Date.now();
      await markIngested();
      return { ok: false, frames: frames.length, error };
    }
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export async function ingestIfStale(): Promise<{ ok: boolean; frames: number; error?: string; cached: boolean }> {
  const last = Math.max(lastIngest, await dbLastIngestMs());
  if (Date.now() - last < STALE_AFTER_MS) {
    return { ok: true, frames: 0, cached: true };
  }
  const res = await ingestNow();
  return { ...res, cached: false };
}
