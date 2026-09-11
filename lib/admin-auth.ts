/**
 * Server-side admin authentication.
 *
 *  - Password is checked with a constant-time comparison.
 *  - The session is a short signed token in an HttpOnly, SameSite=Lax,
 *    host-only cookie (domain-independent: works on any deployment URL).
 *  - Login attempts are rate limited per IP (brute-force guard). The limiter
 *    is in-memory per serverless instance: a best-effort, never a bypass.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "floptools_admin";
const PROADMIN_COOKIE_NAME = "floptools_proadmin";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "Nur1@2@3";
/** The pro admin panel shares the admin password unless overridden. */
export const PROADMIN_PASSWORD = process.env.PROADMIN_PASSWORD ?? ADMIN_PASSWORD;

/** Two independent panels: /admin and /proadmin. */
export type Panel = "admin" | "proadmin";

function baseSecret(): string {
  const env = process.env.ADMIN_COOKIE_SECRET;
  return env && env.length >= 16 ? env : ADMIN_PASSWORD + "::floptools-admin-cookie-v1";
}

function cookieSecret(panel: Panel): Buffer {
  const raw = panel === "admin" ? baseSecret() : `${baseSecret()}::floptools-proadmin-cookie-v1`;
  return createHash("sha256").update(raw).digest();
}

function sign(payload: string, panel: Panel): string {
  return createHmac("sha256", cookieSecret(panel)).update(payload).digest("base64url");
}

export function createSessionToken(panel: Panel = "admin"): { value: string; expiresInMs: number } {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${exp}.${randomBytes(16).toString("base64url")}`;
  return { value: `${payload}.${sign(payload, panel)}`, expiresInMs: SESSION_TTL_MS };
}

export function verifySessionToken(token: string | undefined, panel: Panel = "admin"): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expRaw, _jti, sig] = parts;
  const payload = `${expRaw}.${_jti}`;
  const expected = sign(payload, panel);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return true;
}

export const ADMIN_COOKIE = COOKIE_NAME;
export const PROADMIN_COOKIE = PROADMIN_COOKIE_NAME;

/** Constant-time password comparison. */
export function checkPassword(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Constant-time pro-admin password comparison (same pass unless overridden). */
export function checkProadminPassword(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(PROADMIN_PASSWORD);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ---- per-IP login rate limit (in-memory, best effort across instances) ---- */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const attempts = new Map<string, number[]>();

export function loginBlocked(ip: string): boolean {
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  attempts.set(ip, list);
  return list.length >= MAX_ATTEMPTS;
}

export function recordLoginAttempt(ip: string): void {
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  attempts.set(ip, list);
}

export function resetLoginAttempts(ip: string): void {
  attempts.delete(ip);
}