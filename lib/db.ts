/**
 * Server-side statistics store on Neon.tech (PostgreSQL). Used ONLY by
 * server code: /api/track, /api/admin/*, /api/personalize, and the /admin
 * page. The client never talks to the database.
 *
 * Schema is created lazily on first use (idempotent), so a cold serverless
 * instance self-heals without a migration step.
 */

import { Pool } from "pg";

let pool: Pool | null = null;

function sanitizeConnString(cs: string): string {
  // pg forwards unknown URL params as postgres startup params, which Neon
  // rejects. Drop params this driver does not understand.
  try {
    const parsed = new URL(cs);
    parsed.searchParams.delete("channel_binding");
    parsed.searchParams.delete("channelbinding");
    return parsed.toString();
  } catch {
    return cs.replace(/&?channel_binding=[^&]*/i, "");
  }
}

function getPool(): Pool {
  const raw = process.env.DATABASE_URL ?? "";
  if (!raw) throw new Error("DATABASE_URL is not set");
  if (!pool) {
    const cs = sanitizeConnString(raw);
    pool = new Pool({
      connectionString: cs,
      ssl: cs.includes("sslmode=require") || cs.includes("sslmode=verify-full")
        ? { rejectUnauthorized: false }
        : undefined,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
    });
  }
  return pool;
}

/** Last DB failure (one line) so the dashboard can explain itself honestly. */
export let lastDbError: string | null = null;

export function clearDbError(): void {
  lastDbError = null;
}

let schemaReady = false;
let schemaPending: Promise<void> | null = null;

export async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  schemaPending ??= (async () => {
    const p = getPool();
    // Each statement is independent: a concurrent CREATE (IF NOT EXISTS is not
    // race-proof in Postgres) or a DDL hiccup must not leave the whole schema
    // half-applied and every later query failing.
    const run = async (sql: string) => {
      try {
        await p.query(sql);
      } catch {
        /* race or hiccup — other statements still apply */
      }
    };
    await run(`
      CREATE TABLE IF NOT EXISTS pageviews (
        id BIGSERIAL PRIMARY KEY,
        ip TEXT NOT NULL,
        path TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS dids (
        did TEXT PRIMARY KEY,
        ip TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS ai_generations (
        id BIGSERIAL PRIMARY KEY,
        ip TEXT,
        model TEXT,
        prompt_tokens INT,
        completion_tokens INT,
        total_tokens INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await run(`ALTER TABLE ai_generations ADD COLUMN IF NOT EXISTS did TEXT`);
    await run(`
      CREATE TABLE IF NOT EXISTS task_events (
        id BIGSERIAL PRIMARY KEY,
        did TEXT NOT NULL,
        category TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS trustcore_frames (
        hash TEXT PRIMARY KEY,
        room TEXT NOT NULL,
        seq BIGINT NOT NULL,
        did TEXT NOT NULL,
        frame_type TEXT NOT NULL,
        contract_id TEXT,
        offer_id TEXT,
        ref TEXT,
        amount TEXT,
        asset TEXT,
        role TEXT,
        outcome TEXT,
        rail TEXT,
        lock_kind TEXT,
        nonce TEXT,
        ts TEXT,
        raw_text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_tc_frames_did ON trustcore_frames (did)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_tc_frames_contract ON trustcore_frames (contract_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_tc_frames_created ON trustcore_frames (created_at)`);
    // Reveal preimages must survive the DB round-trip: buildDealStates only
    // marks a deal "claimed" when it can see the reveal secret.
    await run(`ALTER TABLE trustcore_frames ADD COLUMN IF NOT EXISTS secret TEXT`);
    // Deal rooms the app has seen — Trustcore scans these so a deal's
    // lock/reveal/receipt frames are picked up even after the offer+accept
    // scrolls out of the tclk-offers tail.
    await run(`
      CREATE TABLE IF NOT EXISTS trustcore_rooms (
        room TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Small key/value store for ingest bookkeeping (last successful scan time).
    await run(`
      CREATE TABLE IF NOT EXISTS trustcore_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Sonnet-2 writer registrations (public data) so pages can show each
    // writer's declared X account without rescanning the huge room each time.
    await run(`
      CREATE TABLE IF NOT EXISTS sonnet_writers (
        did TEXT PRIMARY KEY,
        role TEXT,
        x_account TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Every registration message (public), so reports never re-scan the huge
    // registration room — the ingest keeps this table up to date instead.
    await run(`
      CREATE TABLE IF NOT EXISTS sonnet_registrations (
        did TEXT NOT NULL,
        seq BIGINT NOT NULL,
        ts TEXT,
        role TEXT,
        request_id TEXT,
        receipt TEXT,
        reason TEXT,
        receipt_at TEXT,
        PRIMARY KEY (did, seq)
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_sonnet_reg_did ON sonnet_registrations (did)`);
    // Raw sonnet board messages (votes, submissions, discovery), so reports and
    // the overview never re-fetch the multi-MB room exports.
    await run(`
      CREATE TABLE IF NOT EXISTS sonnet_messages (
        room TEXT NOT NULL,
        seq BIGINT NOT NULL,
        ts TEXT,
        did TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (room, seq)
      )
    `);
    // Parsed ballots and their referee receipts: the hot path for reports and
    // personal status, so no 9 MB raw votes read is needed.
    await run(`
      CREATE TABLE IF NOT EXISTS sonnet_ballots (
        seq BIGINT PRIMARY KEY,
        ts TEXT,
        did TEXT NOT NULL,
        entry_id TEXT,
        request_id TEXT
      )
    `);
    // The votes room restarts its seq on each generation, so seq is NOT a
    // unique key across history — request_id is. Migrate the old PK away.
    await run(`ALTER TABLE sonnet_ballots DROP CONSTRAINT IF EXISTS sonnet_ballots_pkey`);
    await run(`ALTER TABLE sonnet_ballots ADD CONSTRAINT sonnet_ballots_request_key UNIQUE (request_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_sonnet_ballots_did ON sonnet_ballots (did)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_sonnet_ballots_request ON sonnet_ballots (request_id)`);
    await run(`
      CREATE TABLE IF NOT EXISTS sonnet_ballot_receipts (
        request_id TEXT NOT NULL,
        sender_did TEXT NOT NULL,
        entry_id TEXT,
        reason TEXT,
        intake_seq BIGINT,
        received_at DOUBLE PRECISION,
        PRIMARY KEY (request_id, sender_did)
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_sonnet_receipt_entry ON sonnet_ballot_receipts (entry_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_sonnet_receipt_sender ON sonnet_ballot_receipts (sender_did)`);
    // Sonnet-2 aggregate snapshot: pages load instantly from here while a
    // stale snapshot rebuilds in the background.
    await run(`
      CREATE TABLE IF NOT EXISTS sonnet_cache (
        key TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS ip_geo (
        ip TEXT PRIMARY KEY,
        country TEXT,
        country_code TEXT,
        region TEXT,
        city TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    schemaReady = true;
  })();
  await schemaPending;
}

export interface Row {
  [key: string]: unknown;
}

/** Best-effort query runner: null on any failure so telemetry never breaks UX. */
export async function safeQuery(sql: string, params: unknown[] = []): Promise<Row[] | null> {
  try {
    await ensureSchema();
  } catch (e) {
    lastDbError = (e as Error).message.slice(0, 240);
    return null;
  }
  try {
    const res = await getPool().query(sql, params);
    if (lastDbError) clearDbError();
    return res.rows as Row[];
  } catch (e) {
    lastDbError = (e as Error).message.slice(0, 240);
    return null;
  }
}

export async function safeExec(sql: string, params: unknown[] = []): Promise<void> {
  try {
    await ensureSchema();
    await getPool().query(sql, params);
    if (lastDbError) clearDbError();
  } catch (e) {
    /* never break the caller for a telemetry miss */
    lastDbError = (e as Error).message.slice(0, 240);
  }
}

export async function dbHealthy(): Promise<boolean> {
  const res = await safeQuery("SELECT 1 AS ok");
  return res !== null;
}