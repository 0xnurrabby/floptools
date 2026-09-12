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
  /** Accepted words in order (version 1..n), with the contributor's submit time. */
  words: { word: string; by: string; version: number; ts?: string }[];
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
  /** When this snapshot was computed (present on cached reads). */
  cachedAt?: string;
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
  /** Always-computed registry counts (DB index), so numbers are never empty. */
  participants: { writers: number; voters: number; organizers: number };
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
  receivedAt?: number;
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
        receivedAt: typeof o.received_at === "number" ? o.received_at : undefined,
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

export interface StoredRegistration {
  seq: number;
  ts: string;
  role: string;
  requestId: string;
  receipt: "accepted" | "rejected" | "pending";
  reason: string | null;
  receiptAt: string | null;
}

/** Registration history for a set of DIDs, straight from the DB index. */
export async function registrationsForDids(
  dids: string[],
): Promise<Map<string, StoredRegistration[]>> {
  const map = new Map<string, StoredRegistration[]>();
  if (dids.length === 0) return map;
  const rows =
    (await safeQuery(
      `SELECT did, seq, ts, role, request_id, receipt, reason, receipt_at
       FROM sonnet_registrations WHERE did = ANY($1::text[]) ORDER BY seq ASC`,
      [dids.slice(0, 400)],
    )) ?? [];
  for (const r of rows) {
    const did = String(r["did"] ?? "");
    if (!did) continue;
    const list = map.get(did) ?? [];
    list.push({
      seq: Number(r["seq"] ?? 0),
      ts: String(r["ts"] ?? ""),
      role: String(r["role"] ?? ""),
      requestId: String(r["request_id"] ?? ""),
      receipt: String(r["receipt"] ?? "pending") as StoredRegistration["receipt"],
      reason: (r["reason"] as string) || null,
      receiptAt: (r["receipt_at"] as string) ?? null,
    });
    map.set(did, list);
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
async function ingestWriters(fresh = false): Promise<WriterRefreshInfo> {
  if (writerIngest) return writerIngest;
  writerIngest = (async (): Promise<WriterRefreshInfo> => {
    const info: WriterRefreshInfo = { parsed: 0, inserted: 0 };
    try {
      // A just-posted registration must be visible immediately, so an explicit
      // refresh bypasses the room snapshot cache.
      const messages = await readSonnetRoom(SONNET.rooms.registration, { fresh });
      const regReceipts = parseReceipts(messages);
      const rows: { did: string; role: string; x: string | null }[] = [];
      const seen = new Set<string>();
      const events: {
        did: string;
        seq: number;
        ts: string;
        role: string;
        requestId: string;
        receipt: string;
        reason: string;
        receiptAt: string | null;
      }[] = [];
      for (const m of messages) {
        const o = json(m.text);
        if (!o || str(o.type) !== "sonnet.register.v1") continue;
        if (str(o.contest_id) !== SONNET.contestId) continue;
        const role = str(o.role);
        if (role !== "writer" && role !== "voter" && role !== "organizer") continue;
        const requestId = str(o.request_id);
        if (requestId) {
          const r = regReceipts.find((x) => x.requestId === requestId && x.senderDid === m.from);
          events.push({
            did: m.from,
            seq: m.seq,
            ts: m.ts,
            role,
            requestId,
            receipt: r ? (r.reason ? "rejected" : "accepted") : "pending",
            reason: r?.reason ?? "",
            receiptAt: r?.receivedAt ? new Date(r.receivedAt * 1000).toISOString() : null,
          });
        }
        if (seen.has(m.from)) continue;
        seen.add(m.from);
        rows.push({
          did: m.from,
          role,
          x: role === "writer" ? str(o.x_account_url) || null : null,
        });
      }
      info.parsed = rows.length;
      // Every registration message, kept in the DB so reports and status reads
      // never have to scan the (multi-MB) registration room again.
      for (let i = 0; i < events.length; i += 200) {
        const chunk = events.slice(i, i + 200);
        const values: unknown[] = [];
        const placeholders = chunk.map((e, j) => {
          values.push(e.did, e.seq, e.ts, e.role, e.requestId, e.receipt, e.reason, e.receiptAt);
          const b = j * 8;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
        });
        await safeExec(
          `INSERT INTO sonnet_registrations (did, seq, ts, role, request_id, receipt, reason, receipt_at)
           VALUES ${placeholders.join(",")}
           ON CONFLICT (did, seq) DO UPDATE SET receipt = EXCLUDED.receipt, reason = EXCLUDED.reason, receipt_at = EXCLUDED.receipt_at`,
          values,
        );
      }
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const values: unknown[] = [];
        const placeholders = chunk.map((r, j) => {
          values.push(r.did, r.role, r.x);
          return `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`;
        });
        await safeExec(
          `INSERT INTO sonnet_writers (did, role, x_account)
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

/** Await a writer-index refresh (used by explicit ?writers=1 / ?refresh=1). */
export async function refreshWriters(opts: { fresh?: boolean } = {}): Promise<WriterRefreshInfo> {
  return ingestWriters(opts.fresh === true);
}

export interface MyBallot {
  entryId: string;
  requestId: string;
  roomSeq: number;
  ts: string;
  status: "accepted" | "rejected" | "pending";
  reason: string | null;
  receiptAt: string | null;
  intakeSeq: number | null;
}

export interface MyEntryDetail {
  gameId: string;
  entryId: string;
  poemRoom: string;
  members: { did: string; x: string | null; words: number }[];
  lines: string[];
  complete: boolean;
  wordCount: number;
  eligibility: string | null;
  xPostIds: string[];
  poemSha256: string | null;
  votes: number;
  rank: number;
  entries: number;
  lastAt: string;
}

export interface MySonnetStatus {
  did: string;
  registered: { role: string; x: string | null } | null;
  /** The referee receipt for this DID's registration (from the room itself). */
  registrationReceipt: {
    status: "accepted" | "rejected" | "pending";
    reason: string | null;
    at: string | null;
    requestId: string;
  } | null;
  /** The effective (latest) ballot — the one that counts. */
  ballot: MyBallot | null;
  /** Every ballot this DID has cast, newest first. */
  history: MyBallot[];
  entry: {
    gameId: string;
    entryId: string;
    votes: number;
    rank: number;
    entries: number;
    xPostIds: string[];
  } | null;
  entryDetail: MyEntryDetail | null;
}

/** The connected identity's own sonnet-2 status: registration + ballots. */
export async function mySonnetStatus(did: string): Promise<MySonnetStatus> {
  const [regRows, storedRegs, voteMessages, overview] = await Promise.all([
    safeQuery("SELECT role, x_account FROM sonnet_writers WHERE did = $1", [did]).catch(() => null),
    registrationsForDids([did]).catch(() => new Map<string, StoredRegistration[]>()),
    readSonnetRoom(SONNET.rooms.votes).catch(() => [] as SonnetMessage[]),
    loadSonnetOverview().catch(() => null),
  ]);

  // Registration from the DB index (the ingest keeps it up to date; the
  // register flow forces a fresh ingest). No multi-MB room scan here.
  const events = storedRegs.get(did) ?? [];
  const last = events.length > 0 ? events[events.length - 1]! : null;
  const reg = regRows?.[0];
  let registrationReceipt: MySonnetStatus["registrationReceipt"] = null;
  let registered: MySonnetStatus["registered"] = null;
  if (last) {
    registrationReceipt = {
      requestId: last.requestId,
      status: last.receipt,
      reason: last.reason,
      at: last.receiptAt,
    };
    registered = {
      role: last.role,
      x: last.role === "writer" ? ((reg?.["x_account"] as string) ?? null) : null,
    };
  } else if (reg) {
    // Index has the role but not the message rows yet (older cycle).
    registered = { role: String(reg["role"] ?? ""), x: (reg["x_account"] as string) ?? null };
  }

  const receipts = parseReceipts(voteMessages);
  const mine: MyBallot[] = [];
  for (const m of voteMessages) {
    if (m.from !== did) continue;
    const o = json(m.text);
    if (!o || str(o.type) !== "sonnet.ballot.v1") continue;
    const entryId = str(o.entry_id);
    const requestId = str(o.request_id);
    if (!entryId || !requestId) continue;
    const r = receipts.find((x) => x.requestId === requestId && x.senderDid === did);
    mine.push({
      entryId,
      requestId,
      roomSeq: m.seq,
      ts: m.ts,
      status: r ? (r.reason ? "rejected" : "accepted") : "pending",
      reason: r?.reason ?? null,
      receiptAt: r?.receivedAt ? new Date(r.receivedAt * 1000).toISOString() : null,
      intakeSeq: r?.intakeSeq ?? null,
    });
  }
  mine.sort((a, b) => b.roomSeq - a.roomSeq);
  const ballot = mine[0] ?? null;

  let entry: MySonnetStatus["entry"] = null;
  let entryDetail: MyEntryDetail | null = null;
  if (ballot && overview) {
    const ranked = overview.teams.filter((t) => t.entryId);
    const idx = ranked.findIndex((t) => t.entryId === ballot.entryId);
    if (idx >= 0) {
      const t = ranked[idx]!;
      entry = {
        gameId: t.gameId,
        entryId: t.entryId!,
        votes: t.votes,
        rank: idx + 1,
        entries: ranked.length,
        xPostIds: t.xPostIds,
      };
      entryDetail = {
        gameId: t.gameId,
        entryId: t.entryId!,
        poemRoom: t.poemRoom,
        members: t.members,
        lines: t.lines,
        complete: t.complete,
        wordCount: t.wordCount,
        eligibility: t.eligibility,
        xPostIds: t.xPostIds,
        poemSha256: t.poemSha256,
        votes: t.votes,
        rank: idx + 1,
        entries: ranked.length,
        lastAt: t.lastAt,
      };
    }
  }

  return { did, registered, registrationReceipt, ballot, history: mine, entry, entryDetail };
}

/** Force a fresh registration-room read + index write (right after registering). */
export async function refreshRegistration(): Promise<void> {
  await readSonnetRoom(SONNET.rooms.registration, { fresh: true });
  await ingestWriters();
}

/* ---------------- voter report (who voted, and rug signals) ---------------- */

export interface VoterRegEvent {
  seq: number;
  ts: string;
  role: string;
  requestId: string;
  receipt: "accepted" | "rejected" | "pending";
  reason: string | null;
}

export interface VoterBallotEvent {
  entryId: string;
  seq: number;
  ts: string;
  requestId: string;
  status: "accepted" | "rejected" | "pending";
  reason: string | null;
}

export interface VoterReportVoter {
  did: string;
  ballotSeq: number;
  ballotTs: string;
  ballotRequestId: string;
  voteAt: string | null;
  intakeSeq: number | null;
  regSeq: number | null;
  regTs: string | null;
  regRequestId: string | null;
  regRole: string | null;
  regReceipt: "accepted" | "rejected" | "pending" | null;
  regReceiptAt: string | null;
  regToVoteMs: number | null;
  tag: string;
  flags: string[];
  /** Every registration this DID signed, oldest first. */
  registrations: VoterRegEvent[];
  /** Every ballot this DID signed, oldest first. */
  ballots: VoterBallotEvent[];
}

export interface VoterReportSignal {
  kind: string;
  severity: "high" | "medium" | "info";
  label: string;
  detail: string;
  dids: string[];
}

export interface VoterReport {
  entryId: string;
  gameId: string | null;
  poemRoom: string | null;
  votes: number;
  voters: VoterReportVoter[];
  /** The poem's accepted words with their contributor and submit time. */
  words: { word: string; by: string; version: number; ts?: string }[];
  signals: VoterReportSignal[];
  risk: { score: number; level: "low" | "notable" | "high"; summary: string };
  span: { startMs: number; endMs: number };
  generatedAt: string;
}

/** The meaningful part of a request id: producer tag before the first number. */
function requestTag(requestId: string): string {
  const parts = requestId.split(/[-_.]/);
  const keep: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (/^\d+$/.test(p) || /^[0-9a-f]{8,}$/i.test(p) || p.length > 16) break;
    keep.push(p.toLowerCase());
    if (keep.length >= 3) break;
  }
  return keep.join("-");
}

const voterReportCache = new Map<string, { at: number; report: VoterReport }>();
const VOTER_REPORT_TTL_MS = 60_000;

export async function entryVoterReport(entryId: string): Promise<VoterReport> {
  const hit = voterReportCache.get(entryId);
  if (hit && Date.now() - hit.at < VOTER_REPORT_TTL_MS) return hit.report;

  const [voteMessages, overview] = await Promise.all([
    readSonnetRoom(SONNET.rooms.votes).catch(() => [] as SonnetMessage[]),
    loadSonnetOverview().catch(() => null),
  ]);

  // Effective ballots for this entry: each voter's LAST accepted ballot.
  const accepted = new Map<string, { entryId: string; requestId: string; seq: number; ts: string; intakeSeq: number | null; voteAt: string | null }>();
  for (const r of parseReceipts(voteMessages)) {
    if (!r.entryId || r.reason !== "" || !r.senderDid) continue;
    const prev = accepted.get(r.senderDid);
    const order = r.intakeSeq ?? 0;
    if (prev && order < (prev.intakeSeq ?? 0)) continue;
    const proposal = voteMessages.find(
      (m) => m.from === r.senderDid && str(json(m.text)?.request_id) === r.requestId,
    );
    accepted.set(r.senderDid, {
      entryId: r.entryId,
      requestId: r.requestId,
      seq: proposal?.seq ?? 0,
      ts: proposal?.ts ?? "",
      intakeSeq: r.intakeSeq ?? null,
      voteAt: r.receivedAt ? new Date(r.receivedAt * 1000).toISOString() : (proposal?.ts ?? null),
    });
  }
  const mine = [...accepted.entries()].filter(([, b]) => b.entryId === entryId);

  // Registration history straight from the DB index (no room scan).
  const storedRegs = await registrationsForDids(mine.map(([did]) => did)).catch(
    () => new Map<string, StoredRegistration[]>(),
  );
  const regByDid = new Map<string, StoredRegistration>();
  const regsByDid = new Map<string, VoterRegEvent[]>();
  for (const [voterDid, list] of storedRegs) {
    if (list.length === 0) continue;
    regByDid.set(voterDid, list[list.length - 1]!);
    regsByDid.set(
      voterDid,
      list.map((e) => ({
        seq: e.seq,
        ts: e.ts,
        role: e.role,
        requestId: e.requestId,
        receipt: e.receipt,
        reason: e.reason,
      })),
    );
  }
  const ballotsByDid = new Map<string, VoterBallotEvent[]>();
  for (const m of voteMessages) {
    const o = json(m.text);
    if (!o || str(o.type) !== "sonnet.ballot.v1") continue;
    const entryId = str(o.entry_id);
    const requestId = str(o.request_id);
    if (!entryId || !requestId) continue;
    const rr = parseReceipts(voteMessages).find((x) => x.requestId === requestId && x.senderDid === m.from);
    const list = ballotsByDid.get(m.from) ?? [];
    list.push({
      entryId,
      seq: m.seq,
      ts: m.ts,
      requestId,
      status: rr ? (rr.reason ? "rejected" : "accepted") : "pending",
      reason: rr?.reason ?? null,
    });
    ballotsByDid.set(m.from, list);
  }
  for (const list of regsByDid.values()) list.sort((a, b) => a.seq - b.seq);
  for (const list of ballotsByDid.values()) list.sort((a, b) => a.seq - b.seq);

  const voters: VoterReportVoter[] = mine.map(([did, b]) => {
    const reg = regByDid.get(did) ?? null;
    const voteMs = b.voteAt ? Date.parse(b.voteAt) : NaN;
    const regMs = reg?.ts ? Date.parse(reg.ts) : NaN;
    return {
      did,
      ballotSeq: b.seq,
      ballotTs: b.ts,
      ballotRequestId: b.requestId,
      voteAt: b.voteAt,
      intakeSeq: b.intakeSeq,
      regSeq: reg?.seq ?? null,
      regTs: reg?.ts ?? null,
      regRequestId: reg?.requestId ?? null,
      regRole: reg?.role ?? null,
      regReceipt: reg ? reg.receipt : null,
      regReceiptAt: reg?.receiptAt ?? null,
      regToVoteMs:
        Number.isFinite(voteMs) && Number.isFinite(regMs) && voteMs >= regMs ? voteMs - regMs : null,
      tag: requestTag(b.requestId),
      flags: [],
      registrations: regsByDid.get(did) ?? [],
      ballots: ballotsByDid.get(did) ?? [],
    };
  });

  const signals: VoterReportSignal[] = [];

  // 1) Votes that landed inside a tight window.
  const byTime = voters
    .filter((v) => v.voteAt)
    .slice()
    .sort((a, b) => Date.parse(a.voteAt!) - Date.parse(b.voteAt!));
  const clusters: VoterReportVoter[][] = [];
  let current: VoterReportVoter[] = [];
  for (const v of byTime) {
    if (current.length === 0) {
      current = [v];
      continue;
    }
    const gap = Date.parse(v.voteAt!) - Date.parse(current[current.length - 1]!.voteAt!);
    if (gap <= 120_000) {
      current.push(v);
    } else {
      if (current.length >= 2) clusters.push(current);
      current = [v];
    }
  }
  if (current.length >= 2) clusters.push(current);
  const tight = clusters.filter((c) => c.length >= 3);
  for (const c of tight) {
    const start = Date.parse(c[0]!.voteAt!);
    const end = Date.parse(c[c.length - 1]!.voteAt!);
    const secs = Math.round((end - start) / 1000);
    const dids = c.map((v) => v.did);
    for (const v of c) v.flags.push("vote-cluster");
    signals.push({
      kind: "vote-cluster",
      severity: c.length >= 5 || secs <= 30 ? "high" : "medium",
      label: `${c.length} votes within ${secs}s`,
      detail: `Ballots for this entry were receipted inside a ${secs}-second window (${c.length} voters). Honest campaigns can also land together, but a tight burst is the classic pattern of one operator fanning out.`,
      dids,
    });
  }

  // 2) Shared request-id tags (same producer signature).
  const byTag = new Map<string, VoterReportVoter[]>();
  for (const v of voters) {
    if (!v.tag || v.tag.length < 4) continue;
    const list = byTag.get(v.tag) ?? [];
    list.push(v);
    byTag.set(v.tag, list);
  }
  for (const [tag, group] of byTag) {
    if (group.length < 2) continue;
    for (const v of group) v.flags.push("same-tag");
    signals.push({
      kind: "same-tag",
      severity: group.length >= 4 ? "high" : "medium",
      label: `${group.length} ballots share the request tag "${tag}"`,
      detail:
        "The request id is chosen by the voter's tool. Several different DIDs using the same tag strongly suggests one operator or one script prepared all of them.",
      dids: group.map((v) => v.did),
    });
  }

  // 3) Registrations in the same burst (adjacent seqs / same window).
  const byReg = voters
    .filter((v) => v.regSeq !== null && v.regTs)
    .slice()
    .sort((a, b) => (a.regSeq ?? 0) - (b.regSeq ?? 0));
  const regGroups: VoterReportVoter[][] = [];
  let regCur: VoterReportVoter[] = [];
  for (const v of byReg) {
    if (regCur.length === 0) {
      regCur = [v];
      continue;
    }
    const prevV = regCur[regCur.length - 1]!;
    const seqGap = (v.regSeq ?? 0) - (prevV.regSeq ?? 0);
    const timeGap = Date.parse(v.regTs!) - Date.parse(prevV.regTs!);
    if (seqGap <= 5 || timeGap <= 120_000) {
      regCur.push(v);
    } else {
      if (regCur.length >= 2) regGroups.push(regCur);
      regCur = [v];
    }
  }
  if (regCur.length >= 2) regGroups.push(regCur);
  for (const g of regGroups.filter((x) => x.length >= 3)) {
    for (const v of g) v.flags.push("reg-burst");
    signals.push({
      kind: "reg-burst",
      severity: g.length >= 5 ? "high" : "medium",
      label: `${g.length} voter DIDs registered back-to-back`,
      detail:
        "These identities were registered within a few ledger slots of each other — the fingerprint of wallets being created in one batch.",
      dids: g.map((v) => v.did),
    });
  }

  // 4) Rushed onboarding: registered minutes before voting.
  const fresh = voters.filter((v) => v.regToVoteMs !== null && v.regToVoteMs <= 15 * 60_000);
  if (fresh.length >= 2) {
    for (const v of fresh) v.flags.push("fresh-did");
    const shortest = Math.round(Math.min(...fresh.map((v) => v.regToVoteMs!)) / 60_000);
    signals.push({
      kind: "fresh-did",
      severity: fresh.length >= 4 ? "medium" : "info",
      label: `${fresh.length} DIDs voted within 15 min of registering`,
      detail: `The fastest gap was about ${shortest || 1} minute(s). A genuine supporter can be quick, but many rushed DIDs together usually mean one operator.`,
      dids: fresh.map((v) => v.did),
    });
  }

  const clusterMax = tight.reduce((n, c) => Math.max(n, c.length), 0);
  const tagMax = [...byTag.values()].reduce((n, g) => Math.max(n, g.length), 0);
  const regMax = regGroups.reduce((n, g) => Math.max(n, g.length), 0);
  let score = 0;
  if (tagMax >= 2) score += Math.min(40, (tagMax - 1) * 15);
  if (clusterMax >= 3) score += Math.min(30, (clusterMax - 2) * 10);
  if (regMax >= 3) score += Math.min(18, (regMax - 2) * 6);
  score += Math.min(20, fresh.length * 5);
  score = Math.max(0, Math.min(100, score));
  const level = score >= 50 ? "high" : score >= 20 ? "notable" : "low";
  const summary =
    level === "low"
      ? voters.length === 0
        ? "No counted voters yet."
        : `${voters.length} counted voter${voters.length === 1 ? "" : "s"} — no meaningful clustering detected in their registration or vote timing.`
      : [
          tagMax >= 2 ? `${tagMax} ballots share one request tag` : null,
          clusterMax >= 3 ? `${clusterMax} votes landed inside a tight window` : null,
          regMax >= 3 ? `${regMax} DIDs registered back-to-back` : null,
          fresh.length >= 2 ? `${fresh.length} voted within 15 min of registering` : null,
        ]
          .filter(Boolean)
          .join("; ")
          .replace(/^./, (c) => c.toUpperCase()) +
        ". Treat this as a signal to inspect, not proof — the referee decides conduct cases.";

  const times = voters.map((v) => Date.parse(v.voteAt ?? v.ballotTs)).filter((n) => Number.isFinite(n));
  const span = {
    startMs: times.length ? Math.min(...times) : Date.now(),
    endMs: times.length ? Math.max(...times) : Date.now(),
  };

  const team = overview?.teams.find((t) => t.entryId === entryId) ?? null;
  const report: VoterReport = {
    entryId,
    gameId: team?.gameId ?? null,
    poemRoom: team?.poemRoom ?? null,
    votes: voters.length,
    voters: voters.slice().sort((a, b) => Date.parse(a.voteAt ?? a.ballotTs) - Date.parse(b.voteAt ?? b.ballotTs)),
    words: (team?.words ?? []).map((w) => ({ word: w.word, by: w.by, version: w.version, ts: w.ts })),
    signals,
    risk: { score, level, summary },
    span,
    generatedAt: new Date().toISOString(),
  };
  voterReportCache.set(entryId, { at: Date.now(), report });
  return report;
}

/* ---------------- the aggregate ---------------- */

let overviewCache: { at: number; data: SonnetOverview } | null = null;
let overviewInflight: Promise<SonnetOverview> | null = null;
const OVERVIEW_TTL_MS = 60_000;
const DB_CACHE_KEY = "overview";

export function sonnetOverviewCached(): SonnetOverview | null {
  return overviewCache?.data ?? null;
}

async function readDbSnapshot(): Promise<{ at: number; data: SonnetOverview } | null> {
  const rows =
    (await safeQuery("SELECT data, updated_at FROM sonnet_cache WHERE key = $1", [DB_CACHE_KEY])) ?? [];
  const r = rows[0];
  if (!r || !r["data"]) return null;
  const at = r["updated_at"] ? Date.parse(String(r["updated_at"])) : 0;
  const data = r["data"] as SonnetOverview;
  if (!data || typeof data !== "object" || !Array.isArray(data.teams)) return null;
  return { at, data: { ...data, cachedAt: Number.isFinite(at) ? new Date(at).toISOString() : undefined } };
}

async function writeDbSnapshot(data: SonnetOverview): Promise<void> {
  await safeExec(
    `INSERT INTO sonnet_cache (key, data, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [DB_CACHE_KEY, JSON.stringify(data)],
  );
}

function rebuildSnapshot(): Promise<SonnetOverview> {
  if (overviewInflight) return overviewInflight;
  overviewInflight = (async () => {
    const previous = overviewCache?.data ?? (await readDbSnapshot().catch(() => null))?.data ?? null;
    const data = await buildOverview();
    // A room read can fail transiently; never let a reduced snapshot replace a
    // more complete one (the next cycle retries).
    const degraded =
      previous !== null &&
      (data.teams.length === 0 ||
        (data.totals.entries === 0 && previous.totals.entries > 0) ||
        data.totals.entries < Math.floor(previous.totals.entries / 2) ||
        data.teams.length < Math.floor(previous.teams.length / 2));
    if (degraded && previous) {
      overviewCache = { at: Date.now(), data: previous };
      return previous;
    }
    overviewCache = { at: Date.now(), data };
    await writeDbSnapshot(data);
    return data;
  })().finally(() => {
    overviewInflight = null;
  });
  return overviewInflight;
}

/**
 * Instant-first: a warm snapshot (DB or instance) is served immediately; a
 * stale one is served while a fresh build runs in the background. `fresh:true`
 * awaits the rebuild (Refresh button).
 */
export async function loadSonnetOverview(opts: { fresh?: boolean } = {}): Promise<SonnetOverview> {
  const now = Date.now();
  if (!opts.fresh && overviewCache && now - overviewCache.at < OVERVIEW_TTL_MS) {
    return overviewCache.data;
  }
  if (opts.fresh) return rebuildSnapshot();

  const dbCached = await readDbSnapshot().catch(() => null);
  if (dbCached) {
    overviewCache = { at: dbCached.at, data: dbCached.data };
    if (now - dbCached.at >= OVERVIEW_TTL_MS) {
      void rebuildSnapshot().catch(() => {});
    }
    return dbCached.data;
  }
  return rebuildSnapshot();
}

async function buildOverview(): Promise<SonnetOverview> {
  return (async () => {
    const [rules, discovery, votes, submissions, writers, roleRows] = await Promise.all([
      readSonnetRoom(SONNET.rooms.rules).catch(() => [] as SonnetMessage[]),
      readSonnetRoom(SONNET.rooms.discovery).catch(() => [] as SonnetMessage[]),
      readSonnetRoom(SONNET.rooms.votes).catch(() => [] as SonnetMessage[]),
      readSonnetRoom(SONNET.rooms.submissions).catch(() => [] as SonnetMessage[]),
      writersFromDb().catch(() => new Map<string, WriterRow>()),
      safeQuery("SELECT role, COUNT(*) AS n FROM sonnet_writers GROUP BY role").catch(() => null),
    ]);
    const participants = { writers: 0, voters: 0, organizers: 0 };
    for (const r of roleRows ?? []) {
      const role = String(r["role"] ?? "");
      const n = Number(r["n"] ?? 0);
      if (role === "writer") participants.writers = n;
      else if (role === "voter") participants.voters = n;
      else if (role === "organizer") participants.organizers = n;
    }

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
          const proposals = new Map<string, { word: string; by: string; ts: string }>();
          for (const m of roomMessages) {
            const o = json(m.text);
            if (!o || str(o.type) !== "sonnet.word.v1") continue;
            const requestId = str(o.request_id);
            const word = str(o.word);
            if (requestId && word) proposals.set(requestId, { word, by: m.from, ts: m.ts });
          }
          const accepted: { word: string; by: string; version: number; ts?: string }[] = [];
          let complete = false;
          for (const m of roomMessages) {
            if (m.from !== SONNET.referee) continue;
            const o = json(m.text);
            if (!o || str(o.type) !== "sonnet.receipt.v1") continue;
            if (str(o.reason) !== "" || str(o.status) !== "accepted") continue;
            const requestId = str(o.request_id);
            const p = proposals.get(requestId);
            const version = typeof o.version === "number" ? o.version : accepted.length + 1;
            if (p) accepted.push({ word: p.word, by: p.by, version, ts: p.ts });
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

    // The referee status is authoritative when present, but never allow empty
    // numbers: fall back to the registry index and the team list.
    if (status) {
      if (!status.teams) status.teams = teamsArr.length;
      if (!status.writers) status.writers = participants.writers;
      if (!status.voters) status.voters = participants.voters;
      if (!status.organizers) status.organizers = participants.organizers;
    } else {
      status = {
        accepted: 0,
        rejected: 0,
        teams: teamsArr.length,
        writers: participants.writers,
        voters: participants.voters,
        organizers: participants.organizers,
        rooms: [],
      };
    }

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
      participants,
      writersIndexed: writers.size,
    };
    return data;
  })();
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
