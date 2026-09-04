/**
 * Ed25519 helpers built on @noble/curves (audited, works in browser + Node),
 * plus bytes <-> unpadded base64url conversion that is isomorphic (no Buffer).
 */

import { ed25519 } from "@noble/curves/ed25519.js";

export function generateSeed(): Uint8Array {
  return ed25519.utils.randomSecretKey(); // 32 bytes
}

export function publicKeyFromSeed(seed: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(seed);
}

/** Sign `message` (already swept) with the 32-byte Ed25519 seed. */
export function signBytes(seed: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, seed);
}

export function verifyBytes(
  message: Uint8Array,
  sig: Uint8Array,
  pub: Uint8Array,
): boolean {
  try {
    return ed25519.verify(sig, message, pub);
  } catch {
    return false;
  }
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}