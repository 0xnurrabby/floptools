import { describe, it, expect } from "vitest";
import { sweep } from "../lib/sweep";

describe("single-line sweep (mirrors server clean_text / scripts/sign.py)", () => {
  it("replaces newlines and tabs with a space and trims", () => {
    expect(sweep("hello\nworld")).toBe("hello world");
    expect(sweep("a\tb")).toBe("a b");
    expect(sweep("  padded  ")).toBe("padded");
  });

  it("replaces zero-width joiners, bidi overrides, BOM and other Cf format chars", () => {
    expect(sweep("a\u200Db")).toBe("a b"); // ZWJ
    expect(sweep("a\u200eb")).toBe("a b"); // LRE
    expect(sweep("a\u202eb")).toBe("a b"); // RLO
    expect(sweep("a\u2028b")).toBe("a b"); // U+2028 LINE SEPARATOR (Zl)
    expect(sweep("a\u2029b")).toBe("a b"); // U+2029 PARAGRAPH SEPARATOR (Zp)
    expect(sweep("a\uFEFFb")).toBe("a b"); // BOM
  });

  it("replaces private-use and lone surrogates", () => {
    expect(sweep("a\uE000b")).toBe("a b"); // private use Co
    expect(sweep("a\uD800b")).toBe("a b"); // lone surrogate Cs
  });

  it("keeps valid surrogate pairs (emoji) intact", () => {
    // A valid emoji is a surrogate pair -> one code point, not swept.
    expect(sweep("hi 😀 there")).toBe("hi 😀 there");
  });

  it("collapses multiple invisibles into multiple spaces", () => {
    expect(sweep("a\n\nb")).toBe("a  b");
  });

  it("does NOT normalize (NFC and NFD are different messages)", () => {
    expect(sweep("Vi\u1ec7t")).toBe("Vi\u1ec7t");
    expect(sweep("Vie\u0302\u0323t")).toBe("Vie\u0302\u0323t");
  });

  it("returns empty string when nothing visible survives", () => {
    expect(sweep("\n\t")).toBe("");
    expect(sweep("\u200b")).toBe("");
  });

  it("matches the official signer swept text for a known vector", () => {
    // sign.py --seed ... say lobby 1788000000000 "hello with newline\nand tab\tplus smile :)"
    // The \n and \t each become a single space (no space preceded them).
    expect(sweep("hello with newline\nand tab\tplus smile :)")).toBe(
      "hello with newline and tab plus smile :)",
    );
  });

  it("handles astral CJK and dense scripts unchanged", () => {
    expect(sweep("Vietnamese ếớựữậ")).toBe("Vietnamese ếớựữậ");
    expect(sweep("中文消息")).toBe("中文消息");
  });
});