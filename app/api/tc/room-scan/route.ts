import { NextRequest, NextResponse } from "next/server";
import { fetchRoomExport } from "@/lib/room-export";
import { didNotePaths, isValidDid } from "@/lib/didkey";
import { TechnocoreClient } from "@/lib/technocore";

/**
 * GET /api/tc/room-scan?did=… | ?dids=a,b,c
 *
 * Honest activity scan straight off the public ledger: reads each public
 * room's FULL retained ring export (not just the newest-200 tail, which rolls
 * within minutes on busy rooms) and reports, per DID and room, how many signed
 * messages are still retained, the latest seq/ts/text and the newest few.
 *
 * Read-only, no secrets, no writes. Used by /check and the Pro bulk checker.
 */

const SCAN_ROOMS = ["lobby", "technocore", "flop-network", "tclk-offers"];
const MAX_DIDS = 100;
const RECENT_PER_ROOM = 8;

export const maxDuration = 60;

interface RoomEntry {
  count: number;
  latestSeq: number;
  latestTs?: string;
  latestText?: string;
  recent: { seq: number; ts: string; text: string }[];
}

function emptyEntry(): RoomEntry {
  return { count: 0, latestSeq: 0, recent: [] };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const raw = (req.nextUrl.searchParams.get("dids") ?? req.nextUrl.searchParams.get("did") ?? "").trim();
  const dids = [...new Set(raw.split(",").map((d) => d.trim()).filter(Boolean))];
  if (dids.length === 0) {
    return NextResponse.json({ ok: false, error: "pass ?did= or ?dids=" }, { status: 400 });
  }
  if (dids.length > MAX_DIDS) {
    return NextResponse.json({ ok: false, error: `at most ${MAX_DIDS} DIDs per scan` }, { status: 400 });
  }
  for (const d of dids) {
    if (!isValidDid(d)) {
      return NextResponse.json({ ok: false, error: "every did must be a valid did:key" }, { status: 400 });
    }
  }

  // "fast" reads the newest-200 tail per room (instant, covers fresh activity);
  // "deep" (default) scans each room's full retained export in parallel.
  const mode = req.nextUrl.searchParams.get("mode") === "fast" ? "fast" : "deep";

  const rooms: Record<string, { retainedFirst: number; retainedLast: number; messages: number; error?: string }> = {};
  const byDid: Record<string, Record<string, RoomEntry>> = {};
  for (const d of dids) {
    byDid[d] = {};
    for (const room of SCAN_ROOMS) byDid[d][room] = emptyEntry();
  }

  const tailClient = new TechnocoreClient({ mode: "direct" });

  await Promise.all(
    SCAN_ROOMS.map(async (room) => {
      try {
        let messages: { seq: number; ts: string; from: string; text: string }[] = [];
        let first = 0;
        let last = 0;
        if (mode === "fast") {
          const read = await tailClient.readRoom(room, { limit: 200 });
          first = read.first_seq;
          last = read.last_seq;
          messages = read.messages
            .filter((m) => typeof m.from === "string" && typeof m.text === "string")
            .map((m) => ({
              seq: typeof m.seq === "number" ? m.seq : 0,
              ts: typeof m.ts === "string" ? m.ts : "",
              from: m.from,
              text: m.text,
            }));
        } else {
          const body = await fetchRoomExport(room);
          for (const line of body.split("\n")) {
            if (!line.trim()) continue;
            let m: { seq?: number; ts?: string; from?: string; text?: string };
            try {
              m = JSON.parse(line) as typeof m;
            } catch {
              continue;
            }
            if (typeof m?.from !== "string" || typeof m?.text !== "string") continue;
            const seq = typeof m.seq === "number" ? m.seq : 0;
            if (first === 0 || seq < first) first = seq;
            if (seq > last) last = seq;
            messages.push({ seq, ts: typeof m.ts === "string" ? m.ts : "", from: m.from, text: m.text });
          }
        }
        const total = messages.length;
        for (const msg of messages) {
          const entry = byDid[msg.from]?.[room];
          if (!entry) continue;
          entry.count++;
          if (msg.seq >= entry.latestSeq) {
            entry.latestSeq = msg.seq;
            entry.latestTs = msg.ts;
            entry.latestText = msg.text;
          }
          entry.recent.push({ seq: msg.seq, ts: msg.ts, text: msg.text });
          if (entry.recent.length > RECENT_PER_ROOM) entry.recent.shift();
        }
        for (const d of dids) byDid[d][room].recent.reverse();
        rooms[room] = { retainedFirst: first, retainedLast: last, messages: total };
      } catch (e) {
        rooms[room] = { retainedFirst: 0, retainedLast: 0, messages: 0, error: (e as Error).message.slice(0, 140) };
      }
    }),
  );

  // DID note presence (durable part) — read straight from the public ledger,
  // with a small pool so 100 DIDs never flood the venue at once.
  const client = new TechnocoreClient({ mode: "direct" });
  const notes: Record<string, { found: boolean; path: string; value?: string }> = {};
  let noteCursor = 0;
  const noteWorker = async () => {
    while (noteCursor < dids.length) {
      const d = dids[noteCursor++];
      try {
        const paths = await didNotePaths(d);
        const [sharded, legacy] = await Promise.all([
          client.readNote(paths.sharded.ns, paths.sharded.key).catch(() => null),
          client.readNote(paths.legacy.ns, paths.legacy.key).catch(() => null),
        ]);
        if (sharded?.found) {
          notes[d] = { found: true, path: `${paths.sharded.ns}/${paths.sharded.key}`, value: sharded.value.slice(0, 200) };
        } else if (legacy?.found) {
          notes[d] = { found: true, path: `${paths.legacy.ns}/${paths.legacy.key}`, value: legacy.value.slice(0, 200) };
        } else {
          notes[d] = { found: false, path: `${paths.sharded.ns}/${paths.sharded.key}` };
        }
      } catch {
        notes[d] = { found: false, path: "" };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, dids.length) }, noteWorker));

  return NextResponse.json({ ok: true, rooms, dids: byDid, notes });
}
