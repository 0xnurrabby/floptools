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

function getPool(): Pool {
  const cs = process.env.DATABASE_URL ?? "";
  if (!cs) throw new Error("DATABASE_URL is not set");
  if (!pool) {
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
  } catch {
    return null;
  }
  try {
    const res = await getPool().query(sql, params);
    return res.rows as Row[];
  } catch {
    return null;
  }
}

export async function safeExec(sql: string, params: unknown[] = []): Promise<void> {
  try {
    await ensureSchema();
    await getPool().query(sql, params);
  } catch {
    /* never break the caller for a telemetry miss */
  }
}