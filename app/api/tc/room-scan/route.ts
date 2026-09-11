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
const MAX_DIDS = 20;

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

  const rooms: Record<string, { retainedFirst: number; retainedLast: number; messages: number; error?: string }> = {};
  const byDid: Record<string, Record<string, RoomEntry>> = {};
  for (const d of dids) {
    byDid[d] = {};
    for (const room of SCAN_ROOMS) byDid[d][room] = emptyEntry();
  }

  for (const room of SCAN_ROOMS) {
    try {
      const body = await fetchRoomExport(room);
      let first = 0;
      let last = 0;
      let total = 0;
      for (const line of body.split("\n")) {
        if (!line.trim()) continue;
        let m: { seq?: number; ts?: string; from?: string; text?: string };
        try {
          m = JSON.parse(line) as typeof m;
        } catch {
          continue;
        }
        if (typeof m?.from !== "string" || typeof m?.text !== "string") continue;
        total++;
        if (typeof m.seq === "number") {
          if (first === 0 || m.seq < first) first = m.seq;
          if (m.seq > last) last = m.seq;
        }
        const entry = byDid[m.from]?.[room];
        if (!entry) continue;
        const msg = {
          seq: typeof m.seq === "number" ? m.seq : 0,
          ts: typeof m.ts === "string" ? m.ts : "",
          text: m.text,
        };
        entry.count++;
        if (msg.seq >= entry.latestSeq) {
          entry.latestSeq = msg.seq;
          entry.latestTs = msg.ts;
          entry.latestText = msg.text;
        }
        entry.recent.push(msg);
        if (entry.recent.length > 20) entry.recent.shift();
      }
      for (const d of dids) byDid[d][room].recent.reverse();
      rooms[room] = { retainedFirst: first, retainedLast: last, messages: total };
    } catch (e) {
      rooms[room] = { retainedFirst: 0, retainedLast: 0, messages: 0, error: (e as Error).message.slice(0, 140) };
    }
  }

  // DID note presence (durable part) — read straight from the public ledger.
  const client = new TechnocoreClient({ mode: "direct" });
  const notes: Record<string, { found: boolean; path: string; value?: string }> = {};
  await Promise.all(
    dids.map(async (d) => {
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
    }),
  );

  return NextResponse.json({ ok: true, rooms, dids: byDid, notes });
}
