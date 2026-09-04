/**
 * Session identity holder for the web app.
 *
 * The unlocked seed lives only in module memory and is cleared on lock() /
 * refresh. The only thing persisted to localStorage is the *encrypted*
 * identity file blob (never a seed) when the user opts in, plus per-room
 * nonce high-water marks.
 */

import {
  decryptIdentity,
  encryptIdentity,
  isIdentityFile,
  type IdentityFile,
  type UnlockedIdentity,
} from "./identity";
import { publicKeyFromSeed, signBytes, bytesToBase64Url } from "./crypto";
import { didFromPublicKey } from "./didkey";
import { sweep, assertMessageLength } from "./sweep";
import { nextNonce, createLocalNonceStore } from "./nonce";

const STORED_IDENTITY_KEY = "floptools.identity.enc";

let current: UnlockedIdentity | null = null;
let lastFile: IdentityFile | null = null;
export const nonceStore = createLocalNonceStore();

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeKeyring(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(): void {
  for (const fn of listeners) fn();
}

export function generateIdentityKeypair() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = publicKeyFromSeed(seed);
  const did = didFromPublicKey(publicKey);
  return { seed, publicKey, did };
}

export interface NewIdentityResult {
  identity: IdentityFile;
  unlocked: UnlockedIdentity;
}

export async function createIdentity(passphrase: string): Promise<NewIdentityResult> {
  const { seed, publicKey, did } = generateIdentityKeypair();
  const identity = await encryptIdentity(seed, did, publicKey, passphrase);
  const unlocked: UnlockedIdentity = {
    seed,
    publicKey,
    did,
    createdAt: identity.createdAt,
  };
  current = unlocked;
  lastFile = identity;
  emit();
  return { identity, unlocked };
}

export async function unlockFromFile(
  file: IdentityFile,
  passphrase: string,
): Promise<UnlockedIdentity> {
  const unlocked = await decryptIdentity(file, passphrase);
  current = unlocked;
  lastFile = file;
  emit();
  return unlocked;
}

export function lock(): void {
  current = null;
  lastFile = null;
  emit();
}

export function getLastIdentityFile(): IdentityFile | null {
  return lastFile;
}

export function getUnlocked(): UnlockedIdentity | null {
  return current;
}

/** Persist the encrypted blob in this browser (opt-in convenience). */
export function saveEncryptedIdentity(file: IdentityFile): void {
  try {
    localStorage.setItem(STORED_IDENTITY_KEY, JSON.stringify(file));
  } catch {
    /* storage unavailable */
  }
  notifyStored();
}

export function loadEncryptedIdentity(): IdentityFile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORED_IDENTITY_KEY);
    return raw ? (JSON.parse(raw) as IdentityFile) : null;
  } catch {
    return null;
  }
}

export function clearEncryptedIdentity(): void {
  try {
    localStorage.removeItem(STORED_IDENTITY_KEY);
  } catch {
    /* noop */
  }
  notifyStored();
}

/* Reactive snapshot of the stored (encrypted) identity copy. */

const STORED_EVENT = "floptools:identity";
let storedParsed: { raw: string; file: IdentityFile | null } | null = null;

function readStoredFile(): IdentityFile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORED_IDENTITY_KEY) ?? "";
    if (!storedParsed || storedParsed.raw !== raw) {
      let file: IdentityFile | null = null;
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (isIdentityFile(parsed)) file = parsed;
        } catch {
          /* corrupt entry · treat as absent */
        }
      }
      storedParsed = { raw, file };
    }
    return storedParsed.file;
  } catch {
    return null;
  }
}

function notifyStored(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(STORED_EVENT));
}

export function getStoredIdentitySnapshot(): IdentityFile | null {
  return readStoredFile();
}

export function subscribeStoredIdentity(cb: () => void): () => void {
  const onChange = () => cb();
  window.addEventListener(STORED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(STORED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export interface SignedDraft {
  did: string;
  room: string;
  sweptText: string;
  canonical: string;
  nonce: string;
  sig: string;
  sigBase64Url: string;
}

/**
 * Build a signed message payload for a room: sweep the text, pick a strictly
 * increasing nonce for (did, room), and sign room|nonce|sweptText.
 */
export function signDraft(room: string, text: string, opts?: {
  nonce?: string;
}): SignedDraft {
  const unlocked = getUnlocked();
  if (!unlocked) throw new Error("no unlocked identity · create or unlock one first");
  const sweptText = sweep(text);
  if (!sweptText) throw new Error("nothing visible would be left after the single-line sweep");
  assertMessageLength(sweptText);
  const last = nonceStore.get(unlocked.did, room);
  const nonce = opts?.nonce ?? nextNonce(last);
  const canonical = `${room}|${nonce}|${sweptText}`;
  const sig = signBytes(unlocked.seed, new TextEncoder().encode(canonical));
  const sigBase64Url = bytesToBase64Url(sig);
  nonceStore.set(unlocked.did, room, nonce);
  return { did: unlocked.did, room, sweptText, canonical, nonce, sig: sigBase64Url, sigBase64Url };
}

/** DID note value with optional mailbox. */
export function didNoteValue(did: string, opts: { mailbox?: string } = {}): string {
  let value = did;
  if (opts.mailbox) value += ` mailbox:${opts.mailbox}`;
  return value;
}