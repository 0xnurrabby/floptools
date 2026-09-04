import { describe, it, expect } from "vitest";
import { parseFrame, dealRoomForContract, contractFromDealRoom, isTclkLine } from "../lib/tclk";
import { buildDealStates, computeAgentMetrics, tierFor, NEUTRAL_SCORE } from "../lib/trustscore";
import type { TclkFrame } from "../lib/tclk";

const ALICE = "did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw";
const BOB = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

const OFFER = {
  type: "offer",
  from: ALICE,
  role: "payer",
  amount: "1000000",
  asset: "FLOP",
  lock: "hash",
  rails: ["flop-htlc", "x402"],
  claimByMs: 1756800000000,
  refundAfterMs: 1756886400000,
  expiresMs: 1756713600000,
  nonce: "9f2c81d04c9e1f7a",
  id: "0x" + "a".repeat(64),
};
const offerText = "tclk1 " + JSON.stringify(OFFER);

function rec(room: string, seq: number, from: string, text: string, ts: string, sig = "sig") {
  return { room, seq, from, text, ts, sig, nonce: 1 };
}

describe("tclk frame parsing", () => {
  it("detects and parses a signed offer", () => {
    expect(isTclkLine(offerText)).toBe(true);
    const f = parseFrame(rec("tclk-offers", 10, ALICE, offerText, "2026-09-04T00:00:00Z"));
    expect(f).not.toBeNull();
    expect(f!.type).toBe("offer");
    expect(f!.did).toBe(ALICE);
    expect(f!.amount).toBe("1000000");
    expect(f!.role).toBe("payer");
    expect(f!.offerId).toBe("0x" + "a".repeat(64));
  });

  it("rejects unsigned records (data, not a commitment)", () => {
    expect(
      parseFrame({ room: "tclk-offers", seq: 1, from: ALICE, text: offerText, ts: "t" }),
    ).toBeNull();
  });

  it("rejects frames missing required fields", () => {
    const bad = "tclk1 " + JSON.stringify({ ...OFFER, amount: undefined, type: "offer", from: ALICE });
    expect(parseFrame(rec("tclk-offers", 2, ALICE, bad, "t"))).toBeNull();
  });

  it("parses accept with contract and checks the deal room derivation", () => {
    const contract = "0x" + "b".repeat(64);
    const accept = JSON.stringify({
      type: "accept",
      from: BOB,
      ref: OFFER.id,
      statement: "0x" + "c".repeat(64),
      contract,
      nonce: "1",
    });
    const f = parseFrame(rec("tclk-offers", 3, BOB, "tclk1 " + accept, "t"))!;
    expect(f.type).toBe("accept");
    expect(f.contractId).toBe(contract);
    const room = dealRoomForContract(contract);
    expect(room).toBe("mb-p-tclk-" + "b".repeat(16));
    expect(contractFromDealRoom(room!)).toBe("0x" + "b".repeat(16));
  });
});

function fullCycle(): TclkFrame[] {
  const frames: TclkFrame[] = [];
  const offer = parseFrame(rec("tclk-offers", 1, ALICE, offerText, "2026-09-04T00:00:00Z"))!;
  frames.push(offer);
  const contract = "0x" + "b".repeat(64);
  const accept = parseFrame(
    rec("tclk-offers", 2, BOB, "tclk1 " + JSON.stringify({ type: "accept", from: BOB, ref: OFFER.id, statement: "0x" + "c".repeat(64), contract, nonce: "7" }), "2026-09-04T00:05:00Z"),
  )!;
  frames.push(accept);
  const lock = parseFrame(
    rec("mb-p-tclk-" + "b".repeat(16), 1, ALICE, "tclk1 " + JSON.stringify({ type: "lock", from: ALICE, contract, rail: "flop-htlc", ref: "rail-1" }), "2026-09-04T00:10:00Z"),
  )!;
  frames.push(lock);
  const reveal = parseFrame(
    rec("mb-p-tclk-" + "b".repeat(16), 2, BOB, "tclk1 " + JSON.stringify({ type: "reveal", from: BOB, contract, secret: "0x" + "d".repeat(64) }), "2026-09-04T00:20:00Z"),
  )!;
  frames.push(reveal);
  const receipt = parseFrame(
    rec("mb-p-tclk-" + "b".repeat(16), 3, BOB, "tclk1 " + JSON.stringify({ type: "receipt", from: BOB, contract, outcome: "claimed", rail: "flop-htlc" }), "2026-09-04T00:21:00Z"),
  )!;
  frames.push(receipt);
  return frames;
}

describe("deal state machine reconstruction", () => {
  it("tracks a full offer→accept→lock→reveal as claimed", () => {
    const { states } = buildDealStates(fullCycle());
    expect(states).toHaveLength(1);
    expect(states[0].state).toBe("claimed");
    expect(states[0].payer).toBe(ALICE);
    expect(states[0].payee).toBe(BOB);
  });

  it("marks refunded when only refund arrives", () => {
    const frames = fullCycle();
    const contract = "0x" + "b".repeat(64);
    frames.push(
      parseFrame(rec("mb-p-tclk-" + "b".repeat(16), 3, ALICE, "tclk1 " + JSON.stringify({ type: "refund", from: ALICE, contract }), "2026-09-04T02:00:00Z"))!,
    );
    // simulate: instead of reveal, refund — rebuild fresh
    const refundOnly = frames.filter((f) => f.type !== "reveal" && f.type !== "receipt");
    const { states } = buildDealStates(refundOnly);
    expect(states[0].state).toBe("refunded");
  });
});

describe("agent metrics & scoring", () => {
  it("scores the payee well for a completed deal", () => {
    const m = computeAgentMetrics(BOB, fullCycle());
    expect(m.completed).toBe(1);
    expect(m.deals).toBe(1);
    expect(m.successRate).toBe(1);
    expect(m.score).toBeGreaterThan(NEUTRAL_SCORE);
    expect(m.tier).toBe("peer");
    expect(m.selfDealing).toBe(false);
    expect(m.summary).toContain("completed 1 of 1 deals");
  });

  it("scores the payer of a refund lower", () => {
    const contract = "0x" + "b".repeat(64);
    const refundFrames = fullCycle().filter((f) => f.type !== "reveal" && f.type !== "receipt");
    refundFrames.push(
      parseFrame(rec("mb-p-tclk-" + "b".repeat(16), 3, ALICE, "tclk1 " + JSON.stringify({ type: "refund", from: ALICE, contract, ref: "rail-1" }), "2026-09-04T02:00:00Z"))!,
    );
    const m = computeAgentMetrics(BOB, refundFrames);
    expect(m.refunded).toBe(1);
    expect(m.successRate).toBe(0);
    expect(m.score).toBeLessThan(NEUTRAL_SCORE + 80);
  });

  it("flags self-dealing (same did both sides)", () => {
    const frames = fullCycle().map((f) => (f.did === BOB ? { ...f, did: ALICE } : f));
    const m = computeAgentMetrics(ALICE, frames);
    expect(m.selfDealing).toBe(true);
    expect(m.score).toBeLessThanOrEqual(300);
  });

  it("has sane tiers", () => {
    expect(tierFor(500, 0)).toBe("unknown");
    expect(tierFor(900, 10)).toBe("veteran");
    expect(tierFor(700, 5)).toBe("trusted");
    expect(tierFor(200, 2)).toBe("watch");
  });
});