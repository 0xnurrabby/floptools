/**
 * Trustcore scoring model — pure, deterministic, documented.
 *
 * Input: the set of trusted tclk frames StoredFrames collected from
 * tclk-offers + deal rooms. Deal state is reconstructed per contract id
 * (accept carries contract; offer carries its own id which accept.ref names).
 *
 * Score components (all transparent; shown on the /trustcore explainer):
 *   base 500 (neutral — everyone starts neutral, nothing is "proven")
 *   +80  per successful claim (reveal from the payee)        [cap +320]
 *   -70  per refund, -20 per cancel                          [cap -280]
 *   +40  speed bonus (locked→revealed quickly vs the window) [cap +40]
 *   +50  volume bonus (log scale of claimed amount)          [cap +50]
 *   -150 sybil/self-dealing flag, and score capped ≤ 300     (flagged once)
 * Clamp to 0..1000. Receipt frames never move a score — they only corroborate
 * the transcript (a contradicting receipt adds a minor inconsistency flag).
 */

import type { TclkFrame } from "./tclk";

export const NEUTRAL_SCORE = 500;

export interface DealState {
  contractId: string;
  offerId?: string;
  payer?: string;
  payee?: string;
  amount?: string;
  asset?: string;
  claimByMs?: number;
  refundAfterMs?: number;
  state: "proposed" | "accepted" | "locked" | "claimed" | "refunded" | "cancelled";
  lockedAtMs?: number;
  revealedAtMs?: number;
  refundedAtMs?: number;
  frames: TclkFrame[];
}

export interface AgentMetrics {
  did: string;
  deals: number;
  completed: number;
  refunded: number;
  cancelled: number;
  open: number;
  successRate: number | null;
  avgDeliveryMs: number | null;
  volumeClaimed: number;
  assets: string[];
  selfDealing: boolean;
  highOfferRate: boolean;
  receiptInconsistency: boolean;
  score: number;
  tier: TrustTier;
  summary: string;
}

export type TrustTier = "unknown" | "watch" | "new" | "peer" | "trusted" | "veteran";

export function tierFor(score: number, deals: number): TrustTier {
  if (deals === 0) return "unknown";
  if (score >= 800) return "veteran";
  if (score >= 650) return "trusted";
  if (score >= 501) return "peer";
  if (score >= 300) return "new";
  return "watch";
}

export const TIER_LABEL: Record<TrustTier, string> = {
  unknown: "No deals yet",
  watch: "Watch",
  new: "New",
  peer: "Peer",
  trusted: "Trusted",
  veteran: "Veteran",
};

function tsMs(ts: string): number {
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : NaN;
}

/** Reconstruct per-contract deal states from a frame list (deterministic). */
export function buildDealStates(frames: TclkFrame[]): { states: DealState[]; offerById: Map<string, TclkFrame> } {
  const offerById = new Map<string, TclkFrame>();
  const byContract = new Map<string, DealState>();

  // deterministic order: sort by (ts, room, seq)
  const sorted = [...frames].sort((a, b) => {
    const ta = tsMs(a.ts);
    const tb = tsMs(b.ts);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return a.seq - b.seq || a.room.localeCompare(b.room);
  });

  for (const f of sorted) {
    if (f.type === "offer") {
      if (f.offerId) offerById.set(f.offerId, f);
      continue;
    }
    // Every post-offer frame names a contract (accept..heartbeat all require it).
    if (!f.contractId) continue;
    let state = byContract.get(f.contractId);
    if (!state) {
      state = {
        contractId: f.contractId,
        offerId: f.ref,
        state: "accepted",
        frames: [],
      };
      byContract.set(f.contractId, state);
      // Derive parties ONCE, from the offer (role says the sender's side).
      const offer = f.ref ? offerById.get(f.ref) : undefined;
      if (offer) {
        if (offer.role === "payer") {
          state.payer = offer.did;
          state.payee = f.did;
        } else if (offer.role === "payee") {
          state.payee = offer.did;
          state.payer = f.did;
        }
        state.amount = offer.amount;
        state.asset = offer.asset;
        state.claimByMs = offer.claimByMs;
        state.refundAfterMs = offer.refundAfterMs;
      }
    }
    state.frames.push(f);

    // Heuristic fill when the offer is unavailable (ring rolled it out):
    // lock frames come from the payer, reveals from the payee. Fill only if
    // the side is unknown — never overwrite.
    if (!state.payer && f.type === "lock") state.payer = f.did;
    if (!state.payee && f.type === "reveal") state.payee = f.did;

    // transitions (frame replay tolerated: only advance forward)
    switch (f.type) {
      case "accept":
        if (state.state === "proposed") state.state = "accepted";
        break;
      case "lock":
        if (state.state === "accepted" || state.state === "proposed") {
          state.state = "locked";
          state.lockedAtMs = tsMs(f.ts);
        }
        break;
      case "reveal":
        if ((state.state === "locked" || state.state === "accepted") && f.secret) {
          state.state = "claimed";
          state.revealedAtMs = tsMs(f.ts);
        }
        break;
      case "refund":
        if (state.state === "locked" || state.state === "accepted") {
          state.state = "refunded";
          state.refundedAtMs = tsMs(f.ts);
        }
        break;
      case "cancel":
        if (state.state === "proposed" || state.state === "accepted") state.state = "cancelled";
        break;
      case "receipt":
      case "heartbeat":
        // never a transition
        break;
    }
  }

  const states = [...byContract.values()]
    .filter((s) => s.frames.length > 0)
    .sort((a, b) => b.contractId.localeCompare(a.contractId));
  return { states, offerById };
}

/** Derive agent metrics from frames (both sides of every deal count). */
export function computeAgentMetrics(did: string, frames: TclkFrame[]): AgentMetrics {
  const { states } = buildDealStates(frames);

  let deals = 0;
  let completed = 0;
  let refunded = 0;
  let cancelled = 0;
  let open = 0;
  const deliveries: number[] = [];
  let volumeClaimed = 0;
  const assets = new Set<string>();
  const roles = new Set<string>();
  let selfDealing = false;
  let receiptInconsistency = false;

  for (const st of states) {
    const isParty = st.payer === did || st.payee === did;
    if (!isParty) continue;
    deals++;
    if (st.payer === did && st.payee === did) selfDealing = true;
    roles.add(st.payer ?? "");
    if (st.asset) assets.add(st.asset);
    const amount = Number(st.amount);
    switch (st.state) {
      case "claimed":
        completed++;
        if (Number.isFinite(amount)) volumeClaimed += amount;
        if (st.lockedAtMs !== undefined && st.revealedAtMs !== undefined) {
          deliveries.push(Math.max(0, st.revealedAtMs - st.lockedAtMs));
        }
        break;
      case "refunded":
        refunded++;
        break;
      case "cancelled":
        cancelled++;
        break;
      default:
        open++;
    }
    // receipt-outcome corroboration
    for (const f of st.frames) {
      if (f.type === "receipt" && f.outcome) {
        if (st.state === "claimed" && f.outcome !== "claimed") receiptInconsistency = true;
        if (st.state === "refunded" && f.outcome !== "refunded") receiptInconsistency = true;
        if (st.state === "cancelled" && f.outcome !== "cancelled") receiptInconsistency = true;
      }
    }
  }

  const done = completed + refunded;
  const successRate = done > 0 ? completed / done : null;

  // delivery speed vs the safe window (claimBy → refundAfter)
  let speedBonus = 0;
  const speeds: number[] = [];
  for (const st of states) {
    if (st.payer !== did && st.payee !== did) continue;
    if (st.state !== "claimed") continue;
    const locked = st.lockedAtMs;
    const revealed = st.revealedAtMs;
    const refundAfter = st.refundAfterMs;
    if (locked === undefined || revealed === undefined || refundAfter === undefined) continue;
    if (refundAfter > locked) {
      const ratio = (revealed - locked) / (refundAfter - locked);
      const bounded = Math.min(Math.max(ratio, 0), 1);
      speeds.push(1 - bounded);
    }
  }
  if (speeds.length > 0) {
    speeds.sort((a, b) => a - b);
    const median = speeds[Math.floor(speeds.length / 2)];
    speedBonus = Math.round(40 * median);
  }

  const volumeBonus = Math.min(50, Math.round(Math.log10(1 + volumeClaimed) * 12));

  let score = NEUTRAL_SCORE;
  score += Math.min(320, completed * 80);
  score -= Math.min(280, refunded * 70 + cancelled * 20);
  score += speedBonus + volumeBonus;

  const highOfferRate = (() => {
    if (frames.filter((f) => f.type === "offer" && f.did === did).length < 12) return false;
    return completed === 0 && refunded === 0;
  })();

  if (selfDealing || highOfferRate) {
    score = Math.min(score, 300);
  }
  if (receiptInconsistency) score = Math.max(0, score - 40);

  score = Math.max(0, Math.min(1000, Math.round(score)));

  const avgDeliveryMs =
    deliveries.length > 0 ? Math.round(deliveries.reduce((a, b) => a + b, 0) / deliveries.length) : null;

  const summary = summarize(did, {
    completed,
    refunded,
    cancelled,
    deals,
    successRate,
    volumeClaimed,
    assets,
    selfDealing,
    highOfferRate,
    score,
  });

  return {
    did,
    deals,
    completed,
    refunded,
    cancelled,
    open,
    successRate,
    avgDeliveryMs,
    volumeClaimed,
    assets: [...assets],
    selfDealing,
    highOfferRate,
    receiptInconsistency,
    score,
    tier: tierFor(score, deals),
    summary,
  };
}

function summarize(
  did: string,
  m: {
    completed: number;
    refunded: number;
    cancelled: number;
    deals: number;
    successRate: number | null;
    volumeClaimed: number;
    assets: Set<string>;
    selfDealing: boolean;
    highOfferRate: boolean;
    score: number;
  },
): string {
  const name = `identity_${did.slice(-4)}`;
  if (m.deals === 0) {
    return `${name} has no tclk deal history yet on the public board. Neutral by default.`;
  }
  const rate =
    m.successRate === null ? "no settlement yet" : `${Math.round(m.successRate * 100)}% settlement`;
  const vol =
    m.volumeClaimed > 0
      ? `${m.volumeClaimed.toLocaleString()} ${[...m.assets][0] ?? "units"} settled`
      : "no settled volume yet";
  let flags = "";
  if (m.selfDealing) flags = " Flagged: same identity on both sides of a deal.";
  if (m.highOfferRate) flags += " Flagged: many offers, none completed.";
  return `${name} completed ${m.completed} of ${m.deals} deals (${rate}); ${vol}; trust score ${m.score}/1000.${flags}`;
}