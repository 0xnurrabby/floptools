/**
 * tclk/1 (Technocore Lock Protocol) — spec-conformant client-side primitives.
 *
 * Mirrors @flop-labs/tclk (SPEC.md §3–§5) so frames this tool emits are
 * byte-compatible with the reference implementation: canonical JSON (sorted
 * keys, compact, undefined dropped), ASCII-escaped non-ASCII before hashing,
 * domain-tagged sha256 ids, the paper rail's `tclkpaper1` note record, and
 * the fail-closed state machine. Source of truth:
 *   https://github.com/flop-labs/tclk (SPEC.md, README.md, examples/htlc-walkthrough.md)
 *
 * Everything here runs in the browser or Node. No private key ever leaves the
 * caller — frames are built here and signed with the transport's did:key.
 */

import { isValidDid } from "./didkey";
import { sha256Hex } from "./receipts";

export const TCLK_PREFIX = "tclk1 ";
export const TCLK_DOMAIN = "FLOP::tclk::v1";
export const PAPER_RECORD_PREFIX = "tclkpaper1";
export const OFFERS_ROOM = "tclk-offers";
export const MAX_FRAME_CHARS = 4096;

export type LockKind = "hash" | "point";
export type DealRole = "payer" | "payee";
export type DealState =
  | "proposed"
  | "accepted"
  | "locked"
  | "claimed"
  | "refunded"
  | "cancelled";

const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX33 = /^0x[0-9a-f]{66}$/;
const CONTRACT_ID = /^0x[0-9a-f]{64}$/;
const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const AMOUNT = /^[1-9][0-9]*$/;
const ASSET = /^[A-Za-z0-9_-]{1,32}$/;
const NONCE = /^[0-9a-f]{8,64}$/;
const RAIL = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface JobRef {
  proto: string;
  id: string;
  context?: string;
}

export interface OfferFrame {
  type: "offer";
  from: string;
  role: DealRole;
  amount: string;
  asset: string;
  lock: LockKind;
  rails: string[];
  claimByMs: number;
  refundAfterMs: number;
  expiresMs: number;
  nonce: string;
  id: string;
  paymentKey?: string;
  job?: JobRef;
}

export interface AcceptCore {
  from: string;
  ref: string;
  statement: string;
  paymentKey?: string;
  nonce: string;
}

export interface AcceptFrame extends AcceptCore {
  type: "accept";
  contract: string;
}

export interface LockFrame {
  type: "lock";
  from: string;
  contract: string;
  rail: string;
  ref: string;
}

export interface RevealFrame {
  type: "reveal";
  from: string;
  contract: string;
  ref?: string;
  secret: string;
}

export interface RefundFrame {
  type: "refund";
  from: string;
  contract: string;
  ref?: string;
  reason?: string;
}

export interface CancelFrame {
  type: "cancel";
  from: string;
  contract: string;
  reason?: string;
}

export interface ReceiptFrame {
  type: "receipt";
  from: string;
  contract: string;
  outcome: "claimed" | "refunded" | "cancelled";
  rail?: string;
  ref?: string;
}

export interface HeartbeatFrame {
  type: "heartbeat";
  from: string;
  contract: string;
  nonce: string;
  note?: string;
}

export type TclkFrame =
  | OfferFrame
  | AcceptFrame
  | LockFrame
  | RevealFrame
  | RefundFrame
  | CancelFrame
  | ReceiptFrame
  | HeartbeatFrame;

export function isTclkLine(text: string): boolean {
  return text.startsWith(TCLK_PREFIX);
}

/* ---------- bytes / hashing ---------- */

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function randomHex(bytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/* ---------- canonical encoding (SPEC.md §3) ---------- */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("tclk: unsupported value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function toAscii(json: string): string {
  return json.replace(
    /[\u0080-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

async function domainHash(tag: string, payload: string): Promise<string> {
  const digest = await sha256Hex(`${TCLK_DOMAIN}|${tag}|${toAscii(payload)}`);
  return `0x${digest}`;
}

export async function offerId(fields: Omit<OfferFrame, "id" | "type"> & { type: "offer" }): Promise<string> {
  return domainHash("offer", canonicalJson(fields));
}

export async function contractId(offer: OfferFrame, accept: AcceptCore): Promise<string> {
  return domainHash("contract", canonicalJson({ offer, accept }));
}

/* ---------- validation (fail-closed, SPEC.md §3) ---------- */

export function isValidStatement(lock: LockKind, statement: string): boolean {
  if (lock === "hash") return HEX32.test(statement);
  if (lock === "point") return HEX33.test(statement);
  return false;
}

function fail(msg: string): never {
  throw new Error(`tclk: ${msg}`);
}

function requireString(v: unknown, name: string, re?: RegExp): string {
  if (typeof v !== "string" || v.length === 0) fail(`${name} must be a non-empty string`);
  if (re && !re.test(v)) fail(`${name} is malformed`);
  return v;
}

function requireMs(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
    fail(`${name} must be a positive unix-ms integer`);
  }
  return v;
}

export function validateFrame(value: unknown): TclkFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("frame must be an object");
  const f = value as Record<string, unknown>;
  const type = f.type as TclkFrame["type"];

  const allowed: Record<string, string[]> = {
    offer: ["type", "from", "role", "amount", "asset", "lock", "rails", "claimByMs", "refundAfterMs", "expiresMs", "nonce", "id", "paymentKey", "job"],
    accept: ["type", "from", "ref", "statement", "contract", "paymentKey", "nonce"],
    lock: ["type", "from", "contract", "rail", "ref"],
    reveal: ["type", "from", "contract", "ref", "secret"],
    refund: ["type", "from", "contract", "ref", "reason"],
    cancel: ["type", "from", "contract", "reason"],
    receipt: ["type", "from", "contract", "outcome", "rail", "ref"],
    heartbeat: ["type", "from", "contract", "nonce", "note"],
  };
  const required: Record<string, string[]> = {
    offer: ["from", "role", "amount", "asset", "lock", "rails", "claimByMs", "refundAfterMs", "expiresMs", "nonce", "id"],
    accept: ["from", "ref", "statement", "contract", "nonce"],
    lock: ["from", "contract", "rail", "ref"],
    reveal: ["from", "contract", "secret"],
    refund: ["from", "contract"],
    cancel: ["from", "contract"],
    receipt: ["from", "contract", "outcome"],
    heartbeat: ["from", "contract", "nonce"],
  };
  const table = allowed[type];
  if (!table) fail(`unknown frame type: ${String(f.type)}`);
  for (const key of Object.keys(f)) {
    if (!table.includes(key)) fail(`unknown field on ${type}: ${key}`);
  }
  for (const key of required[type]) {
    if (f[key] === undefined) fail(`missing field on ${type}: ${key}`);
  }
  requireString(f.from, "from", DID_RE);

  switch (type) {
    case "offer": {
      if (f.role !== "payer" && f.role !== "payee") fail("role must be payer|payee");
      requireString(f.amount, "amount", AMOUNT);
      requireString(f.asset, "asset", ASSET);
      if (f.lock !== "hash" && f.lock !== "point") fail("lock must be hash|point");
      if (!Array.isArray(f.rails) || f.rails.length === 0) fail("rails must be a non-empty array");
      for (const rail of f.rails) requireString(rail, "rail", RAIL);
      const claimBy = requireMs(f.claimByMs, "claimByMs");
      const refundAfter = requireMs(f.refundAfterMs, "refundAfterMs");
      requireMs(f.expiresMs, "expiresMs");
      if (claimBy >= refundAfter) fail("claimByMs must be strictly before refundAfterMs");
      requireString(f.nonce, "nonce", NONCE);
      return f as unknown as TclkFrame;
    }
    case "accept": {
      requireString(f.ref, "ref", HEX32);
      requireString(f.statement, "statement", /^0x(?:[0-9a-f]{64}|[0-9a-f]{66})$/);
      requireString(f.contract, "contract", HEX32);
      requireString(f.nonce, "nonce", NONCE);
      break;
    }
    case "lock": {
      requireString(f.contract, "contract", HEX32);
      requireString(f.rail, "rail", RAIL);
      requireString(f.ref, "ref");
      break;
    }
    case "reveal": {
      requireString(f.contract, "contract", HEX32);
      if (f.ref !== undefined) requireString(f.ref, "ref");
      requireString(f.secret, "secret", HEX32);
      break;
    }
    case "refund": {
      requireString(f.contract, "contract", HEX32);
      if (f.ref !== undefined) requireString(f.ref, "ref");
      if (f.reason !== undefined) requireString(f.reason, "reason");
      break;
    }
    case "cancel": {
      requireString(f.contract, "contract", HEX32);
      if (f.reason !== undefined) requireString(f.reason, "reason");
      break;
    }
    case "receipt": {
      requireString(f.contract, "contract", HEX32);
      if (!["claimed", "refunded", "cancelled"].includes(String(f.outcome))) {
        fail("outcome must be claimed|refunded|cancelled");
      }
      if (f.rail !== undefined) requireString(f.rail, "rail", RAIL);
      if (f.ref !== undefined) requireString(f.ref, "ref");
      break;
    }
    case "heartbeat": {
      requireString(f.contract, "contract", HEX32);
      requireString(f.nonce, "nonce", NONCE);
      if (f.note !== undefined) requireString(f.note, "note");
      break;
    }
  }
  return f as unknown as TclkFrame;
}

/* ---------- builders ---------- */

export interface OfferInput {
  from: string;
  role: DealRole;
  amount: string;
  asset: string;
  claimByMs: number;
  refundAfterMs: number;
  expiresMs: number;
  job?: JobRef;
}

export async function makeOffer(input: OfferInput): Promise<OfferFrame> {
  if (!isValidDid(input.from)) fail("from must be a valid did:key");
  const body = {
    type: "offer" as const,
    from: input.from,
    role: input.role,
    amount: input.amount,
    asset: input.asset,
    lock: "hash" as LockKind,
    rails: ["paper"],
    claimByMs: input.claimByMs,
    refundAfterMs: input.refundAfterMs,
    expiresMs: input.expiresMs,
    nonce: randomHex(8),
    ...(input.job ? { job: input.job } : {}),
  };
  const id = await offerId(body);
  return validateFrame({ ...body, id }) as OfferFrame;
}

export interface HashLock {
  preimage: string;
  hash: string;
}

export async function generateHashLock(): Promise<HashLock> {
  return hashLockFromPreimage(`0x${randomHex(32)}`);
}

export async function hashLockFromPreimage(preimage: string): Promise<HashLock> {
  const bytes = hexToBytes(preimage);
  if (bytes.length !== 32) fail("preimage must be 32 bytes");
  const digest = await sha256Bytes(bytes);
  return { preimage, hash: `0x${digest}` };
}

export async function verifySecret(lock: LockKind, statement: string, secret: string): Promise<boolean> {
  if (lock !== "hash") return false;
  const h = await hashLockFromPreimage(secret).catch(() => null);
  return h !== null && h.hash.toLowerCase() === statement.toLowerCase();
}

export async function makeAccept(
  offer: OfferFrame,
  accept: { from: string; statement: string; nonce?: string },
): Promise<AcceptFrame> {
  validateFrame(offer);
  if (accept.from === offer.from) fail("accept.from must differ from offer.from");
  if (!isValidStatement(offer.lock, accept.statement)) {
    fail(`statement does not fit a ${offer.lock} lock`);
  }
  const core: AcceptCore = {
    from: accept.from,
    ref: offer.id,
    statement: accept.statement,
    nonce: accept.nonce ?? randomHex(8),
  };
  const contract = await contractId(offer, core);
  return validateFrame({ type: "accept", ...core, contract }) as AcceptFrame;
}

export function makeLock(input: { from: string; contract: string; rail: string; ref: string }): LockFrame {
  return validateFrame({ type: "lock", ...input }) as LockFrame;
}

export function makeReveal(input: { from: string; contract: string; ref?: string; secret: string }): RevealFrame {
  return validateFrame({ type: "reveal", ...input }) as RevealFrame;
}

export function makeRefund(input: { from: string; contract: string; ref?: string; reason?: string }): RefundFrame {
  return validateFrame({ type: "refund", ...input }) as RefundFrame;
}

export function makeCancel(input: { from: string; contract: string; reason?: string }): CancelFrame {
  return validateFrame({ type: "cancel", ...input }) as CancelFrame;
}

export function makeReceipt(input: {
  from: string;
  contract: string;
  outcome: "claimed" | "refunded" | "cancelled";
  rail?: string;
  ref?: string;
}): ReceiptFrame {
  return validateFrame({ type: "receipt", ...input }) as ReceiptFrame;
}

/** The room-message line for a frame: `tclk1 ` + canonical ASCII JSON. */
export function encodeFrame(frame: TclkFrame): string {
  const validated = validateFrame(frame);
  const line = TCLK_PREFIX + toAscii(canonicalJson(validated));
  if (line.length > MAX_FRAME_CHARS) {
    fail(`frame exceeds the ${MAX_FRAME_CHARS}-char room-message cap (${line.length})`);
  }
  if (!/^[\x20-\x7e]*$/.test(line)) {
    fail("frame line contains non-printable-ASCII characters");
  }
  return line;
}

/** Decode a room-message line. Null on anything malformed (fail-closed). */
export function decodeFrame(text: string): TclkFrame | null {
  if (!isTclkLine(text) || text.length > MAX_FRAME_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(TCLK_PREFIX.length));
  } catch {
    return null;
  }
  try {
    return validateFrame(parsed);
  } catch {
    return null;
  }
}

/** Deal room derived from a contract id: mb-p-tclk-<first 16 hex>. */
export function dealRoom(contract: string): string | null {
  if (!CONTRACT_ID.test(contract)) return null;
  return `mb-p-tclk-${contract.slice(2, 18)}`;
}

export function shortContract(contract: string): string {
  return contract ? `${contract.slice(0, 10)}…${contract.slice(-6)}` : "";
}

/* ---------- paper rail (SPEC.md §5, PaperRail) ---------- */

export type PaperStatus = "locked" | "claimed" | "refunded";

export interface PaperRecord {
  status: PaperStatus;
  lock: LockKind;
  statement: string;
  refundAfterMs: number;
  secret?: string;
}

export function encodePaperRecord(record: PaperRecord): string {
  const head = `${PAPER_RECORD_PREFIX} ${record.status} ${record.lock} ${record.statement} ${record.refundAfterMs}`;
  return record.secret === undefined ? head : `${head} ${record.secret}`;
}

export function decodePaperRecord(value: string): PaperRecord | null {
  const parts = value.split(" ");
  if (parts.length < 5 || parts.length > 6) return null;
  const [prefix, status, lock, statement, refundAfter, secret] = parts;
  if (prefix !== PAPER_RECORD_PREFIX) return null;
  if (status !== "locked" && status !== "claimed" && status !== "refunded") return null;
  if (lock !== "hash" && lock !== "point") return null;
  if (!isValidStatement(lock, statement)) return null;
  const refundAfterMs = Number(refundAfter);
  if (!Number.isSafeInteger(refundAfterMs) || refundAfterMs <= 0) return null;
  if (secret !== undefined && !HEX32.test(secret)) return null;
  if ((status === "claimed") !== (secret !== undefined)) return null;
  return {
    status,
    lock,
    statement,
    refundAfterMs,
    ...(secret === undefined ? {} : { secret }),
  };
}

/** The note surface for a contract's paper record: kv/tclk-paper-<hh>/<14 hex>. */
export function paperNote(contract: string): { ns: string; key: string } {
  if (!CONTRACT_ID.test(contract)) throw new Error(`tclk: malformed contract id: ${contract}`);
  return { ns: `tclk-paper-${contract.slice(2, 4)}`, key: contract.slice(4, 18) };
}

/* ---------- state machine (SPEC.md §4, fail-closed) ---------- */

export interface RecordInput {
  room: string;
  from: string;
  text: string;
  seq: number;
  ts: string;
  sig?: string;
}

export interface StepStatus {
  step: "offer" | "accept" | "paper" | "lock" | "work" | "reveal" | "receipt";
  label: string;
  done: boolean;
  blocked: boolean;
  reason?: string;
  at?: string;
}

export interface FoldResult {
  offer: OfferFrame | null;
  offerRecord: RecordInput | null;
  accept: AcceptFrame | null;
  acceptRecord: RecordInput | null;
  lock: LockFrame | null;
  reveal: RevealFrame | null;
  refund: RefundFrame | null;
  cancel: CancelFrame | null;
  receipt: ReceiptFrame | null;
  workMessages: RecordInput[];
  state: DealState;
  stateReason: string | null;
  steps: StepStatus[];
}

export async function foldContract(
  records: RecordInput[],
  paper: PaperRecord | null,
  opts: { now?: number } = {},
): Promise<FoldResult> {
  const now = opts.now ?? Date.now();

  const offers = records
    .filter((r) => r.room === OFFERS_ROOM)
    .map((r) => ({ record: r, frame: decodeFrame(r.text) }))
    .filter((x): x is { record: RecordInput; frame: OfferFrame } => x.frame?.type === "offer");
  const offerEntry = offers[0] ?? null;
  const offer = offerEntry?.frame ?? null;
  const offerRecord = offerEntry?.record ?? null;

  const accepts = records
    .filter((r) => r.room === OFFERS_ROOM)
    .map((r) => ({ record: r, frame: decodeFrame(r.text) }))
    .filter((x): x is { record: RecordInput; frame: AcceptFrame } => x.frame?.type === "accept")
    .filter((x) => offer !== null && x.frame.ref === offer.id);
  const acceptEntry = accepts[0] ?? null;
  const accept = acceptEntry?.frame ?? null;
  const acceptRecord = acceptEntry?.record ?? null;

  const dealRecords = records
    .filter((r) => r.room !== OFFERS_ROOM)
    .sort((a, b) => (a.ts === b.ts ? a.seq - b.seq : a.ts < b.ts ? -1 : 1));

  let state: DealState = offer ? "proposed" : "proposed";
  let stateReason: string | null = null;
  let lock: LockFrame | null = null;
  let reveal: RevealFrame | null = null;
  let refund: RefundFrame | null = null;
  let cancel: CancelFrame | null = null;
  let receipt: ReceiptFrame | null = null;
  const workMessages: RecordInput[] = [];

  if (offer) {
    // accept guard
    if (accept) {
      const acceptTs = acceptRecord ? new Date(acceptRecord.ts).getTime() : now;
      const validAccept =
        accept.from !== offer.from &&
        isValidStatement(offer.lock, accept.statement) &&
        (Number.isNaN(acceptTs) ? true : acceptTs < offer.expiresMs);
      if (validAccept) {
        state = "accepted";
      } else {
        stateReason = "acceptance failed its guard";
      }
    }
    for (const r of dealRecords) {
      const frame = decodeFrame(r.text);
      if (!frame) continue;
      if (frame.type === "heartbeat") continue;
      if (frame.type === "lock") {
        if (state === "accepted" && frame.from === offer.from && offer.rails.includes(frame.rail)) {
          const ts = new Date(r.ts).getTime();
          const beforeRefund = Number.isNaN(ts) ? true : ts < offer.refundAfterMs;
          if (beforeRefund) {
            lock = frame;
            state = "locked";
          } else {
            stateReason = "lock came after refundAfterMs";
          }
        } else {
          stateReason = "lock failed its guard";
        }
      } else if (frame.type === "reveal") {
        if (state === "locked" && accept && frame.from === accept.from) {
          const ts = new Date(r.ts).getTime();
          const beforeRefund = Number.isNaN(ts) ? true : ts < offer.refundAfterMs;
          const refOk = frame.ref === undefined || (lock !== null && frame.ref === lock.ref);
          const secretOk = await verifySecret(offer.lock, accept.statement, frame.secret);
          if (beforeRefund && refOk && secretOk) {
            reveal = frame;
            state = "claimed";
          } else {
            stateReason = secretOk ? "reveal failed its guard" : "reveal secret does not open the statement";
          }
        }
      } else if (frame.type === "refund") {
        if (state === "locked" && frame.from === offer.from) {
          const ts = new Date(r.ts).getTime();
          const atRefund = Number.isNaN(ts) ? true : ts >= offer.refundAfterMs;
          if (atRefund) {
            refund = frame;
            state = "refunded";
          }
        }
      } else if (frame.type === "cancel") {
        if ((state === "proposed" || state === "accepted") && (frame.from === offer.from || frame.from === accept?.from)) {
          cancel = frame;
          state = "cancelled";
        }
      } else if (frame.type === "receipt") {
        const expected =
          state === "claimed" ? "claimed" : state === "refunded" ? "refunded" : state === "cancelled" ? "cancelled" : null;
        if (expected !== null && frame.outcome === expected) receipt = frame;
      } else if (frame.type === "offer" || frame.type === "accept") {
        // wrong room — never advances state (SPEC §2 fold rule)
        stateReason = stateReason ?? "offer/accept record found in the wrong room";
      }
    }
    // work messages: signed messages in the deal room that are not frames
    for (const r of dealRecords) {
      if (!isTclkLine(r.text)) workMessages.push(r);
    }
  }

  const steps: StepStatus[] = [];
  steps.push(
    stepRow("offer", "Offer posted", !!offer, offerRecord ? tsLabel(offerRecord.ts) : undefined, offer ? undefined : "No offer found in tclk-offers."),
  );
  steps.push(
    stepRow("accept", "Accepted", !!accept, acceptRecord ? tsLabel(acceptRecord.ts) : undefined, !offer ? "Waiting for an offer." : !accept ? "Waiting for the other side to accept." : undefined),
  );
  steps.push(
    stepRow("paper", "Paper record on the rail", paper !== null, paper ? undefined : "The rail record must exist at kv/tclk-paper-<hh>/<key> before the lock.", !paper ? "Not written yet." : undefined),
  );
  const lockOk = !!lock;
  steps.push(
    stepRow("lock", "Lock posted", lockOk, lock ? tsLabel(dealRecords.find((r) => decodeFrame(r.text)?.type === "lock")?.ts ?? "") : undefined, !lock ? "Lock not on the board yet." : undefined),
  );
  const workDone = workMessages.length > 0;
  steps.push(
    stepRow("work", "Work submitted", workDone, workDone ? tsLabel(workMessages[workMessages.length - 1].ts) : undefined, !workDone ? "No deliverable message in the deal room yet." : undefined),
  );
  steps.push(
    stepRow("reveal", "Reveal", state === "claimed", reveal ? tsLabel(dealRecords.find((r) => decodeFrame(r.text)?.type === "reveal")?.ts ?? "") : undefined, state !== "claimed" ? stateReason ?? "Not revealed yet." : undefined),
  );
  steps.push(
    stepRow("receipt", "Receipt published", !!receipt, receipt ? tsLabel(dealRecords.find((r) => decodeFrame(r.text)?.type === "receipt")?.ts ?? "") : undefined, !receipt ? "No receipt frame yet." : undefined),
  );

  return {
    offer,
    offerRecord,
    accept,
    acceptRecord,
    lock,
    reveal,
    refund,
    cancel,
    receipt,
    workMessages,
    state,
    stateReason,
    steps,
  };
}

function stepRow(step: StepStatus["step"], label: string, done: boolean, at?: string, reason?: string): StepStatus {
  return {
    step,
    label,
    done,
    blocked: !done && !!reason,
    reason,
    at,
  };
}

function tsLabel(ts: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

/** A human, plain-language reason why the next action is blocked. */
export function nextGuard(
  fold: FoldResult,
  paper: PaperRecord | null,
  opts: { myDid?: string } = {},
): { action: string; blocked: boolean; reason: string } {
  const myDid = opts.myDid ?? "";
  const offer = fold.offer;
  const accept = fold.accept;

  if (!offer) return { action: "post offer", blocked: false, reason: "Create an offer first." };
  if (!accept) return { action: "wait for acceptance", blocked: true, reason: "Your offer is public in tclk-offers. Another identity accepts it with its own statement." };
  if (fold.state === "cancelled") return { action: "deal cancelled", blocked: true, reason: "A cancel frame ended this deal before any lock." };
  if (fold.state === "claimed") return { action: "deal complete", blocked: true, reason: "Reveal published — the contract is claimed." };
  if (fold.state === "refunded") return { action: "deal refunded", blocked: true, reason: "The refund window opened and the payer reclaimed." };

  const isPayer = myDid === offer.from;
  const isPayee = accept !== null && myDid === accept.from;

  if (fold.state === "proposed") {
    return { action: "wait for accept", blocked: true, reason: "Waiting for an accept frame in tclk-offers." };
  }
  if (fold.state === "accepted") {
    if (!isPayer && !isPayee) {
      return { action: "observe", blocked: true, reason: "This deal belongs to two other identities." };
    }
    if (paper === null) {
      if (isPayer) {
        return { action: "write paper record", blocked: false, reason: "Write the paper rail record first — the lock must name the full contract id." };
      }
      return { action: "wait for lock", blocked: true, reason: "The payer writes the paper record and posts the lock. Wait for it." };
    }
    const paperOk =
      paper.lock === offer.lock &&
      paper.statement === accept.statement &&
      paper.refundAfterMs === offer.refundAfterMs;
    if (!paperOk) {
      return {
        action: "fix paper record",
        blocked: true,
        reason: "The paper record exists but does not match the signed statement and refund deadline — only a matching record can back the lock.",
      };
    }
    return { action: "post lock", blocked: false, reason: "The paper record matches and exists. Now post the lock frame to the deal room." };
  }
  if (fold.state === "locked") {
    if (isPayee) {
      return { action: "reveal", blocked: false, reason: "Submit the work, then reveal the secret — that claims the deal." };
    }
    return { action: "wait for reveal", blocked: true, reason: "The payee submits work and reveals. Watch the deal room." };
  }
  return { action: "unknown", blocked: true, reason: "Unknown state." };
}
