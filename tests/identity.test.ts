import { describe, it, expect } from "vitest";
import {
  encryptIdentity,
  decryptIdentity,
  isIdentityFile,
  MIN_PASSPHRASE_LENGTH,
  IdentityFile,
} from "../lib/identity";
import { generateSeed, publicKeyFromSeed, bytesToBase64Url } from "../lib/crypto";
import { didFromPublicKey } from "../lib/didkey";

async function makeIdentity(passphrase = "correct horse battery staple") {
  const seed = generateSeed();
  const pub = publicKeyFromSeed(seed);
  const did = didFromPublicKey(pub);
  const file = await encryptIdentity(seed, did, pub, passphrase);
  return { seed, did, file };
}

describe("identity file encryption", () => {
  it("round-trips seed through AES-256-GCM + PBKDF2", async () => {
    const { seed, did, file } = await makeIdentity();
    const unlocked = await decryptIdentity(file, "correct horse battery staple");
    expect(unlocked.did).toBe(did);
    expect(unlocked.seed).toEqual(seed);
    expect(unlocked.publicKey).toEqual(publicKeyFromSeed(seed));
  });

  it("never stores the seed in plaintext inside the file", async () => {
    const { seed, file } = await makeIdentity();
    const text = JSON.stringify(file);
    expect(text).not.toContain(bytesToBase64Url(seed));
    expect(text).not.toContain(JSON.stringify([...seed]));
    expect(file.ciphertext.length).toBeGreaterThan(0);
  });

  it("rejects a passphrase shorter than 12 chars", async () => {
    const seed = generateSeed();
    const pub = publicKeyFromSeed(seed);
    const did = didFromPublicKey(pub);
    await expect(encryptIdentity(seed, did, pub, "short")).rejects.toThrow(
      `at least ${MIN_PASSPHRASE_LENGTH}`,
    );
  });

  it("fails to decrypt with a wrong passphrase", async () => {
    const { file } = await makeIdentity();
    await expect(decryptIdentity(file, "definitely the wrong passphrase!")).rejects.toThrow(
      /wrong passphrase|corrupted/,
    );
  });

  it("detects tampering (public metadata vs key mismatch)", async () => {
    const { file } = await makeIdentity();
    const other = await makeIdentity();
    const tampered: IdentityFile = { ...file, public: { ...file.public, did: other.did } };
    await expect(decryptIdentity(tampered, "correct horse battery staple")).rejects.toThrow(
      /inconsistent/,
    );
  });

  it("isIdentityFile validates shape", async () => {
    const { file } = await makeIdentity();
    expect(isIdentityFile(file)).toBe(true);
    expect(isIdentityFile(null)).toBe(false);
    expect(isIdentityFile({ type: "other" })).toBe(false);
    expect(isIdentityFile(JSON.parse(JSON.stringify(file)))).toBe(true);
  });
});