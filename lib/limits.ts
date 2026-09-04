/**
 * Server-side fair-use limits (anti-spam). Client-side generation exists in
 * the browser by design, so these gates enforce the app's rules: a sync
 * check-and-record is the honest enforcement point for anything that passes
 * through this app. Import is intentionally unlimited.
 */

import { safeQuery, safeExec } from "./db";

export const DID_CREATE_MAX = 5;
export const DID_CREATE_WINDOW_DAYS = 30;
export const AI_GEN_MAX_PER_DAY = 3;
export const TASK_MAX_PER_DAY = 2;

export const MESSAGES = {
  did_create:
    "Identity creation limit reached: 5 DIDs per network (IP). Importing an existing backup is always free and unlimited.\n\nRunning many keys is not a credibility strategy, and it is not a path to eligibility. The community looks for one identity, kept honestly and steadily.",
  ai_generate:
    "Today's AI limit reached: 3 generations per identity per day.\n\nOriginal, thoughtful messages beat volume. Come back tomorrow for a fresh set.",
  task:
    "This check-in task is limited to 2 uses per identity per day.\n\nRooms stay healthy when they are not spammed. A calm, steady, honest presence is what keeps an identity credible; flooding a room does not help and does not create eligibility.",
} as const;

export type LimitKind = "did_create" | "ai_generate" | "task";

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  message?: string;
  code?: string;
}

export async function countDidCreates(ip: string): Promise<number> {
  const rows = await safeQuery(
    `SELECT COUNT(*) AS n FROM dids WHERE ip = $1 AND created_at > now() - interval '${DID_CREATE_WINDOW_DAYS} days'`,
    [ip],
  );
  return Number(rows?.[0]?.["n"] ?? 0);
}

export async function countAiToday(did: string): Promise<number> {
  const rows = await safeQuery(
    `SELECT COUNT(*) AS n FROM ai_generations WHERE did = $1 AND created_at > date_trunc('day', now())`,
    [did],
  );
  return Number(rows?.[0]?.["n"] ?? 0);
}

export async function countTaskToday(did: string, category: string): Promise<number> {
  const rows = await safeQuery(
    `SELECT COUNT(*) AS n FROM task_events WHERE did = $1 AND category = $2 AND created_at > date_trunc('day', now())`,
    [did, category],
  );
  return Number(rows?.[0]?.["n"] ?? 0);
}

export async function registerTask(did: string, category: string): Promise<void> {
  await safeExec("INSERT INTO task_events (did, category) VALUES ($1, $2)", [did, category]);
}

/** Check-only (no recording) for any limit kind. */
export async function checkLimit(kind: LimitKind, ip: string, did?: string, category?: string): Promise<LimitResult> {
  try {
    if (kind === "did_create") {
      const used = await countDidCreates(ip);
      const remaining = DID_CREATE_MAX - used;
      return remaining > 0
        ? { allowed: true, remaining }
        : { allowed: false, remaining: 0, message: MESSAGES.did_create, code: "did_limit" };
    }
    if (kind === "ai_generate") {
      if (!did) return { allowed: true, remaining: AI_GEN_MAX_PER_DAY };
      const used = await countAiToday(did);
      const remaining = AI_GEN_MAX_PER_DAY - used;
      return remaining > 0
        ? { allowed: true, remaining }
        : { allowed: false, remaining: 0, message: MESSAGES.ai_generate, code: "ai_limit" };
    }
    if (kind === "task") {
      if (!did || !category) return { allowed: false, remaining: 0, message: MESSAGES.task, code: "task_limit" };
      const used = await countTaskToday(did, category);
      const remaining = TASK_MAX_PER_DAY - used;
      return remaining > 0
        ? { allowed: true, remaining }
        : { allowed: false, remaining: 0, message: MESSAGES.task, code: "task_limit" };
    }
  } catch {
    /* DB down: never soft-block the user, proceed */
  }
  return { allowed: true, remaining: 999 };
}