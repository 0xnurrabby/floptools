"use client";

/**
 * Browser-side snapshot cache for the sonnet overview. The server serves a
 * warm snapshot instantly and heals in the background, but a cold instance
 * (or live-ledger mode during a database outage) can take seconds to build.
 * Keeping the last good payload in this browser means a repeat visit paints
 * immediately and then swaps in fresh data when it arrives.
 */

const KEY = "sonnet.overview.cache.v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function loadOverviewCache<T = unknown>(): T | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; data: T };
    if (!parsed || typeof parsed.at !== "number" || !parsed.data) return null;
    if (Date.now() - parsed.at > MAX_AGE_MS) return null;
    const teams = (parsed.data as { teams?: unknown }).teams;
    if (!Array.isArray(teams)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function saveOverviewCache(data: unknown): void {
  try {
    if (typeof localStorage === "undefined") return;
    const teams = (data as { teams?: unknown } | null)?.teams;
    if (!Array.isArray(teams) || teams.length === 0) return;
    localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* quota or blocked: caching is best effort */
  }
}
