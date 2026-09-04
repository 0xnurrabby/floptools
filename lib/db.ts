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
    await p.query(`
      CREATE TABLE IF NOT EXISTS pageviews (
        id BIGSERIAL PRIMARY KEY,
        ip TEXT NOT NULL,
        path TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query(`
      CREATE TABLE IF NOT EXISTS dids (
        did TEXT PRIMARY KEY,
        ip TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query(`
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
    await p.query(`ALTER TABLE ai_generations ADD COLUMN IF NOT EXISTS did TEXT`);
    await p.query(`
      CREATE TABLE IF NOT EXISTS task_events (
        id BIGSERIAL PRIMARY KEY,
        did TEXT NOT NULL,
        category TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await p.query(`
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
    await p.query(`CREATE INDEX IF NOT EXISTS idx_tc_frames_did ON trustcore_frames (did)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_tc_frames_contract ON trustcore_frames (contract_id)`);
    await p.query(`CREATE INDEX IF NOT EXISTS idx_tc_frames_created ON trustcore_frames (created_at)`);
    await p.query(`
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