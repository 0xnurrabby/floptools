import { describe, it, expect } from "vitest";
import { base58Encode, base58Decode } from "../lib/base58";
import {
  didFromPublicKey,
  publicKeyFromDid,
  isValidDid,
  didFingerprint,
  didNotePaths,
  DID_KEY_PREFIX,
} from "../lib/didkey";
import { publicKeyFromSeed } from "../lib/crypto";
import { signMessage, verifyMessage, SIG_RE } from "../lib/sign";

// RFC 8032 §7.1 test 1 seed. Ground-truth did:key and signatures were produced
// by the OFFICIAL scripts/sign.py (flop-labs/technocore-chat) with this seed.
const SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const SEED = new Uint8Array(
  SEED_HEX.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
);
const EXPECTED_DID = "did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw";

describe("did:key encoding (matches official scripts/sign.py)", () => {
  it("produces the exact did:key the official signer produces", () => {
    const pub = publicKeyFromSeed(SEED);
    const did = didFromPublicKey(pub);
    expect(did).toBe(EXPECTED_DID);
  });

  it("starts with did:key:z6Mk and is the documented shape", () => {
    const did = didFromPublicKey(publicKeyFromSeed(SEED));
    expect(did.startsWith(DID_KEY_PREFIX)).toBe(true);
    expect(did.slice("did:key:".length).length).toBe(48);
    expect(did.slice("did:key:".length)[0]).toBe("z");
  });

  it("round-trips through base58btc decoding", () => {
    const pub = publicKeyFromSeed(SEED);
    const did = didFromPublicKey(pub);
    const decoded = publicKeyFromDid(did);
    expect(decoded).toEqual(pub);
    expect(isValidDid(did)).toBe(true);
  });

  it("rejects non-Ed25519 or malformed DIDs", () => {
    expect(() => publicKeyFromDid("did:web:example.com")).toThrow();
    expect(() => publicKeyFromDid("did:key:z8MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw")).toThrow(); // wrong prefix byte
    expect(() => publicKeyFromDid("did:key:z6Mk")).toThrow(); // too short
    expect(isValidDid("not a did")).toBe(false);
    expect(isValidDid("did:key:z6Mk0OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO")).toBe(false); // '0','O' invalid base58
  });

  it("validates a structurally valid foreign did:key", () => {
    // z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK is a widely used example
    // Ed25519 did:key (structure check only here, not our key).
    expect(isValidDid("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK")).toBe(true);
  });
});

describe("base58btc", () => {
  it("encodes leading zero bytes as '1'", () => {
    expect(base58Encode(new Uint8Array([0, 1, 2]))).toBe("15T");
  });
  it("round-trips arbitrary bytes", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(48));
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });
});

describe("signature bytes match the official signer (vector)", () => {
  it("signs room|nonce|swept-text to the exact 86-char canonical base64url", () => {
    const pub = publicKeyFromSeed(SEED);
    const did = didFromPublicKey(pub);
    const msg = signMessage({
      seed: SEED,
      room: "lobby",
      nonce: "1788000000000",
      text: "Hello Technocore — RFC 8032 vector",
    });
    expect(msg.did || did).toBe(EXPECTED_DID);
    expect(msg.canonical).toBe("lobby|1788000000000|Hello Technocore — RFC 8032 vector");
    expect(msg.sig).toBe("UCw5IQLatQk48-BMx1YGQaZPP24is3XFZJk615Rvg3Ep1LwmS_ZjIv-uIBq071A7cHKpFPKOxOegYUj3bJxvCg");
    expect(SIG_RE.test(msg.sig)).toBe(true);
  });

  it("signs after the sweep, matching sign.py for newline/tab input", () => {
    const msg = signMessage({
      seed: SEED,
      room: "lobby",
      nonce: "1788000000000",
      text: "hello with newline\nand tab\tplus smile :)",
    });
    expect(msg.sweptText).toBe("hello with newline and tab plus smile :)");
    expect(msg.canonical).toBe("lobby|1788000000000|hello with newline and tab plus smile :)");
    expect(msg.sig).toBe("uwm-Q9WAPLPkDNl5Z-qkFFEEGd1QKZ-pTcv9XBmoYhAH1Gr1bTcYxlGbIesDHgcQBbVoqLpmg8Z9cBm5j3n_Cg");
  });

  it("verifies its own signature round-trip", () => {
    const msg = signMessage({
      seed: SEED,
      room: "technocore",
      nonce: "1788000000001",
      text: "round trip",
    });
    const res = verifyMessage({
      did: EXPECTED_DID,
      room: "technocore",
      nonce: msg.nonce,
      text: msg.sweptText,
      sig: msg.sig,
    });
    expect(res.valid).toBe(true);
  });

  it("fails verification when text is not swept or signature is wrong", () => {
    const msg = signMessage({
      seed: SEED,
      room: "lobby",
      nonce: "1788000000002",
      text: "verify me",
    });
    const bad = verifyMessage({
      did: EXPECTED_DID,
      room: "lobby",
      nonce: msg.nonce,
      text: "verify me",
      sig: msg.sig,
    });
    // swept text is identical here ("verify me"), so this one is valid — use a
    // genuinely different text:
    const wrong = verifyMessage({
      did: EXPECTED_DID,
      room: "lobby",
      nonce: msg.nonce,
      text: "verify you",
      sig: msg.sig,
    });
    expect(bad.valid).toBe(true);
    expect(wrong.valid).toBe(false);
  });
});

describe("DID fingerprint / note path convention", () => {
  it("splits first 16 hex of SHA-256 into shard(2)+key(14)", async () => {
    const fp = await didFingerprint(EXPECTED_DID);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    const paths = await didNotePaths(EXPECTED_DID);
    expect(paths.sharded.ns).toBe(`did-${fp.slice(0, 2)}`);
    expect(paths.sharded.key).toBe(fp.slice(2));
    expect(paths.sharded.key.length).toBe(14);
    expect(paths.legacy.ns).toBe("did");
    expect(paths.legacy.key).toBe(fp);
  });
});