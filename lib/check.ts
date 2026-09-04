/**
 * Setup-status check for an arbitrary did:key against the public instance.
 *
 * Evidence used (all public, all world-readable):
 *   - DID note present at the sharded path /kv/did-<shard>/<key>
 *     (legacy /kv/did/<fingerprint> fallback);
 *   - at least one signed message by that key observed in public rooms.
 *
 * States:
 *   NOT_SET_UP      no note, no signed activity
 *   HALF_SET_UP     note XOR signed activity
 *   SET_UP_CORRECTLY note present AND signed activity
 */

import type { TechnocoreClient } from "./technocore";
import { didNotePaths, didFingerprint } from "./didkey";

export const DEFAULT_SCAN_ROOMS = ["lobby", "technocore", "flop-network", "tclk-offers"];

export type SetupState = "NOT_SET_UP" | "HALF_SET_UP" | "SET_UP_CORRECTLY";

export interface RoomActivity {
  room: string;
  scannedMessages: number;
  signedMessages: number;
  latestSeq: number;
  latestTs?: string;
  latestText?: string;
  recent?: { seq: number; ts: string; text: string }[];
}

export interface LocalRecord {
  room: string;
  seq: number;
  nonce: string;
  text: string;
  ts?: string;
}

export interface DidCheckResult {
  did: string;
  fingerprint: string;
  notePath: string;
  noteFound: boolean;
  noteValue?: string;
  mailbox?: string;
  notePreview?: string;
  activity: RoomActivity[];
  signedMessageCount: number;
  localCount: number;
  localActivity: { room: string; count: number; latestSeq: number }[];
  state: SetupState;
  checks: { notePresent: boolean; keyEverSigned: boolean };
  scannedRooms: string[];
}

export function parseDidNote(value: string): {
  mailbox?: string;
  x25519?: string;
  tclk?: string;
} {
  const out: { mailbox?: string; x25519?: string; tclk?: string } = {};
  for (const token of value.trim().split(/\s+/)) {
    if (token.startsWith("mailbox:")) out.mailbox = token.slice("mailbox:".length);
    else if (token.startsWith("x25519:")) out.x25519 = token.slice("x25519:".length);
    else if (token.startsWith("tclk1:")) out.tclk = token.slice("tclk1:".length);
  }
  return out;
}

export interface RecordVerification {
  room: string;
  seq: number;
  found: boolean;
  from?: string;
  signed?: boolean;
  valid?: boolean;
  error?: string;
  message?: { text: string; nonce?: number; sig?: string; ts?: string };
}

/**
 * Deterministic verification of one record by seq: read the room's returned
 * window (up to 200 messages, the server cap) around that seq and re-verify
 * the signature offline. Rooms are a ring whose reads only ever show the
 * newest ~200 messages, so a record that has been rolled past is genuinely
 * unreachable on the ledger · that is a real answer, not a bug. The offline
 * signature check (rebuild room|nonce|text, verify sig) works forever.
 */
export async function verifyRecord(
  client: TechnocoreClient,
  room: string,
  seq: number,
  expectedDid?: string,
): Promise<RecordVerification> {
  const read = await client.readRoom(room, {
    since: Math.max(0, seq - 10),
    limit: 200,
  });
  const found = read.messages.find((m) => m.seq === seq);
  if (!found) {
    const past = read.first_seq > seq;
    return {
      room,
      seq,
      found: false,
      error: past
        ? `seq ${seq} is older than this room's readable window (first_seq ${read.first_seq}) · the ring has moved past it`
        : `seq ${seq} was not returned in the newest-200 window`,
    };
  }
  const out: RecordVerification = {
    room,
    seq,
    found: true,
    from: found.from,
    signed: Boolean(found.sig),
    message: { text: found.text, nonce: found.nonce, sig: found.sig, ts: found.ts },
  };
  if (!found.sig) {
    return { ...out, error: "record carries no signature (unsigned writer)" };
  }
  const did = expectedDid ?? found.from;
  if (expectedDid && found.from !== expectedDid) {
    return { ...out, error: `record was written by ${found.from}, not the expected DID` };
  }
  try {
    const { verifyMessage } = await import("./sign");
    const res = verifyMessage({
      did,
      room,
      nonce: String(found.nonce ?? ""),
      text: found.text,
      sig: found.sig,
    });
    return { ...out, valid: res.valid, error: res.valid ? undefined : res.error };
  } catch (e) {
    return { ...out, error: (e as Error).message };
  }
}

export async function checkDid(
  client: TechnocoreClient,
  did: string,
  opts: { rooms?: string[]; limit?: number; local?: LocalRecord[] } = {},
): Promise<DidCheckResult> {
  const rooms = opts.rooms ?? DEFAULT_SCAN_ROOMS;
  const limit = opts.limit ?? 200;
  const local = opts.local ?? [];

  const [fp, paths] = await Promise.all([didFingerprint(did), didNotePaths(did)]);

    let noteFound = false;
  let noteValue = "";
  let notePath = `${paths.sharded.ns}/${paths.sharded.key}`;
  // Parallel: sharded + legacy note reads = one round trip of latency.
  const [shardedNote, legacyNote] = await Promise.all([
    (async () => {
      try {
        return await client.readNote(paths.sharded.ns, paths.sharded.key);
      } catch {
        return null;
      }
    })(),
    (async () => {
      try {
        return await client.readNote(paths.legacy.ns, paths.legacy.key);
      } catch {
        return null;
      }
    })(),
  ]);
  if (shardedNote?.found) {
    noteFound = true;
    noteValue = shardedNote.value;
  } else if (legacyNote?.found) {
    noteFound = true;
    noteValue = legacyNote.value;
    notePath = `${paths.legacy.ns}/${paths.legacy.key}`;
  }

    const activity: RoomActivity[] = [];
  try {
    const results = await Promise.all(
      rooms.map(async (room) => {
        try {
          const read = await client.readRoom(room, { limit });
          let count = 0;
          let latestSeq = 0;
          let latestTs = undefined as string | undefined;
          let latestText = undefined as string | undefined;
          const recent: { seq: number; ts: string; text: string }[] = [];
          for (const m of read.messages) {
            if (m.from === did) {
              count++;
              if (m.seq > latestSeq) {
                latestSeq = m.seq;
                latestTs = m.ts;
                latestText = m.text;
              }
              recent.push({ seq: m.seq, ts: m.ts, text: m.text });
            }
          }
          return {
            room,
            scannedMessages: read.messages.length,
            signedMessages: count,
            latestSeq,
            latestTs,
            latestText,
            recent: recent.slice(-10).reverse(),
          } satisfies RoomActivity as RoomActivity;
        } catch {
          return { room, scannedMessages: 0, signedMessages: 0, latestSeq: 0 } satisfies RoomActivity as RoomActivity;
        }
      }),
    );
    activity.push(...results);
  } catch {
    /* keep whatever scanned */
  }

  const signedMessageCount = activity.reduce((acc, a) => acc + a.signedMessages, 0);

  // Group local receipts (this browser) per room.
  const byRoom = new Map<string, { count: number; latestSeq: number }>();
  for (const r of local) {
    const cur = byRoom.get(r.room) ?? { count: 0, latestSeq: 0 };
    cur.count++;
    if (r.seq > cur.latestSeq) cur.latestSeq = r.seq;
    byRoom.set(r.room, cur);
  }
  const localActivity = [...byRoom.entries()].map(([room, v]) => ({ room, count: v.count, latestSeq: v.latestSeq }));

  const notePresent = noteFound;
  // A key "has signed" if the public scan observed it OR local receipts record it
  // (receipts are written only on a 200 publish · they are first-party proof).
  const keyEverSigned = signedMessageCount > 0 || local.length > 0;

  let state: SetupState;
  if (notePresent && keyEverSigned) state = "SET_UP_CORRECTLY";
  else if (notePresent || keyEverSigned) state = "HALF_SET_UP";
  else state = "NOT_SET_UP";

  const parsed = noteFound ? parseDidNote(noteValue) : {};

  return {
    did,
    fingerprint: fp,
    notePath,
    noteFound,
    noteValue,
    mailbox: parsed.mailbox,
    notePreview: noteFound ? noteValue.slice(0, 200) : undefined,
    activity,
    signedMessageCount,
    localCount: local.length,
    localActivity,
    state,
    checks: { notePresent, keyEverSigned },
    scannedRooms: rooms,
  };
}