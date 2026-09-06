import { describe, expect, it } from "vitest";
import * as ref from "@flop-labs/tclk";
import * as mine from "../lib/tclk-deal";
import { publicKeyFromSeed } from "../lib/crypto";
import { didFromPublicKey } from "../lib/didkey";

function didFromByte(b: number): string {
  return didFromPublicKey(publicKeyFromSeed(new Uint8Array(32).fill(b)));
}

const PAYER = didFromByte(1);
const PAYEE = didFromByte(2);

const BASE = {
  amount: "1000000",
  asset: "FLOP",
  claimByMs: 1757300000000,
  refundAfterMs: 1757386400000,
  expiresMs: 1757213600000,
};

const T0 = 1757000000000; // 2025-09-05 — safely inside every window above
const t = (i: number) => new Date(T0 + i * 1000).toISOString();

function refOfferInputs(nonce: string) {
  return {
    from: PAYER,
    role: "payer" as const,
    ...BASE,
    lock: "hash" as const,
    rails: ["paper"],
    nonce,
  };
}

describe("tclk-deal conformance with @flop-labs/tclk", () => {
  it("offer id and wire line are byte-identical", async () => {
    const myOffer = await mine.makeOffer({
      from: PAYER,
      role: "payer",
      ...BASE,
      job: { proto: "text", id: "job-42", context: "Write a walkthrough, 300 words." },
    });
    const refOffer = ref.makeOffer({
      ...refOfferInputs(myOffer.nonce),
      job: { proto: "text", id: "job-42", context: "Write a walkthrough, 300 words." },
    });
    expect(myOffer.id).toBe(refOffer.id);
    expect(mine.encodeFrame(myOffer)).toBe(ref.encodeFrame(refOffer));
  });

  it("offer id with non-ASCII job context matches (ASCII-escape before hashing)", async () => {
    const myOffer = await mine.makeOffer({
      from: PAYER,
      role: "payer",
      ...BASE,
      job: { proto: "text", id: "job-1", context: "একটি ব্লগ লিখুন — 300 words" },
    });
    const refOffer = ref.makeOffer({
      ...refOfferInputs(myOffer.nonce),
      job: { proto: "text", id: "job-1", context: "একটি ব্লগ লিখুন — 300 words" },
    });
    expect(myOffer.id).toBe(refOffer.id);
    expect(mine.encodeFrame(myOffer)).toBe(ref.encodeFrame(refOffer));
  });

  it("accept: statement, contract id and line match", async () => {
    const myOffer = await mine.makeOffer({ from: PAYER, role: "payer", ...BASE });
    const refOffer = ref.makeOffer(refOfferInputs(myOffer.nonce));
    const preimage = `0x${"ab".repeat(32)}`;
    const myLock = await mine.hashLockFromPreimage(preimage);
    const refLock = ref.hashLockFromPreimage(preimage);
    expect(myLock.hash).toBe(refLock.hash);

    const myAccept = await mine.makeAccept(myOffer, { from: PAYEE, statement: myLock.hash });
    const refAccept = ref.makeAccept(refOffer, { from: PAYEE, statement: refLock.hash, nonce: myAccept.nonce });
    expect(myAccept.contract).toBe(refAccept.contract);
    expect(mine.encodeFrame(myAccept)).toBe(ref.encodeFrame(refAccept));
  });

  it("lock / reveal / refund / cancel / receipt lines match", async () => {
    const myOffer = await mine.makeOffer({ from: PAYER, role: "payer", ...BASE });
    const myLock = await mine.hashLockFromPreimage(`0x${"cd".repeat(32)}`);
    const refLock = ref.hashLockFromPreimage(`0x${"cd".repeat(32)}`);
    const myAccept = await mine.makeAccept(myOffer, { from: PAYEE, statement: myLock.hash });
    const c = myAccept.contract;

    const myLockFrame = mine.makeLock({ from: PAYER, contract: c, rail: "paper", ref: c });
    expect(mine.encodeFrame(myLockFrame)).toBe(ref.encodeFrame({ type: "lock", from: PAYER, contract: c, rail: "paper", ref: c }));

    // reveal without ref (0.1.0-compatible); main SPEC §3.4 says ref is optional
    const myReveal = mine.makeReveal({ from: PAYEE, contract: c, secret: myLock.preimage });
    expect(mine.encodeFrame(myReveal)).toBe(ref.encodeFrame({ type: "reveal", from: PAYEE, contract: c, secret: refLock.preimage }));

    const myRefund = mine.makeRefund({ from: PAYER, contract: c, reason: "never delivered" });
    expect(mine.encodeFrame(myRefund)).toBe(ref.encodeFrame({ type: "refund", from: PAYER, contract: c, reason: "never delivered" }));

    const myCancel = mine.makeCancel({ from: PAYEE, contract: c, reason: "changed mind" });
    expect(mine.encodeFrame(myCancel)).toBe(ref.encodeFrame({ type: "cancel", from: PAYEE, contract: c, reason: "changed mind" }));

    const myReceipt = mine.makeReceipt({ from: PAYEE, contract: c, outcome: "claimed", rail: "paper", ref: c });
    expect(mine.encodeFrame(myReceipt)).toBe(ref.encodeFrame({ type: "receipt", from: PAYEE, contract: c, outcome: "claimed", rail: "paper", ref: c }));
  });

  it("reveal/refund with ref (main SPEC §3.4) round-trip and pass my own guards", async () => {
    const offer = await mine.makeOffer({ from: PAYER, role: "payer", ...BASE });
    const preimage = `0x${"78".repeat(32)}`;
    const hash = (await mine.hashLockFromPreimage(preimage)).hash;
    const accept = await mine.makeAccept(offer, { from: PAYEE, statement: hash });
    const c = accept.contract;
    const deal = mine.dealRoom(c)!;
    const reveal = mine.makeReveal({ from: PAYEE, contract: c, ref: c, secret: preimage });
    const line = mine.encodeFrame(reveal);
    const decoded = mine.decodeFrame(line);
    expect(decoded).toEqual(reveal);
    expect(mine.encodeFrame(decoded!)).toBe(line);

    const records: mine.RecordInput[] = [
      { room: "tclk-offers", from: PAYER, text: mine.encodeFrame(offer), seq: 1, ts: t(0), sig: "s" },
      { room: "tclk-offers", from: PAYEE, text: mine.encodeFrame(accept), seq: 2, ts: t(1), sig: "s" },
      { room: deal, from: PAYER, text: mine.encodeFrame(mine.makeLock({ from: PAYER, contract: c, rail: "paper", ref: c })), seq: 3, ts: t(2), sig: "s" },
      { room: deal, from: PAYEE, text: line, seq: 4, ts: t(3), sig: "s" },
    ];
    const fold = await mine.foldContract(records, null, { now: T0, contract: c });
    expect(fold.state).toBe("claimed");
    expect(fold.reveal?.ref).toBe(c);
  });

  it("paper rail record and note path match", () => {
    const c = `0x${"a".repeat(64)}`;
    const rec = { status: "locked" as const, lock: "hash" as const, statement: `0x${"b".repeat(64)}`, refundAfterMs: 1757386400000 };
    expect(mine.encodePaperRecord(rec)).toBe(ref.encodePaperRecord(rec));
    expect(mine.decodePaperRecord(ref.encodePaperRecord(rec))).toEqual(rec);
    expect(mine.paperNote(c)).toEqual(ref.paperNote(c));
  });

  it("canonical JSON matches for a nested frame object", () => {
    const obj = { z: 1, a: { d: [1, 2], b: null }, m: "x" };
    expect(mine.canonicalJson(obj)).toBe(ref.canonicalJson(obj));
  });

  it("full lifecycle folds to claimed, same as the reference state machine", async () => {
    const now = T0;
    const offer = await mine.makeOffer({ from: PAYER, role: "payer", ...BASE });
    const refOffer = ref.makeOffer(refOfferInputs(offer.nonce));
    const preimage = `0x${"12".repeat(32)}`;
    const myLock = await mine.hashLockFromPreimage(preimage);
    const refLock = ref.hashLockFromPreimage(preimage);
    const accept = await mine.makeAccept(offer, { from: PAYEE, statement: myLock.hash });
    const refAccept = ref.makeAccept(refOffer, { from: PAYEE, statement: refLock.hash, nonce: accept.nonce });
    const c = accept.contract;
    const deal = mine.dealRoom(c)!;

    const records: mine.RecordInput[] = [
      { room: "tclk-offers", from: PAYER, text: mine.encodeFrame(offer), seq: 1, ts: t(0), sig: "s" },
      { room: "tclk-offers", from: PAYEE, text: mine.encodeFrame(accept), seq: 2, ts: t(1), sig: "s" },
      { room: deal, from: PAYER, text: mine.encodeFrame(mine.makeLock({ from: PAYER, contract: c, rail: "paper", ref: c })), seq: 3, ts: t(2), sig: "s" },
      { room: deal, from: PAYEE, text: mine.encodeFrame(mine.makeReveal({ from: PAYEE, contract: c, secret: preimage })), seq: 4, ts: t(3), sig: "s" },
      { room: deal, from: PAYEE, text: mine.encodeFrame(mine.makeReceipt({ from: PAYEE, contract: c, outcome: "claimed", rail: "paper", ref: c })), seq: 5, ts: t(4), sig: "s" },
    ];
    const paper = mine.decodePaperRecord(mine.encodePaperRecord({
      status: "claimed",
      lock: "hash",
      statement: myLock.hash,
      refundAfterMs: BASE.refundAfterMs,
      secret: preimage,
    }));

    const fold = await mine.foldContract(records, paper, { now, contract: c });
    expect(fold.state).toBe("claimed");
    expect(fold.receipt?.outcome).toBe("claimed");
    expect(fold.steps.filter((s) => s.step !== "work").every((s) => s.done)).toBe(true);

    let state = ref.openContract(refOffer);
    state = ref.applyFrame(state, refAccept, T0 + 1000).state;
    state = ref.applyFrame(state, { type: "lock", from: PAYER, contract: c, rail: "paper", ref: c }, T0 + 2000).state;
    state = ref.applyFrame(state, { type: "reveal", from: PAYEE, contract: c, secret: refLock.preimage }, T0 + 3000).state;
    state = ref.applyFrame(state, { type: "receipt", from: PAYEE, contract: c, outcome: "claimed", rail: "paper", ref: c }, T0 + 4000).state;
    expect(state.status).toBe("claimed");
  });

  it("guards: wrong-party lock and wrong secret do not advance", async () => {
    const offer = await mine.makeOffer({ from: PAYER, role: "payer", ...BASE });
    const preimage = `0x${"34".repeat(32)}`;
    const hash = (await mine.hashLockFromPreimage(preimage)).hash;
    const accept = await mine.makeAccept(offer, { from: PAYEE, statement: hash });
    const c = accept.contract;
    const deal = mine.dealRoom(c)!;

    const base: mine.RecordInput[] = [
      { room: "tclk-offers", from: PAYER, text: mine.encodeFrame(offer), seq: 1, ts: t(0), sig: "s" },
      { room: "tclk-offers", from: PAYEE, text: mine.encodeFrame(accept), seq: 2, ts: t(1), sig: "s" },
    ];

    const wrongLock = [...base, { room: deal, from: PAYEE, text: mine.encodeFrame(mine.makeLock({ from: PAYEE, contract: c, rail: "paper", ref: c })), seq: 3, ts: t(2), sig: "s" }];
    expect((await mine.foldContract(wrongLock, null, { contract: c })).state).toBe("accepted");

    const lockRec = { room: deal, from: PAYER, text: mine.encodeFrame(mine.makeLock({ from: PAYER, contract: c, rail: "paper", ref: c })), seq: 3, ts: t(2), sig: "s" };
    const badSecret = { room: deal, from: PAYEE, text: mine.encodeFrame(mine.makeReveal({ from: PAYEE, contract: c, ref: c, secret: `0x${"99".repeat(32)}` })), seq: 4, ts: t(3), sig: "s" };
    const fold = await mine.foldContract([...base, lockRec, badSecret], null, { contract: c });
    expect(fold.state).toBe("locked");
    expect(fold.reveal).toBeNull();
  });

  it("nextGuard: payer must write the paper record before the lock", async () => {
    const offer = await mine.makeOffer({ from: PAYER, role: "payer", ...BASE });
    const hash = (await mine.hashLockFromPreimage(`0x${"56".repeat(32)}`)).hash;
    const accept = await mine.makeAccept(offer, { from: PAYEE, statement: hash });
    const records: mine.RecordInput[] = [
      { room: "tclk-offers", from: PAYER, text: mine.encodeFrame(offer), seq: 1, ts: t(0), sig: "s" },
      { room: "tclk-offers", from: PAYEE, text: mine.encodeFrame(accept), seq: 2, ts: t(1), sig: "s" },
    ];
    const fold = await mine.foldContract(records, null, { contract: accept.contract });
    const guard = mine.nextGuard(fold, null, { myDid: PAYER });
    expect(guard.action).toBe("write paper record");
    expect(guard.blocked).toBe(false);

    const paper = mine.decodePaperRecord(mine.encodePaperRecord({
      status: "locked",
      lock: "hash",
      statement: hash,
      refundAfterMs: BASE.refundAfterMs,
    }));
    const after = mine.nextGuard(await mine.foldContract(records, paper, { contract: accept.contract }), paper, { myDid: PAYER });
    expect(after.action).toBe("post lock");

    // a record that exists but does NOT match the signed statement blocks the lock
    const wrongPaper = mine.decodePaperRecord(mine.encodePaperRecord({
      status: "locked",
      lock: "hash",
      statement: `0x${"ff".repeat(32)}`,
      refundAfterMs: BASE.refundAfterMs,
    }))!;
    const blocked = mine.nextGuard(await mine.foldContract(records, wrongPaper, { contract: accept.contract }), wrongPaper, { myDid: PAYER });
    expect(blocked.blocked).toBe(true);
    expect(blocked.action).toBe("fix paper record");
  });

  it("anchors the pair by contract id when several offers are in the room", async () => {
    const offerA = await mine.makeOffer({ from: PAYER, role: "payer", ...BASE });
    const offerB = await mine.makeOffer({ from: didFromByte(3), role: "payer", ...BASE, amount: "200" });
    const preA = await mine.hashLockFromPreimage(`0x${"01".repeat(32)}`);
    const preB = await mine.hashLockFromPreimage(`0x${"02".repeat(32)}`);
    const acceptA = await mine.makeAccept(offerA, { from: PAYEE, statement: preA.hash });
    const acceptB = await mine.makeAccept(offerB, { from: didFromByte(4), statement: preB.hash });

    // B's records come FIRST — a naive "first offer in the room" fold would pick B.
    const records: mine.RecordInput[] = [
      { room: "tclk-offers", from: didFromByte(3), text: mine.encodeFrame(offerB), seq: 1, ts: t(0), sig: "s" },
      { room: "tclk-offers", from: didFromByte(4), text: mine.encodeFrame(acceptB), seq: 2, ts: t(1), sig: "s" },
      { room: "tclk-offers", from: PAYER, text: mine.encodeFrame(offerA), seq: 3, ts: t(2), sig: "s" },
      { room: "tclk-offers", from: PAYEE, text: mine.encodeFrame(acceptA), seq: 4, ts: t(3), sig: "s" },
    ];

    const foldA = await mine.foldContract(records, null, { contract: acceptA.contract });
    expect(foldA.state).toBe("accepted");
    expect(foldA.offer?.id).toBe(offerA.id);
    expect(foldA.accept?.from).toBe(PAYEE);

    const foldB = await mine.foldContract(records, null, { contract: acceptB.contract });
    expect(foldB.state).toBe("accepted");
    expect(foldB.offer?.id).toBe(offerB.id);
  });

  it("fails closed when the accept record has no timestamp", async () => {
    const offer = await mine.makeOffer({ from: PAYER, role: "payer", ...BASE });
    const preimage = `0x${"45".repeat(32)}`;
    const hash = (await mine.hashLockFromPreimage(preimage)).hash;
    const accept = await mine.makeAccept(offer, { from: PAYEE, statement: hash });
    const records: mine.RecordInput[] = [
      { room: "tclk-offers", from: PAYER, text: mine.encodeFrame(offer), seq: 1, ts: t(0), sig: "s" },
      { room: "tclk-offers", from: PAYEE, text: mine.encodeFrame(accept), seq: 2, ts: "", sig: "s" },
    ];
    const fold = await mine.foldContract(records, null, { contract: accept.contract });
    expect(fold.state).toBe("proposed");
    expect(fold.stateReason).toContain("missing or malformed");
  });

  it("reports honestly when no pair hashes to the contract id", async () => {
    const offer = await mine.makeOffer({ from: PAYER, role: "payer", ...BASE });
    const accept = await mine.makeAccept(offer, { from: PAYEE, statement: (await mine.hashLockFromPreimage(`0x${"67".repeat(32)}`)).hash });
    const records: mine.RecordInput[] = [
      { room: "tclk-offers", from: PAYER, text: mine.encodeFrame(offer), seq: 1, ts: t(0), sig: "s" },
      { room: "tclk-offers", from: PAYEE, text: mine.encodeFrame(accept), seq: 2, ts: t(1), sig: "s" },
    ];
    const fold = await mine.foldContract(records, null, { contract: `0x${"ab".repeat(32)}` });
    expect(fold.offer).toBeNull();
    expect(fold.state).toBe("proposed");
    expect(fold.steps.find((s) => s.step === "offer")?.reason).toContain("hashes to this contract id");
  });

  it("folds to expired when the accept lands after the offer window closed", async () => {
    const short = await mine.makeOffer({ from: PAYER, role: "payer", ...BASE, expiresMs: T0 + 1000 });
    const preimage = `0x${"89".repeat(32)}`;
    const accept = await mine.makeAccept(short, { from: PAYEE, statement: (await mine.hashLockFromPreimage(preimage)).hash });
    const records: mine.RecordInput[] = [
      { room: "tclk-offers", from: PAYER, text: mine.encodeFrame(short), seq: 1, ts: t(0), sig: "s" },
      // accept ts t(10) = T0+10s — AFTER expiresMs T0+1s
      { room: "tclk-offers", from: PAYEE, text: mine.encodeFrame(accept), seq: 2, ts: t(10), sig: "s" },
    ];
    const fold = await mine.foldContract(records, null, { contract: accept.contract, now: T0 + 5000 });
    expect(fold.state).toBe("expired");
    expect(fold.stateReason).toContain("expired");
    expect(fold.steps.find((s) => s.step === "accept")?.reason).toContain("expired");
    const guard = mine.nextGuard(fold, null, { myDid: PAYER });
    expect(guard.action).toBe("expired");
    expect(guard.blocked).toBe(true);
  });

  it("does not expire a deal that was accepted in time", async () => {
    const offer = await mine.makeOffer({ from: PAYER, role: "payer", ...BASE });
    const accept = await mine.makeAccept(offer, { from: PAYEE, statement: (await mine.hashLockFromPreimage(`0x${"9a".repeat(32)}`)).hash });
    const records: mine.RecordInput[] = [
      { room: "tclk-offers", from: PAYER, text: mine.encodeFrame(offer), seq: 1, ts: t(0), sig: "s" },
      { room: "tclk-offers", from: PAYEE, text: mine.encodeFrame(accept), seq: 2, ts: t(1), sig: "s" },
    ];
    const fold = await mine.foldContract(records, null, { contract: accept.contract, now: BASE.expiresMs + 3_600_000 });
    expect(fold.state).toBe("accepted");
    const guard = mine.nextGuard(fold, null, { myDid: PAYER });
    expect(guard.action).toBe("write paper record");
  });

  it("falls back to the deal-room mirror when the pair has left the offers ring", async () => {
    const offer = await mine.makeOffer({ from: PAYER, role: "payer", ...BASE });
    const preimage = `0x${"bc".repeat(32)}`;
    const accept = await mine.makeAccept(offer, { from: PAYEE, statement: (await mine.hashLockFromPreimage(preimage)).hash });
    const room = mine.dealRoom(accept.contract)!;
    // ring rotated: only the mirror copy remains, in the deal room
    const records: mine.RecordInput[] = [
      { room, from: PAYER, text: mine.encodeFrame(offer), seq: 1, ts: t(0), sig: "s" },
      { room, from: PAYEE, text: mine.encodeFrame(accept), seq: 2, ts: t(1), sig: "s" },
    ];
    const fold = await mine.foldContract(records, null, { contract: accept.contract, now: T0 });
    expect(fold.pairSource).toBe("mirror");
    expect(fold.state).toBe("accepted");
    expect(fold.offer?.id).toBe(offer.id);
    expect(fold.accept?.from).toBe(PAYEE);
  });

  it("rejects a forged mirror that does not hash to the contract id", async () => {
    const offer = await mine.makeOffer({ from: PAYER, role: "payer", ...BASE });
    const accept = await mine.makeAccept(offer, { from: PAYEE, statement: (await mine.hashLockFromPreimage(`0x${"cd".repeat(32)}`)).hash });
    const room = mine.dealRoom(accept.contract)!;
    const other = await mine.makeOffer({ from: didFromByte(9), role: "payer", ...BASE, amount: "999" });
    const records: mine.RecordInput[] = [
      { room, from: PAYER, text: mine.encodeFrame(other), seq: 1, ts: t(0), sig: "s" },
      { room, from: PAYEE, text: mine.encodeFrame(accept), seq: 2, ts: t(1), sig: "s" },
    ];
    const fold = await mine.foldContract(records, null, { contract: accept.contract, now: T0 });
    expect(fold.pairSource).toBeNull();
    expect(fold.offer).toBeNull();
  });
});
