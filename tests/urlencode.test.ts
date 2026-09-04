import { describe, it, expect } from "vitest";
import {
  encodePathSegment,
  signedSayPath,
  unsignedSayPath,
  noteSetPath,
  roomReadPath,
  isValidName,
  assertValidRoom,
} from "../lib/urlencode";

const DID = "did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw";
const SIG =
  "UCw5IQLatQk48-BMx1YGQaZPP24is3XFZJk615Rvg3Ep1LwmS_ZjIv-uIBq071A7cHKpFPKOxOegYUj3bJxvCg";

describe("URL encoding (GET write lane)", () => {
  it("builds the canonical say-signed URL shape", () => {
    const path = signedSayPath({
      room: "lobby",
      did: DID,
      sig: SIG,
      nonce: "1788000000000",
      text: "Hello Technocore — RFC 8032 vector",
    });
    expect(path).toBe(
      `/r/lobby/say-signed/${DID}/${SIG}/1788000000000/${encodeURIComponent("Hello Technocore — RFC 8032 vector").replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`,
    );
  });

  it("encodes spaces, slashes, percent and newlines inside text", () => {
    const p = signedSayPath({
      room: "lobby",
      did: DID,
      sig: SIG,
      nonce: "1",
      text: "a/b c% d\ne",
    });
    expect(p).toContain("/a%2Fb%20c%25%20d%0Ae");
    expect(p).not.toContain("%2F%2F"); // no empty segments
  });

  it("does not double-encode the signature or the DID", () => {
    const p = signedSayPath({
      room: "lobby",
      did: DID,
      sig: SIG,
      nonce: "1",
      text: "hi",
    });
    // signature appears verbatim
    expect(p).toContain(SIG);
    // did:key ':' present exactly twice
    const colonCount = p.slice(0, p.indexOf("/hi")).split(":").length - 1;
    expect(colonCount).toBe(2);
  });

  it("signature chars are URL-safe and unencoded", () => {
    const encoded = encodePathSegment(SIG);
    expect(encoded).toBe(SIG);
  });

  it("unsigned say path encodes nick and text", () => {
    expect(unsignedSayPath({ room: "lobby", nick: "bob", text: "hi there" })).toBe(
      "/r/lobby/say/bob/hi%20there",
    );
  });

  it("note set path supports if_absent and if= conditions", () => {
    expect(noteSetPath("did-3f", "9c0a1d7e2b4c56", "did:key:z6Mk abc", { ifAbsent: true })).toBe(
      "/kv/did-3f/9c0a1d7e2b4c56/set/did%3Akey%3Az6Mk%20abc?if_absent=1",
    );
    expect(noteSetPath("ns", "key", "v", { if: "old" })).toBe("/kv/ns/key/set/v?if=old");
  });

  it("room read path builds query params", () => {
    expect(roomReadPath("lobby", { since: 5, limit: 20, wait: 10, format: "json" })).toBe(
      "/r/lobby?since=5&limit=20&wait=10&format=json",
    );
  });

  it("validates room names", () => {
    expect(isValidName("lobby")).toBe(true);
    expect(isValidName("mb-p-abc123")).toBe(true);
    expect(isValidName("e-commerce")).toBe(true); // hyphen allowed after first char
    expect(isValidName("-commerce")).toBe(false); // must not start with '-'
    expect(isValidName("UPPER")).toBe(false);
    expect(isValidName("has space")).toBe(false);
    expect(() => assertValidRoom("../../etc")).toThrow();
  });

  it("keeps non-ASCII text encoded as UTF-8 bytes", () => {
    expect(encodePathSegment("Việt")).toBe("Vi%E1%BB%87t");
  });
});