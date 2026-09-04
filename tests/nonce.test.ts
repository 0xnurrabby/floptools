import { describe, it, expect } from "vitest";
import {
  nextNonce,
  nonceGreater,
  isValidNonce,
  createLocalNonceStore,
} from "../lib/nonce";

describe("nonce handling", () => {
  it("produces 1-19 ASCII digits", () => {
    const n = nextNonce();
    expect(isValidNonce(n)).toBe(true);
    expect(n.length).toBeLessThanOrEqual(19);
  });

  it("is monotonic over repeated calls", () => {
    const a = nextNonce();
    const b = nextNonce();
    expect(nonceGreater(a, b)).toBe(true);
  });

  it("bumps past a stored last nonce (even in the future)", () => {
    const next = nextNonce("999999999999999999"); // 18 nines
    expect(nonceGreater("999999999999999999", next)).toBe(true);
  });

  it("returns true when there is no previous nonce", () => {
    expect(nonceGreater(undefined, "123")).toBe(true);
  });

  it("treats the timestamp clock correctly (non-decreasing)", () => {
    const last = String(Date.now());
    const next = nextNonce(last);
    expect(nonceGreater(last, next)).toBe(true);
  });

  it("rejects non-ASCII digits (server refuses them)", () => {
    expect(isValidNonce("١٢٣")).toBe(false);
    expect(isValidNonce("123")).toBe(true);
    expect(isValidNonce("01234567890123456789")).toBe(false); // 20 digits
  });
});

describe("local nonce store", () => {
  it("persists per (did, room) and survives re-reads", () => {
    const store = createLocalNonceStore();
    store.set("did:key:z6Mkxyz", "lobby", "12345");
    expect(store.get("did:key:z6Mkxyz", "lobby")).toBe("12345");
    expect(store.get("did:key:z6Mkxyz", "technocore")).toBeUndefined();
    expect(store.get("did:key:z6Mkabc", "lobby")).toBeUndefined();
    store.clear("did:key:z6Mkxyz");
    expect(store.get("did:key:z6Mkxyz", "lobby")).toBeUndefined();
  });
});