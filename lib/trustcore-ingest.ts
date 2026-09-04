/**
 * Trustcore ingest logic (shared between the API routes and the server page).
 * Scans the public tclk board (tclk-offers + derived deal rooms) and stores
 * every signed frame into trustcore_frames, deduplicated by content hash.
 * The DB keeps history beyond the venue's ring — that is what makes lifetime
 * reputation possible at all.
 */

import { safeExec } from "./db";
import { TechnocoreClient } from "./technocore";
import { parseFrame, dealRoomForContract, type TclkFrame } from "./tclk";

const MAX_DEAL_ROOMS = 30;
const MAX_ROOM_LIMIT = 200;
const STALE_AFTER_MS = 90_000;

let lastIngest = 0;
let inflight: Promise<{ ok: boolean; frames: number; error?: string }> | null = null;

function baseUrl(): string {
  return process.env.NEXT_PUBLIC_TECHNOCORE_BASE_URL ?? "https://technocore.chat";
}

export async function ingestNow(): Promise<{ ok: boolean; frames: number; error?: string }> {
  if (inflight) return inflight;
  inflight = (async () => {
    const client = new TechnocoreClient({ baseUrl: baseUrl(), mode: "direct" });
    const frames: TclkFrame[] = [];
    let error: string | undefined;
    try {
      const offers = await client.readRoom("tclk-offers", { limit: MAX_ROOM_LIMIT });
      const dealRooms = new Set<string>();
      for (const m of offers.messages) {
        const f = parseFrame({ ...m, room: "tclk-offers" });
        if (f) {
          frames.push(f);
          if (f.contractId) {
            const room = dealRoomForContract(f.contractId);
            if (room) dealRooms.add(room);
          }
        }
      }
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

      let stored = 0;
      for (const f of frames) {
        try {
          await safeExec(
            `INSERT INTO trustcore_frames
               (hash, room, seq, did, frame_type, contract_id, offer_id, ref, amount, asset, role, outcome, rail, lock_kind, nonce, ts, raw_text)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
             ON CONFLICT (hash) DO NOTHING`,
            [
              f.hash,
              f.room,
              f.seq,
              f.did,
              f.type,
              f.contractId ?? null,
              f.offerId ?? null,
              f.ref ?? null,
              f.amount ?? null,
              f.asset ?? null,
              f.role ?? null,
              f.outcome ?? null,
              f.rail ?? null,
              f.lockKind ?? null,
              null,
              f.ts,
              f.rawText,
            ],
          );
          stored++;
        } catch {
          /* ignore single-row failures */
        }
      }
      lastIngest = Date.now();
      return { ok: true, frames: stored, error };
    } catch (e) {
      error = (e as Error).message.slice(0, 220);
      lastIngest = Date.now();
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
  if (Date.now() - lastIngest < STALE_AFTER_MS) {
    return { ok: true, frames: 0, cached: true };
  }
  const res = await ingestNow();
  return { ...res, cached: false };
}