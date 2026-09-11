/**
 * Pro-panel telemetry — ONLY Pro-mode activity lives here (unlocks, failures,
 * locks, and limit-bypass events), so /proadmin tracks the Pro panel alone and
 * never mixes with the app-wide /admin stats.
 */

import { safeExec, safeQuery, type Row } from "./db";

export type ProEventKind = "unlock_ok" | "unlock_fail" | "lock" | "limit_bypass" | "auto_run";

export async function recordProEvent(ip: string, kind: ProEventKind, detail?: string): Promise<void> {
  await safeExec(
    "INSERT INTO pro_events (ip, kind, detail) VALUES ($1, $2, $3)",
    [ip, kind, detail ?? null],
  );
}

export interface ProOverview {
  unlocks: number;
  unlocksToday: number;
  unlocks30d: number;
  uniqueIps: number;
  failures: number;
  locks: number;
  bypasses: number;
  autoRuns: number;
  events: number;
}

export async function proOverview(): Promise<ProOverview> {
  const rows = (await safeQuery(
    `SELECT
       COUNT(*) FILTER (WHERE kind = 'unlock_ok') AS unlocks,
       COUNT(*) FILTER (WHERE kind = 'unlock_ok' AND created_at > date_trunc('day', now())) AS unlocks_today,
       COUNT(*) FILTER (WHERE kind = 'unlock_ok' AND created_at > now() - interval '30 days') AS unlocks_30d,
       COUNT(DISTINCT ip) FILTER (WHERE kind = 'unlock_ok') AS unique_ips,
       COUNT(*) FILTER (WHERE kind = 'unlock_fail') AS failures,
       COUNT(*) FILTER (WHERE kind = 'lock') AS locks,
       COUNT(*) FILTER (WHERE kind = 'limit_bypass') AS bypasses,
       COUNT(*) FILTER (WHERE kind = 'auto_run') AS auto_runs,
       COUNT(*) AS events
     FROM pro_events`,
  )) ?? [];
  const r = rows[0] ?? {};
  const n = (k: string) => Number(r[k] ?? 0) || 0;
  return {
    unlocks: n("unlocks"),
    unlocksToday: n("unlocks_today"),
    unlocks30d: n("unlocks_30d"),
    uniqueIps: n("unique_ips"),
    failures: n("failures"),
    locks: n("locks"),
    bypasses: n("bypasses"),
    autoRuns: n("auto_runs"),
    events: n("events"),
  };
}

export async function proRecent(limit = 50): Promise<Row[]> {
  return (
    (await safeQuery(
      `SELECT ip, kind, detail, created_at FROM pro_events ORDER BY created_at DESC LIMIT $1`,
      [limit],
    )) ?? []
  );
}

export async function proTopIps(limit = 12): Promise<Row[]> {
  return (
    (await safeQuery(
      `SELECT ip,
              COUNT(*) FILTER (WHERE kind = 'unlock_ok') AS unlocks,
              COUNT(*) FILTER (WHERE kind = 'limit_bypass') AS bypasses,
              COUNT(*) FILTER (WHERE kind = 'unlock_fail') AS failures,
              COUNT(*) AS events,
              MAX(created_at) AS last_seen
       FROM pro_events
       GROUP BY ip
       ORDER BY unlocks DESC, events DESC
       LIMIT $1`,
      [limit],
    )) ?? []
  );
}

export async function proBypassByFeature(): Promise<Row[]> {
  return (
    (await safeQuery(
      `SELECT COALESCE(detail, 'unknown') AS feature, COUNT(*) AS n
       FROM pro_events WHERE kind = 'limit_bypass'
       GROUP BY feature ORDER BY n DESC`,
    )) ?? []
  );
}
