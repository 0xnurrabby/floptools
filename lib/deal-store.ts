/**
 * Local deal workspace state.
 *
 * Stores only what belongs to the user's own browser: frames they built and
 * posted (already public), and — for a payee — the preimage they minted and
 * never sent anywhere. Nothing here is ever uploaded; the server never signs
 * or stores anything.
 */

import type { AcceptFrame, LockFrame, OfferFrame, ReceiptFrame, RecordInput, RevealFrame } from "./tclk-deal";

const KEY = "floptools.deals.v1";
const EVENT = "floptools:deals";

export interface DealRecord {
  contract: string;
  role: "payer" | "payee";
  offer: OfferFrame;
  offerId: string;
  accept?: AcceptFrame;
  preimage?: string;
  statement: string;
  lock?: LockFrame;
  reveal?: RevealFrame;
  receipt?: ReceiptFrame;
  /** The signed public record of the offer as the venue stored it (seq/ts/from). */
  offerRecord?: RecordInput;
  /** The signed public record of the accept as the venue stored it (seq/ts/from). */
  acceptRecord?: RecordInput;
  createdAt: number;
}

export interface PostedFrame {
  kind: "offer" | "accept" | "paper" | "lock" | "work" | "reveal" | "claim-paper" | "receipt" | "refund" | "cancel";
  contract: string;
  at: number;
  detail: string;
}

let cache: DealRecord[] | null = null;

function readAll(): DealRecord[] {
  if (typeof window === "undefined") return [];
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as DealRecord[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function writeAll(deals: DealRecord[]): void {
  cache = deals;
  try {
    localStorage.setItem(KEY, JSON.stringify(deals));
  } catch {
    /* storage unavailable */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

export function getDealsSnapshot(): DealRecord[] {
  return readAll();
}

export function subscribeDeals(cb: () => void): () => void {
  const onChange = () => cb();
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function saveDeal(deal: DealRecord): DealRecord[] {
  const deals = readAll().filter((d) => d.contract !== deal.contract);
  deals.push(deal);
  writeAll(deals);
  return deals;
}

export function findDeal(contract: string): DealRecord | null {
  return readAll().find((d) => d.contract === contract) ?? null;
}

export function findDealByOfferId(offerId: string): DealRecord | null {
  return readAll().find((d) => d.offerId === offerId) ?? null;
}

export function patchDeal(contract: string, patch: Partial<DealRecord>): DealRecord[] {
  const deals = readAll();
  const idx = deals.findIndex((d) => d.contract === contract);
  if (idx >= 0) {
    deals[idx] = { ...deals[idx], ...patch };
    writeAll(deals);
  }
  return deals;
}

export function patchDealByOfferId(offerId: string, patch: Partial<DealRecord>): DealRecord[] {
  const deals = readAll();
  const idx = deals.findIndex((d) => d.offerId === offerId);
  if (idx >= 0) {
    deals[idx] = { ...deals[idx], ...patch };
    writeAll(deals);
  }
  return deals;
}

export function removeDeal(contract: string): DealRecord[] {
  const deals = readAll().filter((d) => d.contract !== contract);
  writeAll(deals);
  return deals;
}

export function lastPosted(): PostedFrame[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem("floptools.deal.posted.v1");
    return raw ? (JSON.parse(raw) as PostedFrame[]) : [];
  } catch {
    return [];
  }
}

export function rememberPosted(frame: PostedFrame): void {
  try {
    const list = lastPosted().filter((p) => !(p.kind === frame.kind && p.contract === frame.contract));
    list.push(frame);
    localStorage.setItem("floptools.deal.posted.v1", JSON.stringify(list.slice(-40)));
  } catch {
    /* noop */
  }
}
