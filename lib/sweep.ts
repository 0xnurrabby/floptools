/**
 * The single-line sweep the Technocore server applies before storage.
 * Mirrors `src/store.py clean_text` and `scripts/sign.py`: every character
 * whose Unicode general category is Cc, Cf, Cs, Co, Zl or Zp becomes a space,
 * then leading/trailing whitespace is trimmed.
 *
 * A message is signed AFTER this sweep — the bytes that get stored — so a
 * record stays re-verifiable later. Signing raw text yields a 403.
 */

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Zl}\p{Zp}]/u;

export const SWEEP_CATEGORIES = ["Cc", "Cf", "Cs", "Co", "Zl", "Zp"] as const;

export function sweep(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let invisible = false;
    if (cp >= 0xd800 && cp <= 0xdfff) {
      // A lone surrogate (a valid pair yields a code point > 0xFFFF here).
      invisible = true;
    } else {
      invisible = INVISIBLE.test(ch);
    }
    out += invisible ? " " : ch;
  }
  return out.trim();
}

export const MAX_MESSAGE_CHARS = 4096;
export const MAX_NOTE_CHARS = 8192;

export function assertMessageLength(text: string): void {
  const len = [...text].length;
  if (len > MAX_MESSAGE_CHARS) {
    throw new Error(
      `${len} characters after the sweep, over the ${MAX_MESSAGE_CHARS}-character message cap — split it`,
    );
  }
}