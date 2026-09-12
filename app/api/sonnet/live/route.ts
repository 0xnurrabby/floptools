import { NextResponse } from "next/server";
import { liveRooms, readSonnetTail, SONNET, type SonnetMessage } from "@/lib/sonnet";

/**
 * GET /api/sonnet/live — newest messages across the sonnet-2 rooms (shared
 * rooms + the busiest team rooms). Tails only, ~5s cache: the page polls and
 * stays genuinely live without hammering the venue.
 */

export const maxDuration = 60;

interface LiveRow extends SonnetMessage {
  type: string;
}

let cache: { at: number; rows: LiveRow[] } | null = null;
let inflight: Promise<LiveRow[]> | null = null;
const TTL_MS = 5_000;
const KEEP = 160;

function typeOf(text: string): string {
  const t = text.trim();
  if (!t.startsWith("{")) return "message";
  try {
    const o = JSON.parse(t) as { type?: unknown; receipts?: unknown; request_id?: unknown };
    if (typeof o.type === "string") return o.type;
    if (Array.isArray(o.receipts)) return "sonnet.receipt.v1";
    if (typeof o.request_id === "string") return "sonnet.receipt.v1";
    return "record";
  } catch {
    return "message";
  }
}

function roomLabel(room: string): string {
  if (room.startsWith("d-sonnet-2-team-")) return `team:${room.slice("d-sonnet-2-team-".length)}`;
  if (room === SONNET.rooms.votes) return "votes";
  if (room === SONNET.rooms.submissions) return "submissions";
  if (room === SONNET.rooms.discovery) return "discovery";
  if (room === SONNET.rooms.registration) return "registration";
  if (room === SONNET.rooms.campaign) return "campaign";
  if (room === SONNET.rooms.rules) return "rules";
  return room;
}

async function load(): Promise<LiveRow[]> {
  const rooms = await liveRooms();
  const results = await Promise.allSettled(rooms.map((r) => readSonnetTail(r, 60)));
  const rows: LiveRow[] = [];
  for (const res of results) {
    if (res.status !== "fulfilled") continue;
    for (const m of res.value) {
      rows.push({ ...m, room: roomLabel(m.room), type: typeOf(m.text) });
    }
  }
  rows.sort((a, b) => (a.ts === b.ts ? b.seq - a.seq : a.ts < b.ts ? 1 : -1));
  return rows.slice(0, KEEP);
}

export async function GET(): Promise<NextResponse> {
  try {
    if (cache && Date.now() - cache.at < TTL_MS) {
      return NextResponse.json({ ok: true, cached: true, rows: cache.rows });
    }
    if (!inflight) {
      inflight = load()
        .then((rows) => {
          cache = { at: Date.now(), rows };
          return rows;
        })
        .finally(() => {
          inflight = null;
        });
    }
    const rows = await inflight;
    return NextResponse.json({ ok: true, cached: false, rows });
  } catch (e) {
    if (cache) return NextResponse.json({ ok: true, stale: true, rows: cache.rows });
    return NextResponse.json({ ok: false, error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}
