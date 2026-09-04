/**
 * Master import: accept an Ed25519 did:key identity created by ANY tool.
 *
 * Detected formats (sniffed from content, never the extension):
 *   - floptools encrypted JSON   (our own, e.g. identity.json)
 *   - encrypted PKCS8 PEM        (e.g. zunmax technocore-did-starter identity.pem,
 *                                 openssl pkcs8, cryptography BestAvailableEncryption)
 *   - plain PKCS8 PEM            (unencrypted "BEGIN PRIVATE KEY")
 *   - generic PBKDF2+AES-GCM JSON envelope (community tools: cryptotelugu,
 *     technocore-work-passport, DID Studio, agent starters; nested or flat
 *     kdf/cipher fields, any iteration count)
 *   - seed JSON                  ({"seed": hex|base64, {"privateKey": ...}, ...})
 *   - raw seed                   (64 hex chars, or base64url 43 chars)
 *
 * Encrypted PKCS8 support: PBES2 with PBKDF2 (HMAC-SHA256/SHA1/SHA512) and
 * AES-128/192/256-CBC, matching openssl and the `cryptography` library.
 * Generic envelopes are decrypted in-browser with WebCrypto and validated
 * against the DID embedded in the envelope before anything is stored.
 * An import always ends in the same secure state: the seed is re-encrypted
 * into the floptools format with a passphrase of your choice.
 */

import { base64UrlToBytes, publicKeyFromSeed } from "./crypto";
import { didFromPublicKey, isValidDid } from "./didkey";
import { isIdentityFile, decryptIdentity, type IdentityFile } from "./identity";

export const SOURCE_IMPORT_FILENAME = "identity.json";

export type DetectedKind =
  | "floptools-encrypted"
  | "pem-encrypted"
  | "pem-plain"
  | "generic-encrypted-json"
  | "seed-json"
  | "seed-raw"
  | "unknown";

export interface DetectedImport {
  kind: DetectedKind;
  detail: string;
  did?: string;
  needsPassphrase: boolean;
}

/* ---------- DER (minimal TLV) ---------- */

interface DerElement {
  tag: number;
  value: Uint8Array<ArrayBuffer>;
  next: number;
}

function derRead(buf: Uint8Array, pos: number): DerElement {
  if (pos + 2 > buf.length) throw new Error("truncated DER");
  const tag = buf[pos];
  let len = buf[pos + 1];
  let head = pos + 2;
  if (len === 0x80) throw new Error("indefinite length not supported");
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4 || pos + 2 + n > buf.length) throw new Error("bad length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos + 2 + i];
    head = pos + 2 + n;
  }
  if (head + len > buf.length) throw new Error("truncated DER value");
  return {
    tag,
    value: buf.slice(head, head + len) as Uint8Array<ArrayBuffer>,
    next: head + len,
  };
}

function oidEq(value: Uint8Array, oid: number[]): boolean {
  if (value.length !== oid.length) return false;
  for (let i = 0; i < oid.length; i++) if (value[i] !== oid[i]) return false;
  return true;
}

function intFromDer(value: Uint8Array): number {
  let n = 0;
  for (const b of value) n = n * 256 + b;
  return n;
}

/* OIDs (DER tag 0x06 payload bytes) */
const OID_PBES2 = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05, 0x0d];
const OID_PBKDF2 = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05, 0x0c];
const OID_HMAC_SHA256 = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x09];
const OID_HMAC_SHA1 = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x07];
const OID_HMAC_SHA512 = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x0b];
const OID_AES128_CBC = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01, 0x02];
const OID_AES192_CBC = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01, 0x16];
const OID_AES256_CBC = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01, 0x2a];

/* ---------- PKCS8 seed extraction ---------- */

/** Extract the 32-byte Ed25519 seed from unencrypted PKCS8 DER. */
export function seedFromPkcs8Der(der: Uint8Array): Uint8Array<ArrayBuffer> {
  const top = derRead(der, 0);
  if (top.tag !== 0x30) throw new Error("not a DER SEQUENCE");
  // Walk to find an OCTET STRING whose content is 04 20 <32 bytes>.
  let seed: Uint8Array<ArrayBuffer> | null = null;
  const stack = [top.value];
  while (stack.length) {
    const buf = stack.pop()!;
    let pos = 0;
    while (pos < buf.length) {
      const el = derRead(buf, pos);
      if (el.tag === 0x30) stack.push(el.value);
      else if (el.tag === 0x04) {
        const v = el.value;
        if (v.length === 34 && v[0] === 0x04 && v[1] === 0x20) {
          seed = v.slice(2) as Uint8Array<ArrayBuffer>;
          break;
        }
      }
      pos = el.next;
    }
    if (seed) break;
  }
  if (!seed || seed.length !== 32) throw new Error("no Ed25519 seed in PKCS8");
  return seed;
}

interface Pbes2Scheme {
  salt: Uint8Array<ArrayBuffer>;
  iterations: number;
  prf: "SHA-256" | "SHA-1" | "SHA-512" | null;
  cipher: "AES-CBC-128" | "AES-CBC-192" | "AES-CBC-256" | null;
  iv: Uint8Array<ArrayBuffer>;
}

function readPbes2Params(buf: Uint8Array): Pbes2Scheme {
  // buf = AlgorithmIdentifier content: OID (PBES2) then params SEQUENCE
  const oidEl = derRead(buf, 0);
  if (oidEl.tag !== 0x06 || !oidEq(oidEl.value, OID_PBES2)) throw new Error("not a PBES2 key");
  const paramsEl = derRead(buf, oidEl.next);
  if (paramsEl.tag !== 0x30) throw new Error("bad PBES2 params");
  const p = paramsEl.value;

  let salt: Uint8Array<ArrayBuffer> | undefined;
  let iterations: number | undefined;
  let prf: Pbes2Scheme["prf"] = null;
  let cipher: Pbes2Scheme["cipher"] | undefined;
  let iv: Uint8Array<ArrayBuffer> | undefined;

  let pos = 0;
  while (pos < p.length) {
    const el = derRead(p, pos);
    if (el.tag === 0x30) {
      // AlgorithmIdentifier { OID, params }
      const kOid = derRead(el.value, 0);
      if (kOid.tag === 0x06) {
        if (oidEq(kOid.value, OID_PBKDF2)) {
          const kParams = derRead(el.value, kOid.next);
          const k = parsePbkdf2Params(kParams.value);
          salt = k.salt;
          iterations = k.iterations;
          prf = k.prf ?? "SHA-1";
        } else if (oidEq(kOid.value, OID_AES128_CBC)) {
          cipher = "AES-CBC-128";
          iv = derRead(el.value, kOid.next).value;
        } else if (oidEq(kOid.value, OID_AES192_CBC)) {
          cipher = "AES-CBC-192";
          iv = derRead(el.value, kOid.next).value;
        } else if (oidEq(kOid.value, OID_AES256_CBC)) {
          cipher = "AES-CBC-256";
          iv = derRead(el.value, kOid.next).value;
        }
      }
    }
    pos = el.next;
  }

  if (!salt || !iterations || !iv || !cipher) {
    throw new Error("PBES2: unsupported key derivation or cipher");
  }
  return { salt, iterations, prf, cipher, iv };
}

function parsePbkdf2Params(buf: Uint8Array): {
  salt?: Uint8Array<ArrayBuffer>;
  iterations?: number;
  prf?: "SHA-256" | "SHA-1" | "SHA-512";
} {
  // buf = PBKDF2 params SEQUENCE content: salt OCTET, iterations INT,
  // optional keylength INT, optional PRF SEQUENCE { OID, NULL }
  const out: { salt?: Uint8Array<ArrayBuffer>; iterations?: number; prf?: "SHA-256" | "SHA-1" | "SHA-512" } = {};
  let pos = 0;
  while (pos < buf.length) {
    const el = derRead(buf, pos);
    if (el.tag === 0x04 && !out.salt) out.salt = el.value;
    else if (el.tag === 0x02 && out.iterations === undefined) out.iterations = intFromDer(el.value);
    else if (el.tag === 0x30) {
      // PRF algorithm identifier sequence: OID
      const oidEl = derRead(el.value, 0);
      if (oidEl.tag === 0x06) {
        if (oidEq(oidEl.value, OID_HMAC_SHA256)) out.prf = "SHA-256";
        else if (oidEq(oidEl.value, OID_HMAC_SHA512)) out.prf = "SHA-512";
        else if (oidEq(oidEl.value, OID_HMAC_SHA1)) out.prf = "SHA-1";
      }
    }
    pos = el.next;
  }
  return out;
}

/** Decrypt an ENCRYPTED PRIVATE KEY PEM (PBES2/AES-CBC) and return the seed. */
export async function seedFromEncryptedPem(pem: string, passphrase: string): Promise<Uint8Array<ArrayBuffer>> {
  const b64 = pemToBase64(pem);
  const der = base64ToBytes(b64);
  const top = derRead(der, 0);
  // top = SEQUENCE { OID pbes2, SEQUENCE params, OCTET STRING data }
  let schemeSeq: Uint8Array<ArrayBuffer> | null = null;
  let encryptedData: Uint8Array<ArrayBuffer> | null = null;
  let pos = 0;
  while (pos < top.value.length) {
    const el = derRead(top.value, pos);
    if (el.tag === 0x30 && !schemeSeq) schemeSeq = el.value;
    else if (el.tag === 0x04) encryptedData = el.value;
    pos = el.next;
  }
  if (!schemeSeq || !encryptedData) throw new Error("not a PBES2 encrypted key");

  const scheme = readPbes2Params(schemeSeq);
  const keyBits = scheme.cipher === "AES-CBC-128" ? 128 : scheme.cipher === "AES-CBC-192" ? 192 : 256;
  const prf = scheme.prf ?? "SHA-1";

  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const aesKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: scheme.salt, iterations: scheme.iterations, hash: prf },
    baseKey,
    { name: "AES-CBC", length: keyBits },
    false,
    ["decrypt"],
  );

  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: scheme.iv },
      aesKey,
      encryptedData as BufferSource,
    );
  } catch {
    throw new Error("could not decrypt this key: wrong passphrase or unsupported scheme");
  }
  // plain is the inner unencrypted PKCS8 DER
  return seedFromPkcs8Der(new Uint8Array(plain));
}

function pemToBase64(pem: string): string {
  const body = pem
    .split(/\r?\n/)
    .filter((l) => l.length > 0 && !l.trim().startsWith("-----"))
    .join("");
  if (!body) throw new Error("empty PEM body");
  return body;
}

function base64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function seedFromPlainPem(pem: string): Promise<Uint8Array<ArrayBuffer>> {
  return seedFromPkcs8Der(base64ToBytes(pemToBase64(pem)));
}

/* ---------- generic PBKDF2 + AES-GCM JSON envelope ---------- */

interface Envelope {
  salt: string;
  iterations: number;
  iv: string;
  ciphertext: string;
  did?: string;
  publicKey?: string;
}

/** Normalize flat or nested (kdf/cipher objects) community envelope fields. */
export function normalizeEnvelope(obj: Record<string, unknown>): Envelope | null {
  const kdf = (obj.kdf ?? {}) as Record<string, unknown>;
  const cipher = (obj.cipher ?? {}) as Record<string, unknown>;
  const salt = typeof obj.salt === "string" ? obj.salt : typeof kdf.salt === "string" ? kdf.salt : undefined;
  const iterationsNum =
    typeof obj.iterations === "number"
      ? obj.iterations
      : typeof kdf.iterations === "number"
        ? kdf.iterations
        : undefined;
  const ivText = typeof obj.iv === "string" ? obj.iv : typeof cipher.iv === "string" ? cipher.iv : undefined;
  const ciphertextText =
    typeof obj.ciphertext === "string"
      ? obj.ciphertext
      : typeof cipher.ciphertext === "string"
        ? cipher.ciphertext
        : undefined;
  if (!salt || !iterationsNum || !ivText || !ciphertextText) return null;
  if (iterationsNum < 1 || iterationsNum > 50_000_000) return null;
  const did = typeof obj.did === "string" && isValidDid(obj.did) ? obj.did : undefined;
  const publicKey = typeof obj.publicKey === "string" ? obj.publicKey : undefined;
  return { salt, iterations: iterationsNum, iv: ivText, ciphertext: ciphertextText, did, publicKey };
}

/** Decrypt a community envelope (PBKDF2-SHA256 + AES-GCM) and locate the seed. */
export async function seedFromGenericEnvelope(
  obj: Record<string, unknown>,
  passphrase: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const env = normalizeEnvelope(obj);
  if (!env) throw new Error("the JSON is not a recognized PBKDF2 + AES-GCM identity backup");

  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const aesKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: base64UrlToBytes(env.salt), iterations: env.iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(env.iv) },
      aesKey,
      base64UrlToBytes(env.ciphertext) as BufferSource,
    );
  } catch {
    throw new Error("could not decrypt this backup: wrong passphrase or corrupted file");
  }

  const plainBytes = new Uint8Array(plain);

  // 1) plaintext JSON with a seed-ish field
  let seed = null as Uint8Array | null;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plainBytes)) as Record<string, unknown>;
    seed = seedFromJson(parsed);
    if (!seed) {
      // some communities nest the seed deeper or name it differently
      seed = deepSeedLookup(parsed);
    }
  } catch {
    /* not JSON */
  }
  // 2) raw UTF-8 representation (hex or base64url)
  if (!seed) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(plainBytes).trim();
      seed = parseSeedText(text) ?? parseSeedText(text.replace(/^0x/i, ""));
    } catch {
      /* not text */
    }
  }
  // 3) plain 32 raw bytes
  if (!seed && plainBytes.length === 32) seed = plainBytes;

  if (!seed || seed.length !== 32) {
    throw new Error(
      "decrypted successfully, but the seed inside it could not be located in this tool's layout. Share the backup with its creator for a converter.",
    );
  }

  // 4) self-validation against the envelope's embedded identifiers
  const pub = publicKeyFromSeed(seed);
  const derivedDid = didFromPublicKey(pub);
  if (env.did && derivedDid !== env.did) {
    throw new Error("decrypted key does not match the DID declared in the backup (file tampered or mixed up)");
  }
  if (env.publicKey) {
    let stored: Uint8Array<ArrayBuffer> | null = null;
    try {
      stored = base64UrlToBytes(env.publicKey.trim());
    } catch {
      stored = null; // not base64url bytes — did check stays authoritative
    }
    if (stored && (stored.length !== pub.length || !stored.every((b, i) => b === pub[i]))) {
      throw new Error("decrypted key does not match the public key declared in the backup (file tampered)");
    }
  }

  return seed as Uint8Array<ArrayBuffer>;
}

function deepSeedLookup(obj: unknown): Uint8Array | null {
  if (!obj || typeof obj !== "object") return null;
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (value && typeof value === "object") {
      const s = deepSeedLookup(value);
      if (s) return s;
    } else if (typeof value === "string") {
      const s = parseSeedText(value);
      if (s) return s;
    }
  }
  return null;
}

export interface SeedParse {
  seed: Uint8Array<ArrayBuffer>;
}

export function parseSeedText(text: string): Uint8Array<ArrayBuffer> | null {
  const t = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  // base64url / base64, 43 chars unpadded or 44 padded
  const b64 = t.replace(/-/g, "+").replace(/_/g, "/");
  if (/^[A-Za-z0-9+/]{43}$/.test(b64) || /^[A-Za-z0-9+/]{44}$/.test(b64)) {
    try {
      const bytes = base64UrlToBytes(b64);
      if (bytes.length === 32) return bytes;
    } catch {
      /* fallthrough */
    }
  }
  return null;
}

export function seedFromJson(obj: Record<string, unknown>): Uint8Array<ArrayBuffer> | null {
  const keys = ["seed", "privateKey", "private_key", "secretKey", "secret_key", "private", "raw"];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") {
      const s = parseSeedText(v);
      if (s) return s;
      // also: hex with 0x prefix
      const hex = v.replace(/^0x/i, "");
      if (/^[0-9a-fA-F]{64}$/.test(hex)) return parseSeedText(hex);
    }
  }
  return null;
}

/* ---------- detection ---------- */

export function detectImport(text: string): DetectedImport {
  const t = text.trim();

  // JSON?
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t) as unknown;
      if (isIdentityFile(parsed)) {
        return { kind: "floptools-encrypted", detail: "floptools encrypted identity JSON", needsPassphrase: true };
      }
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const seed = seedFromJson(obj);
        if (seed) {
          return { kind: "seed-json", detail: "seed JSON (hex or base64)", needsPassphrase: false, did: didFromPublicKey(publicKeyFromSeed(seed)) };
        }
        const env = normalizeEnvelope(obj);
        if (env) {
          return {
            kind: "generic-encrypted-json",
            detail: `encrypted community backup (PBKDF2-SHA256 x${env.iterations.toLocaleString()}, AES-256-GCM)`,
            needsPassphrase: true,
            did: env.did,
          };
        }
      }
      return { kind: "unknown", detail: "recognized JSON but no key material found", needsPassphrase: false };
    } catch {
      return { kind: "unknown", detail: "unreadable JSON", needsPassphrase: false };
    }
  }

  // PEM?
  if (t.includes("-----BEGIN")) {
    if (t.includes("BEGIN ENCRYPTED PRIVATE KEY")) {
      return { kind: "pem-encrypted", detail: "encrypted PKCS8 PEM (PBES2)", needsPassphrase: true };
    }
    if (t.includes("BEGIN PRIVATE KEY")) {
      // plain PKCS8: content sniffed; caller resolves async for the DID
      return { kind: "pem-plain", detail: "PKCS8 PEM (unencrypted)", needsPassphrase: false };
    }
    return { kind: "unknown", detail: "PEM header not recognized", needsPassphrase: false };
  }

  // raw seed?
  const seed = parseSeedText(t);
  if (seed) {
    return { kind: "seed-raw", detail: "raw Ed25519 seed (hex or base64url)", needsPassphrase: false, did: didFromPublicKey(publicKeyFromSeed(seed)) };
  }

  return { kind: "unknown", detail: "could not recognize this as an Ed25519 identity", needsPassphrase: false };
}

/** Resolve any detected kind to an unlocked identity (seed + did). */
export async function resolveImport(
  text: string,
  sourcePassphrase?: string,
): Promise<{ seed: Uint8Array<ArrayBuffer>; did: string; sourceKind: DetectedKind; file?: IdentityFile }> {
  const det = detectImport(text);
  switch (det.kind) {
    case "floptools-encrypted": {
      if (!sourcePassphrase) throw new Error("passphrase required for this encrypted identity file");
      const file = JSON.parse(text) as IdentityFile;
      const unlocked = await decryptIdentity(file, sourcePassphrase);
      return { seed: unlocked.seed as Uint8Array<ArrayBuffer>, did: unlocked.did, sourceKind: det.kind, file };
    }
    case "pem-encrypted": {
      if (!sourcePassphrase) throw new Error("passphrase required for this encrypted PEM key");
      const seed = await seedFromEncryptedPem(text, sourcePassphrase);
      return { seed, did: didFromPublicKey(publicKeyFromSeed(seed)), sourceKind: det.kind };
    }
    case "pem-plain": {
      const seed = await seedFromPlainPem(text);
      return { seed, did: didFromPublicKey(publicKeyFromSeed(seed)), sourceKind: det.kind };
    }
    case "generic-encrypted-json": {
      if (!sourcePassphrase) throw new Error("passphrase required for this encrypted backup");
      const seed = await seedFromGenericEnvelope(JSON.parse(text) as Record<string, unknown>, sourcePassphrase);
      return { seed, did: didFromPublicKey(publicKeyFromSeed(seed)), sourceKind: det.kind };
    }
    case "seed-json":
    case "seed-raw": {
      const seed = det.kind === "seed-json" ? seedFromJson(JSON.parse(text) as Record<string, unknown>)! : parseSeedText(text)!;
      return { seed, did: didFromPublicKey(publicKeyFromSeed(seed)), sourceKind: det.kind };
    }
    default:
      throw new Error("could not import: the file is not a recognized Ed25519 identity (need a seed, PKCS8 PEM, or floptools identity JSON)");
  }
}

export function seedToHex(seed: Uint8Array): string {
  return [...seed].map((b) => b.toString(16).padStart(2, "0")).join("");
}