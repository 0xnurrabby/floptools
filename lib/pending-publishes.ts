/**
 * Pending signed publishes: when a publish fails transiently (timeout, 502,
 * 429), it is queued here so a background retrier can complete it while the
 * browser is open. The seed never leaves memory; re-signing happens only when
 * the session is unlocked, with a fresh strictly-increasing nonce.
 */

export interface PendingPublish {
  id: string;
  did: string;
  room: string;
  text: string;
  createdAt: string;
  attempts: number;
}

const KEY = "floptools.pending";
const EVENT = "floptools:pending";

export const EMPTY_PENDING: PendingPublish[] = [];

let parsed: { raw: string; list: PendingPublish[] } | null = null;

function read(): PendingPublish[] {
  if (typeof window === "undefined") return EMPTY_PENDING;
  try {
    const raw = localStorage.getItem(KEY) ?? "";
    if (!parsed || parsed.raw !== raw) {
      parsed = { raw, list: raw ? (JSON.parse(raw) as PendingPublish[]) : EMPTY_PENDING };
    }
    return parsed.list;
  } catch {
    return EMPTY_PENDING;
  }
}

export function getPendingSnapshot(): PendingPublish[] {
  return read();
}

export function subscribePending(cb: () => void): () => void {
  const onChange = () => cb();
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function notify(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

function write(list: PendingPublish[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
  notify();
}

export function addPending(item: PendingPublish): void {
  const list = read();
  const exists = list.some(
    (p) => p.did === item.did && p.room === item.room && p.text === item.text && p.attempts < 99,
  );
  if (exists) return;
  write([item, ...list].slice(0, 20));
}

export function removePending(id: string): void {
  write(read().filter((p) => p.id !== id));
}

export function markAttempt(id: string): void {
  write(
    read().map((p) => (p.id === id ? { ...p, attempts: p.attempts + 1 } : p)),
  );
}