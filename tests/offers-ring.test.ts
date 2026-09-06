import { describe, it, expect } from "vitest";
import { OFFERS_ROOM, parseOffersExport } from "../lib/offers-ring";

const DID = "did:key:z6MktwupdmLXVVqTzCw4i46r4uGyosGXRnR3XjN4Zq7oMMsw";

describe("parseOffersExport", () => {
  it("parses JSONL lines into records tagged with the offers room", () => {
    const body = [
      JSON.stringify({ seq: 1, ts: "2026-01-01T00:00:00Z", from: DID, text: "tclk1 {}", sig: "sig1" }),
      JSON.stringify({ seq: 2, ts: "2026-01-01T00:00:01Z", from: DID, text: "plain message" }),
      "{ this is not json",
      "",
      "   ",
    ].join("\n");
    const records = parseOffersExport(body);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      room: OFFERS_ROOM,
      seq: 1,
      ts: "2026-01-01T00:00:00Z",
      from: DID,
      text: "tclk1 {}",
      sig: "sig1",
    });
    expect(records[1]).toMatchObject({ seq: 2, room: OFFERS_ROOM });
    expect(records[1].sig).toBeUndefined();
  });

  it("drops lines without a text field", () => {
    const body = JSON.stringify({ seq: 3, from: DID }) + "\n" + JSON.stringify({ seq: 4, text: "ok" });
    const records = parseOffersExport(body);
    expect(records).toHaveLength(1);
    expect(records[0].seq).toBe(4);
  });
});
