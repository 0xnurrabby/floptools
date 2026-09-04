import { describe, it, expect } from "vitest";
import {
  buildPrompt,
  parseTemplatesResponse,
  sanitizeTemplate,
  hasSlop,
  SLOT_META,
  TEMPLATE_SLOTS,
} from "../lib/personalize";

const GOOD_JSON = {
  persona_title: "Senior systems engineer",
  introduction: "New engineer here, building small public tools for agent networks. Signed in with one stable key.",
  working: "Working on a local Technocore client in Rust this week.",
  contribution: "Published a walkthrough of did:key signing, room by room.",
  status: "Status: node building clean, tests green, one key kept active.",
  network: "Same did:key through the pre-testnet months; no claims, just keeping it alive.",
};

describe("sanitizeTemplate", () => {
  it("replaces em and en dashes with a plain hyphen", () => {
    expect(sanitizeTemplate("hello — world – now")).toBe("hello - world - now");
    expect(sanitizeTemplate("a\u2015b\u2E3Bc")).toBe("a-b-c");
  });

  it("flattens newlines and trims", () => {
    expect(sanitizeTemplate("line one\nline two\r\nline three  ")).toBe("line one line two line three");
  });

  it("strips markdown marks, bullets, and numbering", () => {
    expect(sanitizeTemplate("**bold** `code` # heading")).toBe("bold code heading");
    expect(sanitizeTemplate("1) first")).toBe("first");
    expect(sanitizeTemplate("- item")).toBe("item");
  });

  it("keeps plain hyphens and punctuation intact", () => {
    expect(sanitizeTemplate("did:key:z6Mk... say-signed lane, nonce per room.")).toBe(
      "did:key:z6Mk... say-signed lane, nonce per room.",
    );
  });
});

describe("hasSlop", () => {
  it("flags banned AI-slop words case-insensitively", () => {
    expect(hasSlop("Use this to unleash your potential")).toBe(true);
    expect(hasSlop("Delve into the ecosystem")).toBe(true);
    expect(hasSlop("Working on a public tool")).toBe(false);
  });
});

describe("parseTemplatesResponse", () => {
  it("parses a clean JSON object", () => {
    const res = parseTemplatesResponse(JSON.stringify(GOOD_JSON), "developer");
    expect(res).not.toBeNull();
    expect(res!.personaTitle).toBe("Senior systems engineer");
    for (const slot of TEMPLATE_SLOTS) {
      expect(res!.templates[slot].length).toBeGreaterThan(10);
    }
  });

  it("tolerates code fences and prose around the object", () => {
    const withFence = "Sure!\n```json\n" + JSON.stringify(GOOD_JSON) + "\n```\nDone.";
    const res = parseTemplatesResponse(withFence, "creator");
    expect(res).not.toBeNull();
    expect(res!.templates.working).toBe(GOOD_JSON.working);
  });

  it("rejects payloads with missing slots", () => {
    const bad = JSON.stringify({ persona_title: "Engineer", introduction: "hi" });
    expect(parseTemplatesResponse(bad, "tester")).toBeNull();
  });

  it("rejects em dashes leaking through (sanitize converts them first, then keeps clean)", () => {
    const emDashJson = JSON.stringify({
      ...GOOD_JSON,
      status: "Great progress — things are moving — fast!",
    });
    const res = parseTemplatesResponse(emDashJson, "developer");
    expect(res).not.toBeNull();
    expect(res!.templates.status).not.toContain("\u2014");
    expect(res!.templates.status).toContain("-");
  });

  it("rejects AI slop in any template", () => {
    const slopJson = JSON.stringify({
      ...GOOD_JSON,
      working: "Leveraging the ecosystem to supercharge everything.",
    });
    expect(parseTemplatesResponse(slopJson, "developer")).toBeNull();
  });

  it("rejects non-JSON gibberish", () => {
    expect(parseTemplatesResponse("no json here at all", "surprise")).toBeNull();
  });
});

describe("prompt construction", () => {
  it("bans em dashes, slop, and reward talk", () => {
    const { system, user } = buildPrompt({ name: "Suraj", persona: "developer", variation: 3 });
    const prompt = system + " " + user;
    expect(prompt).toContain("em dashes");
    expect(prompt).toContain("airdrops");
    expect(prompt).toContain("Suraj");
    expect(prompt).toContain("variation #3");
  });

  it("maps every slot to a sensible room", () => {
    expect(SLOT_META.introduction.room).toBe("lobby");
    expect(SLOT_META.contribution.room).toBe("technocore");
    expect(SLOT_META.network.room).toBe("flop-network");
  });
});