import { describe, it, expect, vi } from "vitest";
import { TechnocoreClient, TechnocoreError } from "../lib/technocore";
import { checkDid, parseDidNote, verifyRecord } from "../lib/check";
import { verifyMessage } from "../lib/sign";
import { generateSeed } from "../lib/crypto";
import { signMessage } from "../lib/sign";

const DID = "did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw";

function mockClient(responses: Record<string, { status: number; body: string }>) {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    for (const [key, val] of Object.entries(responses)) {
      if (url.includes(key)) {
        return new Response(val.body, { status: val.status });
      }
    }
    return new Response(`unhandled: ${url}`, { status: 500 });
  }) as typeof fetch;
  return new TechnocoreClient({ mode: "direct", baseUrl: "https://technocore.chat", fetchImpl });
}

const ROOM_JSON = (msgs: unknown[]) =>
  JSON.stringify({
    room: "lobby",
    count: msgs.length,
    first_seq: 1,
    last_seq: msgs.length,
    generation: 0,
    messages: msgs,
  });

describe("TechnocoreClient", () => {
  it("parses readRoom JSON with nonce/sig fields intact", async () => {
    const client = mockClient({
      "/r/lobby?": {
        status: 200,
        body: ROOM_JSON([
          { seq: 1, ts: "2026-01-01T00:00:00Z", from: DID, text: "hi", nonce: 1788000000000, sig: "abc" },
        ]),
      },
    });
    const read = await client.readRoom("lobby", { limit: 50 });
    expect(read.messages[0].from).toBe(DID);
    expect(read.messages[0].nonce).toBe(1788000000000);
    expect(read.messages[0].sig).toBe("abc");
  });

  it("surfaces 429 as rate_limited with the retry text", async () => {
    const client = mockClient({
      "/r/lobby": { status: 429, body: "retry after: 12s — the bucket refills 0.5 tokens/s" },
    });
    await expect(client.readRoom("lobby")).rejects.toMatchObject({
      kind: "rate_limited",
      status: 429,
    });
  });

  it("throws TechnocoreError with status/kind for 403", async () => {
    const client = mockClient({
      "/r/lobby/say-signed": { status: 403, body: "403: signature does not verify against room|nonce|text" },
    });
    await expect(
      client.writeSigned({ room: "lobby", did: DID, sig: "x".repeat(86), nonce: "1", text: "t" }),
    ).rejects.toBeInstanceOf(TechnocoreError);
  });

  it("extracts posted seq from a write response", async () => {
    const client = mockClient({
      "/r/lobby/say-signed": {
        status: 200,
        body: JSON.stringify({ posted: { seq: 42, ts: "t", from: DID, text: "t", nonce: 1, sig: "s" } }),
      },
    });
    const res = await client.writeSigned({ room: "lobby", did: DID, sig: "y".repeat(86), nonce: "2", text: "t" });
    expect(res.posted?.seq).toBe(42);
  });

  it("readNote reports found=false on 404", async () => {
    const client = mockClient({
      "/kv/did-3f/9c0a1d7e2b4c56": { status: 404, body: "404 no note" },
    });
    const note = await client.readNote("did-3f", "9c0a1d7e2b4c56");
    expect(note.found).toBe(false);
  });
});

describe("checkDid state machine", () => {
  const noteOk = (msgs: unknown[]) => ({
    "/kv/": { status: 200, body: DID },
    "/r/lobby?": { status: 200, body: ROOM_JSON(msgs) },
    "/r/technocore?": { status: 200, body: ROOM_JSON([]) },
    "/r/flop-network?": { status: 200, body: ROOM_JSON([]) },
    "/r/tclk-offers?": { status: 200, body: ROOM_JSON([]) },
  });

  it("NOT_SET_UP when no note and no signed messages", async () => {
    const client = mockClient({
      "/kv/": { status: 404, body: "404 no note" },
      "/r/lobby?": { status: 200, body: ROOM_JSON([]) },
      "/r/technocore?": { status: 200, body: ROOM_JSON([]) },
      "/r/flop-network?": { status: 200, body: ROOM_JSON([]) },
      "/r/tclk-offers?": { status: 200, body: ROOM_JSON([]) },
    });
    const res = await checkDid(client, DID);
    expect(res.state).toBe("NOT_SET_UP");
    expect(res.checks.notePresent).toBe(false);
    expect(res.checks.keyEverSigned).toBe(false);
  });

  it("SET_UP_CORRECTLY when note present and signed activity exists", async () => {
    const client = mockClient(
      noteOk([{ seq: 1, ts: "t", from: DID, text: "hello", nonce: 1, sig: "s" }]),
    );
    const res = await checkDid(client, DID);
    expect(res.state).toBe("SET_UP_CORRECTLY");
    expect(res.signedMessageCount).toBe(1);
    expect(res.activity.find((a) => a.room === "lobby")?.signedMessages).toBe(1);
  });

  it("HALF_SET_UP with note but no activity", async () => {
    const client = mockClient(noteOk([]));
    const res = await checkDid(client, DID);
    expect(res.state).toBe("HALF_SET_UP");
    expect(res.checks.notePresent).toBe(true);
  });

  it("HALF_SET_UP with activity but no note", async () => {
    const client = mockClient({
      "/kv/": { status: 404, body: "404" },
      "/r/lobby?": { status: 200, body: ROOM_JSON([{ seq: 1, ts: "t", from: DID, text: "x" }]) },
      "/r/technocore?": { status: 200, body: ROOM_JSON([]) },
      "/r/flop-network?": { status: 200, body: ROOM_JSON([]) },
      "/r/tclk-offers?": { status: 200, body: ROOM_JSON([]) },
    });
    const res = await checkDid(client, DID);
    expect(res.state).toBe("HALF_SET_UP");
  });

  it("keeps scanning when one room errors (429)", async () => {
    const client = mockClient({
      "/kv/": { status: 404, body: "404" },
      "/r/lobby?": { status: 429, body: "retry after: 12s" },
      "/r/technocore?": { status: 200, body: ROOM_JSON([{ seq: 1, ts: "t", from: DID, text: "x" }]) },
      "/r/flop-network?": { status: 200, body: ROOM_JSON([]) },
      "/r/tclk-offers?": { status: 200, body: ROOM_JSON([]) },
    });
    const res = await checkDid(client, DID);
    expect(res.signedMessageCount).toBe(1);
  });

  it("counts local receipts as signed evidence when the public ring rolled past", async () => {
    const client = mockClient({
      "/kv/": { status: 404, body: "404" },
      "/r/lobby?": { status: 200, body: ROOM_JSON([]) },
      "/r/technocore?": { status: 200, body: ROOM_JSON([]) },
      "/r/flop-network?": { status: 200, body: ROOM_JSON([]) },
      "/r/tclk-offers?": { status: 200, body: ROOM_JSON([]) },
    });
    const res = await checkDid(client, DID, {
      local: [
        { room: "lobby", seq: 900, nonce: "12", text: "hello" },
        { room: "lobby", seq: 905, nonce: "13", text: "again" },
      ],
    });
    expect(res.checks.keyEverSigned).toBe(true);
    expect(res.localCount).toBe(2);
    expect(res.localActivity[0]).toEqual({ room: "lobby", count: 2, latestSeq: 905 });
    expect(res.state).toBe("HALF_SET_UP");
    expect(res.signedMessageCount).toBe(0);
  });
});

describe("parseDidNote", () => {
  it("extracts mailbox, x25519 and tclk tokens", () => {
    const parsed = parseDidNote(
      `${DID} x25519:AbCd mailbox:mb-p-a1b2c3 tclk1:flop-htlc`,
    );
    expect(parsed.mailbox).toBe("mb-p-a1b2c3");
    expect(parsed.x25519).toBe("AbCd");
    expect(parsed.tclk).toBe("flop-htlc");
  });
  it("handles a bare note with just the did", () => {
    expect(parseDidNote(DID).mailbox).toBeUndefined();
  });
});

describe("offline re-verification from a stored record", () => {
  it("re-verifies a signed message from room|nonce|text", () => {
    const seed = generateSeed();
    const msg = signMessage({ seed, room: "lobby", nonce: "1234567890", text: "stored line" });
    // Simulate reading back the stored record and verifying offline.
    const ok = verifyMessage({
      did: msg.did,
      room: "lobby",
      nonce: msg.nonce,
      text: msg.sweptText,
      sig: msg.sig,
    });
    expect(ok.valid).toBe(true);
    expect(ok.canonical).toBe("lobby|1234567890|stored line");
  });
});

describe("verifyRecord (deterministic seq-based verification)", () => {
  const seed = generateSeed();
  const msg = signMessage({ seed, room: "lobby", nonce: "42", text: "stored line" });
  const fromDid = msg.did;

  const clientFor = (messages: unknown[]) =>
    mockClient({
      "/r/lobby?since=32&limit=200&format=json": {
        status: 200,
        body: ROOM_JSON(messages),
      },
    });

  it("returns valid for a genuinely signed record", async () => {
    const client = clientFor([
      {
        seq: 42,
        ts: "t",
        from: fromDid,
        text: "stored line",
        nonce: 42,
        sig: msg.sig,
      },
    ]);
    const res = await verifyRecord(client, "lobby", 42, fromDid);
    expect(res.found).toBe(true);
    expect(res.valid).toBe(true);
  });

  it("fails verification when the text was tampered with", async () => {
    const client = clientFor([
      { seq: 42, ts: "t", from: fromDid, text: "tampered line", nonce: 42, sig: msg.sig },
    ]);
    const res = await verifyRecord(client, "lobby", 42, fromDid);
    expect(res.found).toBe(true);
    expect(res.valid).toBe(false);
  });

  it("flags unsigned records", async () => {
    const client = clientFor([{ seq: 42, ts: "t", from: "someone", text: "hi" }]);
    const res = await verifyRecord(client, "lobby", 42);
    expect(res.found).toBe(true);
    expect(res.signed).toBe(false);
  });

  it("reports not found when the seq is beyond retention", async () => {
    const client = clientFor([]);
    const res = await verifyRecord(client, "lobby", 42);
    expect(res.found).toBe(false);
  });

  it("distinguishes a record rolled past the readable window", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          room: "lobby",
          count: 0,
          first_seq: 1000,
          last_seq: 1000,
          generation: 0,
          messages: [],
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const client = new TechnocoreClient({ mode: "direct", baseUrl: "https://technocore.chat", fetchImpl });
    const res = await verifyRecord(client, "lobby", 42);
    expect(res.found).toBe(false);
    expect(res.error).toMatch(/ring has moved past it/);
  });
});