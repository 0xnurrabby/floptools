/**
 * High-level sign/verify operations shared by the web app and the CLI.
 * These are pure and isomorphic so both callers use the exact same bytes.
 */

import {
  signBytes,
  verifyBytes,
  bytesToBase64Url,
  base64UrlToBytes,
  publicKeyFromSeed,
} from "./crypto";
import { didFromPublicKey, publicKeyFromDid, isValidDid } from "./didkey";
import { sweep, assertMessageLength } from "./sweep";
import { isValidNonce } from "./nonce";

export const SIG_RE = /^[A-Za-z0-9_-]{86}$/;

export interface SignedMessage {
  did: string;
  room: string;
  nonce: string;
  text: string;
  sweptText: string;
  canonical: string;
  sig: string;
  sigBytes: Uint8Array;
}

export function signMessage(opts: {
  seed: Uint8Array;
  room: string;
  nonce: string;
  text: string;
}): SignedMessage {
  if (!isValidNonce(opts.nonce)) {
    throw new Error("nonce must be 1-19 ASCII digits");
  }
  const sweptText = sweep(opts.text);
  if (!sweptText) {
    throw new Error("nothing visible would be left after the single-line sweep");
  }
  assertMessageLength(sweptText);
  const canonical = `${opts.room}|${opts.nonce}|${sweptText}`;
  const sigBytes = signBytes(
    opts.seed,
    new TextEncoder().encode(canonical),
  );
  const pub = publicKeyFromSeed(opts.seed);
  return {
    did: didFromPublicKey(pub),
    room: opts.room,
    nonce: opts.nonce,
    text: opts.text,
    sweptText,
    canonical,
    sig: bytesToBase64Url(sigBytes),
    sigBytes,
  };
}

export function verifyMessage(opts: {
  did: string;
  room: string;
  nonce: string;
  text: string;
  sig: string;
}): { valid: boolean; canonical: string; sweptText: string; error?: string } {
  const canonical = `${opts.room}|${opts.nonce}|${sweep(opts.text)}`;
  try {
    if (!isValidDid(opts.did)) return { valid: false, canonical, sweptText: sweep(opts.text), error: "invalid did:key" };
    if (!SIG_RE.test(opts.sig)) return { valid: false, canonical, sweptText: sweep(opts.text), error: "signature is not 86-char unpadded base64url" };
    const pub = publicKeyFromDid(opts.did);
    const ok = verifyBytes(
      new TextEncoder().encode(canonical),
      base64UrlToBytes(opts.sig),
      pub,
    );
    return { valid: ok, canonical, sweptText: sweep(opts.text) };
  } catch (err) {
    return {
      valid: false,
      canonical,
      sweptText: sweep(opts.text),
      error: (err as Error).message,
    };
  }
}

/** Parse a 403 body that names the exact string the server wanted signed. */
export function extractSignedStringFrom403(body: string): string | null {
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  for (const line of lines) {
    const m = /^([a-z0-9_-]+)\|[0-9]{1,19}\|.+$/.exec(line);
    if (m) return line;
  }
  return null;
}