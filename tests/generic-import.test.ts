import { describe, it, expect } from "vitest";
import {
  detectImport,
  resolveImport,
  normalizeEnvelope,
  seedFromGenericEnvelope,
  seedToHex,
} from "../lib/import";
import { bytesToBase64Url } from "../lib/crypto";
import { publicKeyFromSeed } from "../lib/crypto";
import { didFromPublicKey } from "../lib/didkey";

const SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const SEED = new Uint8Array(
  SEED_HEX.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
);
const EXPECTED_DID = "did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw";
const PASSWORD = "my-community-passphrase-123";

const enc = new TextEncoder();

async function makeEnvelope(opts: {
  iterations: number;
  nested: boolean;
  plaintextAs: "json-seed-raw-b64" | "json-seed-hex" | "raw-b64text";
  did?: string;
  publicKey?: string;
  keyName?: string;
}): Promise<Record<string, unknown>> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(PASSWORD), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: opts.iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

  const pub = publicKeyFromSeed(SEED);
  let plain: Uint8Array;
  if (opts.plaintextAs === "json-seed-raw-b64") {
    plain = enc.encode(
      JSON.stringify({ [opts.keyName ?? "seed"]: bytesToBase64Url(SEED) }),
    );
  } else if (opts.plaintextAs === "json-seed-hex") {
    plain = enc.encode(JSON.stringify({ seed: SEED_HEX }));
  } else {
    plain = enc.encode(bytesToBase64Url(SEED));
  }
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain as BufferSource));

  const publicKeyB64 = bytesToBase64Url(pub);
  if (opts.nested) {
    return {
      type: "technocore-work-passport-ed25519",
      version: 1,
      did: opts.did ?? EXPECTED_DID,
      kdf: { name: "PBKDF2-SHA256", iterations: opts.iterations, salt: bytesToBase64Url(salt) },
      cipher: { name: "AES-GCM", iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(ciphertext) },
    };
  }
  return {
    version: 4,
    format: "cryptotelugu-technocore-browser-backup",
    algorithm: "Ed25519",
    did: opts.did ?? EXPECTED_DID,
    publicKey: opts.publicKey ?? publicKeyB64,
    kdf: "PBKDF2-SHA256",
    iterations: opts.iterations,
    salt: bytesToBase64Url(salt),
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(ciphertext),
  };
}

describe("normalizeEnvelope", () => {
  it("accepts flat (cryptotelugu-style) and nested (passport-style) layouts", async () => {
    const flat = await makeEnvelope({ iterations: 250000, nested: false, plaintextAs: "raw-b64text" });
    const nested = await makeEnvelope({ iterations: 310000, nested: true, plaintextAs: "raw-b64text" });
    expect(normalizeEnvelope(flat)?.iterations).toBe(250000);
    expect(normalizeEnvelope(nested)?.iterations).toBe(310000);
    expect(normalizeEnvelope({ foo: 1 })).toBeNull();
  });
});

describe("community envelope decryption (generic master import)", () => {
  it("decrypts a flat cryptotelugu-style backup with raw base64url plaintext", async () => {
    const env = await makeEnvelope({ iterations: 250000, nested: false, plaintextAs: "raw-b64text" });
    const seed = await seedFromGenericEnvelope(env, PASSWORD);
    expect(seedToHex(seed)).toBe(SEED_HEX);
  });

  it("decrypts a nested passport-style backup with JSON plaintext", async () => {
    const env = await makeEnvelope({ iterations: 310000, nested: true, plaintextAs: "json-seed-raw-b64" });
    const seed = await seedFromGenericEnvelope(env, PASSWORD);
    expect(seedToHex(seed)).toBe(SEED_HEX);
  });

  it("accepts a hex seed inside JSON", async () => {
    const env = await makeEnvelope({ iterations: 600000, nested: true, plaintextAs: "json-seed-hex" });
    const seed = await seedFromGenericEnvelope(env, PASSWORD);
    expect(seedToHex(seed)).toBe(SEED_HEX);
  });

  it("rejects a wrong passphrase", async () => {
    const env = await makeEnvelope({ iterations: 250000, nested: false, plaintextAs: "raw-b64text" });
    await expect(seedFromGenericEnvelope(env, "not-the-passphrase-either")).rejects.toThrow(
      /wrong passphrase|corrupted/,
    );
  });

  it("rejects a tampered DID (seed does not match envelope did)", async () => {
    const env = await makeEnvelope({
      iterations: 250000,
      nested: false,
      plaintextAs: "raw-b64text",
      did: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    });
    await expect(seedFromGenericEnvelope(env, PASSWORD)).rejects.toThrow(/does not match/);
  });

  it("rejects a tampered publicKey field", async () => {
    const env = await makeEnvelope({
      iterations: 250000,
      nested: false,
      plaintextAs: "raw-b64text",
      publicKey: bytesToBase64Url(new Uint8Array(32)),
    });
    await expect(seedFromGenericEnvelope(env, PASSWORD)).rejects.toThrow(/does not match/);
  });
});

describe("detect + resolve for community backups", () => {
  it("detects and resolves the flat backup end to end", async () => {
    const env = await makeEnvelope({ iterations: 250000, nested: false, plaintextAs: "raw-b64text" });
    const text = JSON.stringify(env);
    const det = detectImport(text);
    expect(det.kind).toBe("generic-encrypted-json");
    expect(det.needsPassphrase).toBe(true);
    expect(det.did).toBe(EXPECTED_DID);
    const res = await resolveImport(text, PASSWORD);
    expect(res.did).toBe(EXPECTED_DID);
  });

  it("detects and resolves the nested backup end to end", async () => {
    const env = await makeEnvelope({ iterations: 310000, nested: true, plaintextAs: "json-seed-raw-b64" });
    const text = JSON.stringify(env);
    const det = detectImport(text);
    expect(det.kind).toBe("generic-encrypted-json");
    const res = await resolveImport(text, PASSWORD);
    expect(didFromPublicKey(publicKeyFromSeed(res.seed))).toBe(EXPECTED_DID);
  });
});