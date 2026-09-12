/**
 * Sonnet-2 contest data layer (server-side, read-only public data).
 *
 * Reads the contest rooms off technocore, parses the signed protocol records
 * (registrations, rosters, word proposals + referee receipts, submissions,
 * ballots) and aggregates teams, poems and the live vote tally. Nothing here
 * writes to the venue; the only local state is the writer-registration index
 * used to display declared X accounts.
 *
 * Protocol reference: github.com/flop-labs/technocore-sonnet-challenge
 */

import { safeExec, safeQuery } from "./db";
import { fetchRoomExport } from "./room-export";
import { TechnocoreClient } from "./technocore";

export const SONNET = {
  contestId: "sonnet-2",
  referee: "did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte",
  openMs: Date.parse("2026-09-11T12:00:00Z"),
  closeMs: Date.parse("2026-09-18T12:00:00Z"),
  rooms: {
    rules: "d-sonnet-2-rules",
    registration: "mb-sonnet-2-registration",
    discovery: "mb-sonnet-2-discovery",
    campaign: "mb-sonnet-2-campaign",
    votes: "mb-sonnet-2-votes",
    submissions: "mb-sonnet-2-submissions",
    results: "d-sonnet-2-results",
  },
  dictUrl:
    "https://raw.githubusercontent.com/flop-labs/technocore-sonnet-challenge/main/cmudict.dict",
} as const;

export interface SonnetMessage {
  room: string;
  seq: number;
  from: string;
  text: string;
  ts: string;
}

/* ---------------- room reads (cached per instance) ---------------- */

const roomCache = new Map<string, { at: number; messages: SonnetMessage[] }>();
const ROOM_TTL_MS = 60_000;
const roomInflight = new Map<string, Promise<SonnetMessage[]>>();

function parseExport(room: string, body: string): SonnetMessage[] {
  const out: SonnetMessage[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as { seq?: number; from?: string; text?: string; ts?: string };
      if (typeof m?.from !== "string" || typeof m?.text !== "string") continue;
      out.push({
        room,
        seq: typeof m.seq === "number" ? m.seq : 0,
        from: m.from,
        text: m.text,
        ts: typeof m.ts === "string" ? m.ts : "",
      });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/** Full retained ring for a room, cached briefly; bursts coalesce. */
export async function readSonnetRoom(room: string, opts: { fresh?: boolean } = {}): Promise<SonnetMessage[]> {
  const hit = roomCache.get(room);
  if (!opts.fresh && hit && Date.now() - hit.at < ROOM_TTL_MS) return hit.messages;
  const running = roomInflight.get(room);
  if (running) return running;
  const promise = (async () => {
    try {
      const body = await fetchRoomExport(room, { fresh: opts.fresh });
      const messages = parseExport(room, body);
      roomCache.set(room, { at: Date.now(), messages });
      return messages;
    } catch (e) {
      if (hit) return hit.messages; // stale beats an error
      throw e;
    }
  })().finally(() => roomInflight.delete(room));
  roomInflight.set(room, promise);
  return promise;
}

/** Newest tail for a room (fast; used by the live feed). */
export async function readSonnetTail(room: string, limit = 80): Promise<SonnetMessage[]> {
  const client = new TechnocoreClient({ mode: "direct" });
  const read = await client.readRoom(room, { limit });
  return read.messages.map((m) => ({
    room,
    seq: m.seq,
    from: m.from,
    text: m.text,
    ts: m.ts,
  }));
}

/* ---------------- message parsing helpers ---------------- */

function json(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(t) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/* ---------------- aggregation ---------------- */

export interface SonnetMember {
  did: string;
  x: string | null;
  words: number;
}

export interface SonnetTeam {
  gameId: string;
  poemRoom: string;
  roomGeneration: number | null;
  members: SonnetMember[];
  /** Accepted words in order (version 1..n). */
  words: { word: string; by: string; version: number }[];
  /** Canonical poem lines reconstructed with the frozen dictionary. */
  lines: string[];
  complete: boolean;
  wordCount: number;
  entryId: string | null;
  eligibility: string | null;
  xPostIds: string[];
  poemSha256: string | null;
  votes: number;
  lastAt: string;
  lastSeqByRoom: Record<string, number>;
}

export interface SonnetOverview {
  updatedAt: string;
  contest: {
    opening: number;
    deadline: number;
    referee: string;
    status: {
      accepted: number;
      rejected: number;
      teams: number;
      writers: number;
      voters: number;
      organizers: number;
      rooms: string[];
    } | null;
  };
  teams: SonnetTeam[];
  totals: { teams: number; entries: number; ballots: number; countedBallots: number; voters: number };
  writersIndexed: number;
}

interface RefereeReceipt {
  requestId: string;
  senderDid: string;
  status: string;
  reason: string;
  entryId?: string;
  version?: number;
  complete?: boolean;
  intakeSeq?: number;
  rosterReady?: boolean;
  eligibility?: string;
}

function parseReceipts(messages: SonnetMessage[]): RefereeReceipt[] {
  const out: RefereeReceipt[] = [];
  for (const m of messages) {
    if (m.from !== SONNET.referee) continue;
    const o = json(m.text);
    if (!o) continue;
    const baseStatus = str(o.status);
    const reason = str(o.reason);
    // Single receipt
    if (typeof o.request_id === "string") {
      out.push({
        requestId: str(o.request_id),
        senderDid: str(o.sender_did),
        status: baseStatus || (reason ? "rejected" : "accepted"),
        reason,
        entryId: str(o.entry_id) || undefined,
        version: typeof o.version === "number" ? o.version : undefined,
        complete: typeof o.complete === "boolean" ? o.complete : undefined,
        intakeSeq: typeof o.intake_seq === "number" ? o.intake_seq : undefined,
        rosterReady: typeof o.roster_ready === "boolean" ? o.roster_ready : undefined,
        eligibility: str(o.eligibility) || undefined,
      });
      continue;
    }
    // Batched receipts
    if (Array.isArray(o.receipts)) {
      for (const r of o.receipts as unknown[]) {
        const rr = r as Record<string, unknown>;
        if (typeof rr?.request_id !== "string") continue;
        out.push({
          requestId: str(rr.request_id),
          senderDid: str(rr.sender_did),
          status: baseStatus || (reason ? "rejected" : "accepted"),
          reason,
        });
      }
    }
  }
  return out;
}

/* ---------------- frozen dictionary (for poem line reconstruction) ------- */

const VOWEL_PHONES = new Set([
  "AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW",
]);

let dictPromise: Promise<Map<string, number>> | null = null;

function loadDict(): Promise<Map<string, number>> {
  if (dictPromise) return dictPromise;
  dictPromise = (async () => {
    const map = new Map<string, number>();
    try {
      const res = await fetch(SONNET.dictUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`dict ${res.status}`);
      const text = await res.text();
      for (const entry of text.split("\n")) {
        const fields = entry.split("#", 1)[0]!.split(/\s+/);
        if (!fields[0] || fields[0].startsWith(";;;")) continue;
        const word = fields[0].replace(/\(\d+\)$/, "").toLowerCase();
        if (!/^[a-z]+(?:'[a-z]+)*$/.test(word)) continue;
        let count = 0;
        for (const phone of fields.slice(1)) {
          const stress = phone.slice(-1);
          if (VOWEL_PHONES.has(phone.slice(0, -1)) && (stress === "0" || stress === "1" || stress === "2")) {
            count++;
          }
        }
        if (count > 0) map.set(word, Math.max(map.get(word) ?? 0, count));
      }
    } catch {
      /* dictionary unavailable: lines stay ungrouped */
    }
    return map;
  })();
  return dictPromise;
}

function syllablesOf(token: string, dict: Map<string, number>): number {
  const m = /^([A-Za-z]+(?:'[A-Za-z]+)*)[,.;:!?]?$/.exec(token);
  if (!m) return 0;
  return dict.get(m[1]!.toLowerCase()) ?? 0;
}

/** Rebuild the canonical poem lines from accepted words (10 syllables per line). */
function reconstructLines(words: string[], dict: Map<string, number>): string[] {
  if (dict.size === 0) return words.length > 0 ? [words.join(" ")] : [];
  const lines: string[] = [];
  let current: string[] = [];
  let count = 0;
  for (const token of words) {
    const s = syllablesOf(token, dict);
    if (count + s > 10 && current.length > 0) {
      lines.push(current.join(" "));
      current = [];
      count = 0;
    }
    current.push(token);
    count += s;
    if (count === 10) {
      lines.push(current.join(" "));
      current = [];
      count = 0;
    }
  }
  if (current.length > 0) lines.push(current.join(" "));
  return lines;
}

/* ---------------- writer index (DB-backed, background refresh) ---------- */

interface WriterRow {
  did: string;
  x_account: string | null;
}

async function writersFromDb(): Promise<Map<string, WriterRow>> {
  const rows =
    (await safeQuery("SELECT did, x_account FROM sonnet_writers WHERE role = 'writer'")) ?? [];
  const map = new Map<string, WriterRow>();
  for (const r of rows) {
    const did = String(r["did"] ?? "");
    if (!did) continue;
    map.set(did, { did, x_account: (r["x_account"] as string) ?? null });
  }
  return map;
}

async function writersFresh(): Promise<boolean> {
  const rows =
    (await safeQuery("SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM sonnet_writers")) ?? [];
  const n = Number(rows[0]?.["n"] ?? 0);
  const at = rows[0]?.["at"] ? Date.parse(String(rows[0]?.["at"])) : 0;
  if (n === 0) return false;
  return Date.now() - at < 15 * 60_000;
}

export interface WriterRefreshInfo {
  parsed: number;
  inserted: number;
  error?: string;
}

let writerIngest: Promise<WriterRefreshInfo> | null = null;

/** Parse registrations into did -> role/x. Runs in the background, bounded. */
async function ingestWriters(): Promise<WriterRefreshInfo> {
  if (writerIngest) return writerIngest;
  writerIngest = (async (): Promise<WriterRefreshInfo> => {
    const info: WriterRefreshInfo = { parsed: 0, inserted: 0 };
    try {
      const messages = await readSonnetRoom(SONNET.rooms.registration);
      const rows: { did: string; role: string; x: string | null }[] = [];
      const seen = new Set<string>();
      for (const m of messages) {
        const o = json(m.text);
        if (!o || str(o.type) !== "sonnet.register.v1") continue;
        if (str(o.contest_id) !== SONNET.contestId) continue;
        const role = str(o.role);
        if (role !== "writer" && role !== "voter" && role !== "organizer") continue;
        if (seen.has(m.from)) continue;
        seen.add(m.from);
        rows.push({
          did: m.from,
          role,
          x: role === "writer" ? str(o.x_account_url) || null : null,
        });
      }
      info.parsed = rows.length;
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const values: unknown[] = [];
        const placeholders = chunk.map((r, j) => {
          values.push(r.did, r.role, r.x);
          return `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`;
        });
        await safeExec(
          `INSERT INTO sonnet_writers (did, role, x_account, updated_at)
           VALUES ${placeholders.join(",")}
           ON CONFLICT (did) DO UPDATE SET role = EXCLUDED.role, x_account = EXCLUDED.x_account, updated_at = now()`,
          values,
        );
        info.inserted += chunk.length;
      }
    } catch (e) {
      info.error = (e as Error).message.slice(0, 200);
    }
    return info;
  })().finally(() => {
    writerIngest = null;
  });
  return writerIngest;
}

/** Await a writer-index refresh (used by an explicit ?writers=1 request). */
export async function refreshWriters(): Promise<WriterRefreshInfo> {
  return ingestWriters();
}

/* ---------------- the aggregate ---------------- */

let overviewCache: { at: number; data: SonnetOverview } | null = null;
let overviewInflight: Promise<SonnetOverview> | null = null;
const OVERVIEW_TTL_MS = 60_000;

export function sonnetOverviewCached(): SonnetOverview | null {
  return overviewCache?.data ?? null;
}

export async function loadSonnetOverview(opts: { fresh?: boolean } = {}): Promise<SonnetOverview> {
  if (!opts.fresh && overviewCache && Date.now() - overviewCache.at < OVERVIEW_TTL_MS) {
    return overviewCache.data;
  }
  if (overviewInflight) return overviewInflight;
  overviewInflight = (async () => {
    const [rules, discovery, votes, submissions, writers] = await Promise.all([
      readSonnetRoom(SONNET.rooms.rules).catch(() => [] as SonnetMessage[]),
      readSonnetRoom(SONNET.rooms.discovery).catch(() => [] as SonnetMessage[]),
      readSonnetRoom(SONNET.rooms.votes).catch(() => [] as SonnetMessage[]),
      readSonnetRoom(SONNET.rooms.submissions).catch(() => [] as SonnetMessage[]),
      writersFromDb().catch(() => new Map<string, WriterRow>()),
    ]);

    // Kick a background refresh of the writer index when needed (never blocks).
    void writersFresh()
      .then((ok) => {
        if (!ok) void ingestWriters();
      })
      .catch(() => {});

    // --- referee status (latest sonnet.notice.v1 in rules) ---
    let status: SonnetOverview["contest"]["status"] = null;
    for (const m of rules) {
      if (m.from !== SONNET.referee) continue;
      const o = json(m.text);
      if (!o || str(o.type) !== "sonnet.notice.v1") continue;
      const counts = (o.counts ?? {}) as Record<string, unknown>;
      const participants = (o.participants ?? {}) as Record<string, unknown>;
      const intake = (o.intake ?? {}) as Record<string, unknown>;
      status = {
        accepted: Number(counts["accepted"] ?? 0),
        rejected: Number(counts["rejected"] ?? 0),
        teams: Number(o.teams ?? 0),
        writers: Number(participants["writer"] ?? 0),
        voters: Number(participants["voter"] ?? 0),
        organizers: Number(participants["organizer"] ?? 0),
        rooms: Array.isArray(intake["rooms"]) ? (intake["rooms"] as unknown[]).map(str) : [],
      };
    }

    // --- rosters (latest per game_id) ---
    const teams = new Map<string, SonnetTeam>();
    const rostersByGame = new Map<
      string,
      { members: string[]; poemRoom: string; roomGeneration: number | null; at: number }
    >();
    for (const m of discovery) {
      const o = json(m.text);
      if (!o || str(o.type) !== "sonnet.roster.v1") continue;
      const gameId = str(o.game_id);
      if (!gameId) continue;
      const members: string[] = [];
      const rawMembers = Array.isArray(o.members) ? (o.members as unknown[]) : [];
      for (const mem of rawMembers) {
        if (typeof mem === "string") members.push(mem);
        else if (mem && typeof mem === "object") {
          const did = str((mem as Record<string, unknown>)["did"]);
          if (did) members.push(did);
        }
      }
      const prev = rostersByGame.get(gameId);
      if (!prev || members.length >= prev.members.length) {
        rostersByGame.set(gameId, {
          members,
          poemRoom: str(o.poem_room) || `d-sonnet-2-team-${gameId}`,
          roomGeneration: typeof o.room_generation === "number" ? o.room_generation : null,
          at: m.seq,
        });
      }
    }

    // --- accepted submissions -> entry ids ---
    const entryByGame = new Map<string, { entryId: string; eligibility: string | null }>();
    const submitByGame = new Map<string, { xPostIds: string[]; poemSha256: string | null }>();
    for (const m of submissions) {
      const o = json(m.text);
      if (!o || str(o.type) !== "sonnet.submit.v1") continue;
      const gameId = str(o.game_id);
      if (!gameId) continue;
      const posts = Array.isArray(o.x_post_ids) ? (o.x_post_ids as unknown[]).map(str) : [];
      submitByGame.set(gameId, { xPostIds: posts, poemSha256: str(o.poem_sha256) || null });
    }
    for (const m of submissions) {
      if (m.from !== SONNET.referee) continue;
      const o = json(m.text);
      if (!o) continue;
      const entryId = str(o.entry_id);
      const requestId = str(o.request_id);
      if (!entryId || str(o.reason) !== "") continue;
      // find the game via the matching submit request
      for (const msg of submissions) {
        const s = json(msg.text);
        if (s && str(s.type) === "sonnet.submit.v1" && str(s.request_id) === requestId) {
          entryByGame.set(str(s.game_id), {
            entryId,
            eligibility: str(o.eligibility) || null,
          });
          break;
        }
      }
    }

    // --- ballots: each voter's LAST accepted ballot counts ---
    const acceptedBallots = new Map<string, { entryId: string; order: number }>();
    let ballotProposals = 0;
    for (const m of votes) {
      const o = json(m.text);
      if (o && str(o.type) === "sonnet.ballot.v1") ballotProposals++;
    }
    for (const r of parseReceipts(votes)) {
      if (!r.entryId || r.reason !== "" || !r.senderDid) continue;
      const prev = acceptedBallots.get(r.senderDid);
      const order = r.intakeSeq ?? 0;
      if (!prev || order >= prev.order) {
        acceptedBallots.set(r.senderDid, { entryId: r.entryId, order });
      }
    }
    const tally = new Map<string, number>();
    for (const b of acceptedBallots.values()) {
      tally.set(b.entryId, (tally.get(b.entryId) ?? 0) + 1);
    }

    // --- assemble teams ---
    const dict = await loadDict().catch(() => new Map<string, number>());
    const games = new Set<string>([...rostersByGame.keys(), ...entryByGame.keys(), ...submitByGame.keys()]);
    for (const gameId of games) {
      const roster = rostersByGame.get(gameId);
      const entry = entryByGame.get(gameId);
      const submit = submitByGame.get(gameId);
      teams.set(gameId, {
        gameId,
        poemRoom: roster?.poemRoom ?? `d-sonnet-2-team-${gameId}`,
        roomGeneration: roster?.roomGeneration ?? null,
        members: (roster?.members ?? []).map((did) => ({
          did,
          x: writers.get(did)?.x_account ?? null,
          words: 0,
        })),
        words: [],
        lines: [],
        complete: false,
        wordCount: 0,
        entryId: entry?.entryId ?? null,
        eligibility: entry?.eligibility ?? null,
        xPostIds: submit?.xPostIds ?? [],
        poemSha256: submit?.poemSha256 ?? null,
        votes: 0,
        lastAt: "",
        lastSeqByRoom: {},
      });
    }

    // --- read team rooms for teams with an entry (or a roster) ---
    const teamList = [...teams.values()];
    const withEntry = teamList.filter((t) => t.entryId);
    const toLoad = (withEntry.length > 0 ? withEntry : teamList).slice(0, 130);

    let cursor = 0;
    const worker = async () => {
      while (cursor < toLoad.length) {
        const team = toLoad[cursor++];
        try {
          const roomMessages = await readSonnetRoom(team.poemRoom).catch(() => [] as SonnetMessage[]);
          const proposals = new Map<string, { word: string; by: string }>();
          for (const m of roomMessages) {
            const o = json(m.text);
            if (!o || str(o.type) !== "sonnet.word.v1") continue;
            const requestId = str(o.request_id);
            const word = str(o.word);
            if (requestId && word) proposals.set(requestId, { word, by: m.from });
          }
          const accepted: { word: string; by: string; version: number }[] = [];
          let complete = false;
          for (const m of roomMessages) {
            if (m.from !== SONNET.referee) continue;
            const o = json(m.text);
            if (!o || str(o.type) !== "sonnet.receipt.v1") continue;
            if (str(o.reason) !== "" || str(o.status) !== "accepted") continue;
            const requestId = str(o.request_id);
            const p = proposals.get(requestId);
            const version = typeof o.version === "number" ? o.version : accepted.length + 1;
            if (p) accepted.push({ word: p.word, by: p.by, version });
            if (o.complete === true) complete = true;
          }
          accepted.sort((a, b) => a.version - b.version);
          team.words = accepted;
          team.wordCount = accepted.length;
          team.complete = complete;
          team.lines = reconstructLines(accepted.map((w) => w.word), dict);
          const counts = new Map<string, number>();
          for (const w of accepted) counts.set(w.by, (counts.get(w.by) ?? 0) + 1);
          team.members = team.members.map((mem) => ({ ...mem, words: counts.get(mem.did) ?? 0 }));
          const last = roomMessages[roomMessages.length - 1];
          team.lastAt = last?.ts ?? "";
          let maxSeq = 0;
          for (const m of roomMessages) if (m.seq > maxSeq) maxSeq = m.seq;
          team.lastSeqByRoom = { [team.poemRoom]: maxSeq };
        } catch {
          /* skip a bad room */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, toLoad.length) }, worker));

    // votes
    for (const team of teams.values()) {
      team.votes = team.entryId ? (tally.get(team.entryId) ?? 0) : 0;
    }

    const teamsArr = [...teams.values()].sort(
      (a, b) => b.votes - a.votes || b.wordCount - a.wordCount || a.gameId.localeCompare(b.gameId),
    );

    const data: SonnetOverview = {
      updatedAt: new Date().toISOString(),
      contest: {
        opening: SONNET.openMs,
        deadline: SONNET.closeMs,
        referee: SONNET.referee,
        status,
      },
      teams: teamsArr,
      totals: {
        teams: teamsArr.length,
        entries: teamsArr.filter((t) => t.entryId).length,
        ballots: ballotProposals,
        countedBallots: acceptedBallots.size,
        voters: acceptedBallots.size,
      },
      writersIndexed: writers.size,
    };
    overviewCache = { at: Date.now(), data };
    return data;
  })().finally(() => {
    overviewInflight = null;
  });
  return overviewInflight;
}

/** Rooms the live feed watches: shared rooms always, plus the busiest teams. */
export async function liveRooms(): Promise<string[]> {
  const shared = [
    SONNET.rooms.discovery,
    SONNET.rooms.campaign,
    SONNET.rooms.votes,
    SONNET.rooms.submissions,
    SONNET.rooms.registration,
  ];
  try {
    const overview = await loadSonnetOverview();
    const teams = overview.teams
      .slice()
      .sort((a, b) => (b.lastAt > a.lastAt ? 1 : -1))
      .slice(0, 12)
      .map((t) => t.poemRoom);
    return [...shared, ...teams];
  } catch {
    return shared;
  }
}
