/**
 * Local receipts for signed writes. Stored only in the user's browser
 * (localStorage) and available for download as JSON. A receipt lets a human
 * independently re-verify their message later: rebuild room|nonce|text, check
 * the signature, and look up seq in the room export.
 *
 * Exposed as a reactive store (`useSyncExternalStore`) with stable snapshots
 * keyed by storage content, so reads are hydration-safe on both server and
 * client.
 */

export interface Receipt {
  id: string;
  did: string;
  room: string;
  seq: number;
  nonce: string;
  text: string;
  sig: string;
  ts: string;
  url: string;
  status: number;
  responseHash: string;
  createdAt: string;
}

const STORAGE_KEY = "floptools.receipts";
const EVENT = "floptools:receipts";

let parsed: { raw: string; list: Receipt[] } | null = null;

export const EMPTY_RECEIPTS: Receipt[] = [];

function readList(): Receipt[] {
  if (typeof window === "undefined") return EMPTY_RECEIPTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? "";
    if (!parsed || parsed.raw !== raw) {
      parsed = { raw, list: raw ? (JSON.parse(raw) as Receipt[]) : EMPTY_RECEIPTS };
    }
    return parsed.list;
  } catch {
    return EMPTY_RECEIPTS;
  }
}

export function loadReceipts(): Receipt[] {
  return readList();
}

export function getReceiptsSnapshot(): Receipt[] {
  return readList();
}

export function subscribeReceipts(cb: () => void): () => void {
  const onChange = () => cb();
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function notify(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function saveReceipt(receipt: Receipt): Receipt[] {
  const all = [receipt, ...readList()].slice(0, 200);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
  notify();
  return all;
}

export function clearReceipts(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
  notify();
}

export function receiptsToDownloadUrl(receipts: Receipt[]): string {
  const blob = new Blob([JSON.stringify(receipts, null, 2)], {
    type: "application/json",
  });
  return URL.createObjectURL(blob);
}

export function receiptCurlCommand(receipt: Receipt, base: string): string {
  const url = `${base}/r/${receipt.room}/say-signed/${receipt.did}/${receipt.sig}/${receipt.nonce}/${encodeURIComponent(receipt.text)}`;
  return `curl -s '${url}'`;
}

export function verifyReceipt(
  receipt: Receipt,
  verify: (text: string, sig: string, did: string) => boolean,
): boolean {
  const canonical = `${receipt.room}|${receipt.nonce}|${receipt.text}`;
  return verify(canonical, receipt.sig, receipt.did);
}