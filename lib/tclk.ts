/**
 * tclk/1 frame parsing for Trustcore.
 *
 * A frame is the 6 chars `tclk1 ` followed by one canonical JSON object. Frames
 * ride technocore's SIGNED lane only: an unsigned record is data, not a
 * commitment, so the parser requires `sig` present and `from` to be a valid
 * did:key. Decode is fail-closed (unknown typed fields are ignored, missing
 * required fields drop the frame) — the same discipline the spec sets.
 *
 * Per SPEC.md field tables:
 *   offer  : type, from, role, amount, asset, lock, rails, claimByMs,
 *            refundAfterMs, expiresMs, nonce, id        (+paymentKey, job)
 *   accept : type, from, ref, statement, contract, nonce (+paymentKey)
 *   lock   : type, from, contract, rail, ref            (+presig)
 *   reveal : type, from, contract, secret               (+ref)
 *   refund : type, from, contract                       (+ref, reason)
 *   cancel : type, from, contract                       (+reason)
 *   receipt: type, from, contract, outcome              (+rail, ref)
 *   heartbeat: type, from, contract, nonce              (+note)
 */

import { isValidDid } from "./didkey";

export const TCLK_PREFIX = "tclk1 ";

export type TclkType =
  | "offer"
  | "accept"
  | "lock"
  | "reveal"
  | "refund"
  | "cancel"
  | "receipt"
  | "heartbeat";

export const TCLK_TYPES = new Set<TclkType>([
  "offer",
  "accept",
  "lock",
  "reveal",
  "refund",
  "cancel",
  "receipt",
  "heartbeat",
]);

export interface TclkFrame {
  type: TclkType;
  did: string;
  room: string;
  seq: number;
  ts: string;
  contractId?: string;
  offerId?: string;
  ref?: string;
  amount?: string;
  asset?: string;
  role?: string;
  outcome?: string;
  rail?: string;
  lockKind?: string;
  claimByMs?: number;
  refundAfterMs?: number;
  expiresMs?: number;
  secret?: string;
  statement?: string;
  rawText: string;
  hash: string;
}

const HEX32 = /^0x[0-9a-f]{64}$/;
const DID_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;

export function isTclkLine(text: string): boolean {
  return text.startsWith(TCLK_PREFIX);
}

/** Parse the JSON payload of a frame (strict on required fields per type). */
function parsePayload(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(TCLK_PREFIX.length)) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.type !== "string" || !TCLK_TYPES.has(o.type as TclkType)) return null;
  if (typeof o.from !== "string" || !DID_RE.test(o.from)) return null;
  return o;
}

function ms(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function parseFrame(record: {
  from?: string;
  text?: string;
  nonce?: number;
  sig?: string;
  seq?: number;
  ts?: string;
  room?: string;
}): TclkFrame | null {
  const room = record.room ?? "";
  const text = record.text ?? "";
  const seq = record.seq ?? 0;
  const ts = record.ts ?? "";
  const from = record.from ?? "";
  // Signed lane only: server-verified did + presence of sig.
  if (!record.sig || !isValidDid(from)) return null;
  if (!isTclkLine(text)) return null;
  if (room.includes("tclk") === false && room !== "tclk-offers") return null;

  const o = parsePayload(text);
  if (!o) return null;

  const type = o.type as TclkType;
  const required: Record<string, string[]> = {
    offer: ["amount", "asset", "lock", "rails", "claimByMs", "refundAfterMs", "expiresMs", "nonce", "id", "role"],
    accept: ["ref", "statement", "contract", "nonce"],
    lock: ["contract", "rail", "ref"],
    reveal: ["contract", "secret"],
    refund: ["contract"],
    cancel: ["contract"],
    receipt: ["contract", "outcome"],
    heartbeat: ["contract", "nonce"],
  };
  for (const field of required[type] ?? []) {
    const v = o[field];
    if (v === undefined || v === null || v === "") return null;
    const ok =
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      Array.isArray(v);
    if (!ok) return null;
  }

  const hash = simpleHash(`${room}|${seq}|${text}`);

  const out: TclkFrame = {
    type,
    did: from,
    room,
    seq,
    ts,
    rawText: text,
    hash,
  };
  const contractId = str(o.contract);
  if (contractId && HEX32.test(contractId)) out.contractId = contractId;
  const offerId = str(o.id);
  if (offerId && HEX32.test(offerId)) out.offerId = offerId;
  const ref = str(o.ref);
  if (ref) out.ref = ref;
  const amount = str(o.amount);
  if (amount && /^[0-9]+$/.test(amount)) out.amount = amount;
  const asset = str(o.asset);
  if (asset) out.asset = asset;
  const role = str(o.role);
  if (role === "payer" || role === "payee") out.role = role;
  const outcome = str(o.outcome);
  if (outcome === "claimed" || outcome === "refunded" || outcome === "cancelled") out.outcome = outcome;
  const rail = str(o.rail);
  if (rail) out.rail = rail;
  const lockKind = str(o.lock);
  if (lockKind === "hash" || lockKind === "point") out.lockKind = lockKind;
  out.claimByMs = ms(o.claimByMs);
  out.refundAfterMs = ms(o.refundAfterMs);
  out.expiresMs = ms(o.expiresMs);
  const secret = str(o.secret);
  if (secret && HEX32.test(secret)) out.secret = secret;
  const statement = str(o.statement);
  if (statement && (HEX32.test(statement) || /^0x[0-9a-f]{66}$/.test(statement))) out.statement = statement;

  return out;
}

/** Deal room derived from a contract id: mb-p-tclk-<first 16 hex>. */
export function dealRoomForContract(contractId: string): string | null {
  if (!HEX32.test(contractId)) return null;
  return `mb-p-tclk-${contractId.slice(2, 18)}`;
}

export function contractFromDealRoom(room: string): string | null {
  const m = /^mb-p-tclk-([0-9a-f]{16})$/.exec(room);
  return m ? `0x${m[1]}` : null;
}

export function simpleHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 0x01000193) ^ s.charCodeAt(i)) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}