const B58 =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    const rem = n % 58n;
    n = n / 58n;
    out = B58[Number(rem)] + out;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out === "" ? "0" : out;
}

export function base58Decode(s: string): Uint8Array<ArrayBuffer> {
  let n = 0n;
  for (const ch of s) {
    const idx = B58.indexOf(ch);
    if (idx === -1) {
      throw new Error(`invalid base58 character '${ch}'`);
    }
    n = n * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  for (const ch of s) {
    if (ch === "1") zeros++;
    else break;
  }
  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes, zeros);
  return out;
}

export function isBase58(s: string): boolean {
  for (const ch of s) {
    if (B58.indexOf(ch) === -1) return false;
  }
  return s.length > 0;
}