/**
 * did:key construction/parsing for Ed25519 (the only scheme Technocore
 * accepts). Mirrors `scripts/sign.py`:
 *
 *   did:key:z6Mk… = "did:key:" + "z" + base58btc(multicodec(0xed 0x01) + raw32)
 *
 * The multibase tag `z` (base58btc) plus the fixed two-byte ed25519-pub
 * multicodec prefix is why every such DID starts with `did:key:z6Mk`.
 */

import { base58Encode, base58Decode } from "./base58";

export const MULTICODEC_ED25519 = new Uint8Array([0xed, 0x01]);

export const DID_KEY_PREFIX = "did:key:z6Mk";
export const DID_KEY_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;

export function didFromPublicKey(pub: Uint8Array): string {
  if (pub.length !== 32) {
    throw new Error("Ed25519 public key must be 32 bytes");
  }
  const combined = new Uint8Array(2 + 32);
  combined.set(MULTICODEC_ED25519, 0);
  combined.set(pub, 2);
  const mb = "z" + base58Encode(combined);
  if (mb.length !== 48) {
    // "z" + 47 chars of base58 for a 34-byte payload
    throw new Error(`internal: bad multibase length ${mb.length}`);
  }
  return "did:key:" + mb;
}

export function publicKeyFromDid(did: string): Uint8Array {
  if (!DID_KEY_RE.test(did)) {
    throw new Error("not a valid did:key (Ed25519) identifier");
  }
  const mb = did.slice("did:key:".length);
  if (!mb.startsWith("z")) {
    throw new Error("not base58btc (multibase tag 'z')");
  }
  const decoded = base58Decode(mb.slice(1));
  if (decoded.length !== 34) {
    throw new Error("did:key payload must be 34 bytes (multicodec + 32-byte key)");
  }
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error("did:key is not Ed25519 (expected multicodec 0xed 0x01)");
  }
  return decoded.slice(2);
}

export function isValidDid(did: string): boolean {
  try {
    publicKeyFromDid(did);
    return true;
  } catch {
    return false;
  }
}

/** Fingerprint = first 16 lowercase hex of SHA-256(did:key string). */
export async function didFingerprint(did: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(did),
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Sharded DID note path convention (/kv/did-<shard>/<key>), plus the legacy
 * /kv/did/<fingerprint> fallback. See /patterns.md §3 and /auth.md.
 */
export async function didNotePaths(did: string): Promise<{
  sharded: { ns: string; key: string };
  legacy: { ns: string; key: string };
}> {
  const fp = await didFingerprint(did);
  return {
    sharded: { ns: `did-${fp.slice(0, 2)}`, key: fp.slice(2) },
    legacy: { ns: "did", key: fp },
  };
}