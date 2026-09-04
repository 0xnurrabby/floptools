/**
 * Encrypted at-rest identity file.
 *
 * The private seed never exists in plaintext outside of memory: it is
 * encrypted with AES-256-GCM under a key derived from the passphrase via
 * PBKDF2-SHA256 (310k iterations). The file carries only public metadata plus
 * ciphertext, so it is safe to store anywhere · browser, disk, backup.
 *
 * Uses WebCrypto (globalThis.crypto.subtle) which exists in every supported
 * browser and in Node 19+, so this module is isomorphic (web app + CLI).
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToBase64Url, base64UrlToBytes } from "./crypto";
import { didFromPublicKey } from "./didkey";

export const IDENTITY_TYPE = "technocore-did-identity";
export const IDENTITY_VERSION = 1;
export const MIN_PASSPHRASE_LENGTH = 12;
export const KDF_ITERATIONS = 310000;
export const DEFAULT_IDENTITY_FILENAME = "identity.json";

/** Human-friendly identity name: identity_<last 4 chars of the DID>. */
export function identityShortName(did: string): string {
  const tail = did.length >= 4 ? did.slice(-4) : did;
  return `identity_${tail}`;
}

export function identityFilenameFor(did: string): string {
  return `${identityShortName(did)}.json`;
}

export interface IdentityPublic {
  did: string;
  rawPublicKey: string;
  createdAt: string;
}

export interface IdentityFile {
  type: typeof IDENTITY_TYPE;
  version: typeof IDENTITY_VERSION;
  kdf: "pbkdf2-sha256";
  kdfIterations: number;
  salt: string;
  cipher: "aes-256-gcm";
  iv: string;
  ciphertext: string;
  createdAt: string;
  public: IdentityPublic;
}

export interface UnlockedIdentity {
  seed: Uint8Array;
  publicKey: Uint8Array;
  did: string;
  createdAt: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function checkPassphraseStrength(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(
      `passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
    );
  }
}

export async function encryptIdentity(
  seed: Uint8Array,
  did: string,
  publicKey: Uint8Array,
  passphrase: string,
): Promise<IdentityFile> {
  checkPassphraseStrength(passphrase);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
  const now = new Date().toISOString();
  const plaintext = JSON.stringify({
    seed: bytesToBase64Url(seed),
    did,
    createdAt: now,
  });
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext),
  );
  return {
    type: IDENTITY_TYPE,
    version: IDENTITY_VERSION,
    kdf: "pbkdf2-sha256",
    kdfIterations: KDF_ITERATIONS,
    salt: bytesToBase64Url(salt),
    cipher: "aes-256-gcm",
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    createdAt: now,
    public: {
      did,
      rawPublicKey: bytesToBase64Url(publicKey),
      createdAt: now,
    },
  };
}

export function isIdentityFile(value: unknown): value is IdentityFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === IDENTITY_TYPE &&
    v.version === IDENTITY_VERSION &&
    typeof v.salt === "string" &&
    typeof v.iv === "string" &&
    typeof v.ciphertext === "string" &&
    typeof v.kdfIterations === "number" &&
    v.cipher === "aes-256-gcm" &&
    v.kdf === "pbkdf2-sha256" &&
    typeof v.public === "object" &&
    v.public !== null &&
    typeof (v.public as Record<string, unknown>).did === "string"
  );
}

export async function decryptIdentity(
  file: IdentityFile,
  passphrase: string,
): Promise<UnlockedIdentity> {
  const salt = base64UrlToBytes(file.salt);
  const iv = base64UrlToBytes(file.iv);
  const ct = base64UrlToBytes(file.ciphertext);
  const key = await deriveKey(passphrase, salt, file.kdfIterations);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  } catch {
    throw new Error("could not decrypt · wrong passphrase or corrupted file");
  }
  const parsed = JSON.parse(dec.decode(plaintext)) as {
    seed: string;
    did: string;
    createdAt: string;
  };
  const seed = base64UrlToBytes(parsed.seed);
  if (seed.length !== 32) throw new Error("seed in identity file is not 32 bytes");
  const publicKey = ed25519.getPublicKey(seed);
  const did = didFromPublicKey(publicKey);
  if (did !== parsed.did || did !== file.public.did) {
    throw new Error(
      "identity file is inconsistent: public metadata does not match private key",
    );
  }
  return {
    seed,
    publicKey,
    did,
    createdAt: parsed.createdAt ?? file.public.createdAt,
  };
}

export function identityFileToDownloadUrl(file: IdentityFile): string {
  const blob = new Blob([JSON.stringify(file, null, 2)], {
    type: "application/json",
  });
  return URL.createObjectURL(blob);
}