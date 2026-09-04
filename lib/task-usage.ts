/**
 * Per-slot task usage (which activity templates were already used).
 * Stored locally only; used to flip a template's Use button to "Used".
 */

const KEY = "floptools.tasks-used";
const EVENT = "floptools:tasks-used";

export const EMPTY_USAGE: Record<string, number> = {};

let parsed: { raw: string; map: Record<string, number> } | null = null;

function read(): Record<string, number> {
  if (typeof window === "undefined") return EMPTY_USAGE;
  try {
    const raw = localStorage.getItem(KEY) ?? "";
    if (!parsed || parsed.raw !== raw) {
      parsed = { raw, map: raw ? (JSON.parse(raw) as Record<string, number>) : EMPTY_USAGE };
    }
    return parsed.map;
  } catch {
    return EMPTY_USAGE;
  }
}

export function getUsageSnapshot(): Record<string, number> {
  return read();
}

export function subscribeUsage(cb: () => void): () => void {
  const onChange = () => cb();
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function markUsed(slot: string): void {
  try {
    const map = read();
    map[slot] = Date.now();
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}