/**
 * Server-side Pro-mode authentication.
 *
 * Pro mode lifts the fair-use limits (identity creation, task/day, AI/day and
 * the per-IP scan throttles) for the unlocked browser only.
 *
 * Security posture:
 *  - The passcode lives only in the server env (`PRO_PASSCODE`) — never in the
 *    repository and never in the client bundle. Without it, Pro mode is
 *    closed by default; there is no built-in fallback.
 *  - Unlock sets a signed, HttpOnly, SameSite=Lax cookie. The HMAC secret is
 *    derived from the passcode, so a forged cookie cannot verify without it.
 *  - Unlock attempts are rate limited per IP (brute-force guard).
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "floptools_pro";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const PRO_COOKIE = COOKIE_NAME;

function passcode(): string {
  return process.env.PRO_PASSCODE ?? "";
}

export function proConfigured(): boolean {
  return passcode().length > 0;
}

function cookieSecret(): Buffer {
  const env = process.env.PRO_COOKIE_SECRET;
  const raw = env && env.length >= 16 ? env : `${passcode()}::floptools-pro-cookie-v1`;
  return createHash("sha256").update(raw).digest();
}

function sign(payload: string): string {
  return createHmac("sha256", cookieSecret()).update(payload).digest("base64url");
}

export function createProToken(): { value: string; expiresInMs: number } {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${exp}.${randomBytes(16).toString("base64url")}`;
  return { value: `${payload}.${sign(payload)}`, expiresInMs: SESSION_TTL_MS };
}

export function verifyProToken(token: string | undefined): boolean {
  if (!token || !proConfigured()) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expRaw, jti, sig] = parts;
  const payload = `${expRaw}.${jti}`;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  const exp = Number(expRaw);
  return Number.isFinite(exp) && exp > Date.now();
}

/** Constant-time passcode comparison. */
export function checkProPasscode(candidate: string): boolean {
  const pass = passcode();
  if (!pass || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(pass);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Server-side truth for every limit gate: is this request in Pro mode? */
export function isProRequest(req: {
  cookies: { get(name: string): { value: string } | undefined };
}): boolean {
  return verifyProToken(req.cookies.get(COOKIE_NAME)?.value);
}

/* ---- per-IP unlock rate limit (in-memory, best effort across instances) ---- */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const attempts = new Map<string, number[]>();

export function unlockBlocked(ip: string): boolean {
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  attempts.set(ip, list);
  return list.length >= MAX_ATTEMPTS;
}

export function recordUnlockAttempt(ip: string): void {
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  attempts.set(ip, list);
}

export function resetUnlockAttempts(ip: string): void {
  attempts.delete(ip);
}
