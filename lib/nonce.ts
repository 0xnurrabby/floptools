/**
 * Nonce handling. The server requires a nonce (1-19 ASCII digits) strictly
 * greater than the last nonce that key used in that room. Epoch milliseconds
 * works; we persist the last nonce per (did, room) locally and also keep an
 * in-process high-water mark so two calls in the same millisecond still
 * produce strictly increasing values.
 */

export const NONCE_RE = /^[0-9]{1,19}$/;

export function isValidNonce(nonce: string): boolean {
  return NONCE_RE.test(nonce);
}

let lastEmitted = -1n;

/** Pure preview of the next nonce (no in-process high-water mark mutation). */
export function candidateNonce(lastNonce?: string): string {
  let next = BigInt(Date.now());
  if (lastNonce !== undefined && NONCE_RE.test(lastNonce)) {
    const last = BigInt(lastNonce);
    if (last >= next) next = last + 1n;
  }
  const s = next.toString();
  if (s.length > 19) {
    throw new Error("nonce would exceed 19 digits");
  }
  return s;
}

export function nextNonce(lastNonce?: string): string {
  let next = BigInt(candidateNonce(lastNonce));
  if (next <= lastEmitted) next = lastEmitted + 1n;
  lastEmitted = next;
  return next.toString();
}

export function nonceGreater(prev: string | undefined, next: string): boolean {
  if (prev === undefined) return true;
  if (!NONCE_RE.test(prev) || !NONCE_RE.test(next)) return false;
  return BigInt(next) > BigInt(prev);
}

/** Local persistence of last nonce per (did, room), guarded for SSR. */
export interface NonceStore {
  get(did: string, room: string): string | undefined;
  set(did: string, room: string, nonce: string): void;
  clear(did: string): void;
}

const KEY_PREFIX = "floptools.nonces.";

export function createLocalNonceStore(): NonceStore {
  function read(did: string): Record<string, string> {
    try {
      const raw = localStorage.getItem(KEY_PREFIX + did);
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  }
  function write(did: string, map: Record<string, string>): void {
    try {
      localStorage.setItem(KEY_PREFIX + did, JSON.stringify(map));
    } catch {
      /* storage unavailable (private mode, quota) · nonces just won't persist */
    }
  }
  return {
    get(did, room) {
      return read(did)[room];
    },
    set(did, room, nonce) {
      const map = read(did);
      map[room] = nonce;
      write(did, map);
    },
    clear(did) {
      try {
        localStorage.removeItem(KEY_PREFIX + did);
      } catch {
        /* noop */
      }
    },
  };
}