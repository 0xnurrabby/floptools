/**
 * Stored-frame access for Trustcore (Neon trustcore_frames).
 */

import { safeExec, safeQuery, type Row } from "./db";
import type { TclkFrame } from "./tclk";

export function frameFromRow(r: Row): TclkFrame {
  return {
    hash: String(r["hash"]),
    type: (r["frame_type"] ?? "offer") as TclkFrame["type"],
    did: String(r["did"]),
    room: String(r["room"]),
    seq: Number(r["seq"] ?? 0),
    ts: String(r["ts"] ?? ""),
    contractId: (r["contract_id"] as string) ?? undefined,
    offerId: (r["offer_id"] as string) ?? undefined,
    ref: (r["ref"] as string) ?? undefined,
    amount: (r["amount"] as string) ?? undefined,
    asset: (r["asset"] as string) ?? undefined,
    role: (r["role"] as string) ?? undefined,
    outcome: (r["outcome"] as string) ?? undefined,
    rail: (r["rail"] as string) ?? undefined,
    lockKind: (r["lock_kind"] as string) ?? undefined,
    secret: (r["secret"] as string) ?? undefined,
    rawText: String(r["raw_text"] ?? ""),
  };
}

export async function framesForDid(did: string, limit = 800): Promise<TclkFrame[]> {
  const rows = (await safeQuery(
    `SELECT * FROM trustcore_frames WHERE did = $1 ORDER BY created_at DESC LIMIT $2`,
    [did, limit],
  )) ?? [];
  return rows.map(frameFromRow);
}

/**
 * Every frame that belongs to this identity's deals: its own frames plus the
 * counterparty's frames for the same contracts, plus the offers its accepts
 * reference. A deal state can only be reconstructed when both sides' frames
 * are present (the accept/payee side and the offer/payer side live in
 * different dids' frames), so a per-identity profile must look past its own
 * rows.
 */
export async function framesForDealOfDid(did: string, limit = 1200): Promise<TclkFrame[]> {
  const rows = (await safeQuery(
    `SELECT * FROM trustcore_frames
     WHERE did = $1
        OR (contract_id IS NOT NULL AND contract_id IN (
              SELECT DISTINCT contract_id FROM trustcore_frames WHERE did = $1 AND contract_id IS NOT NULL))
        OR (offer_id IS NOT NULL AND offer_id IN (
              SELECT DISTINCT offer_id FROM trustcore_frames WHERE did = $1 AND offer_id IS NOT NULL))
        OR (offer_id IS NOT NULL AND offer_id IN (
              SELECT DISTINCT ref FROM trustcore_frames WHERE did = $1 AND frame_type = 'accept'))
     ORDER BY created_at DESC
     LIMIT $2`,
    [did, limit],
  )) ?? [];
  return rows.map(frameFromRow);
}

export async function knownDids(limit = 150): Promise<string[]> {
  const rows = (await safeQuery(
    `SELECT DISTINCT did FROM trustcore_frames ORDER BY did LIMIT $1`,
    [limit],
  )) ?? [];
  return rows.map((r) => String(r["did"]));
}

export async function latestFrames(limit = 30): Promise<TclkFrame[]> {
  const rows = (await safeQuery(
    `SELECT * FROM trustcore_frames ORDER BY created_at DESC LIMIT $1`,
    [limit],
  )) ?? [];
  return rows.map(frameFromRow);
}

/** Remember a deal room so future ingests scan it (idempotent). */
export async function rememberDealRoom(room: string): Promise<void> {
  await safeExec("INSERT INTO trustcore_rooms (room) VALUES ($1) ON CONFLICT (room) DO NOTHING", [room]);
}

/** Deal rooms the app has seen, newest first (these are the ones most likely to still be retained). */
export async function knownDealRooms(limit = 500): Promise<string[]> {
  const rows = (await safeQuery(
    `SELECT room FROM trustcore_rooms ORDER BY created_at DESC LIMIT $1`,
    [limit],
  )) ?? [];
  return rows.map((r) => String(r["room"]));
}

export async function counterStats(): Promise<{ frames: number; agents: number; contracts: number }> {
  const rows =
    (await safeQuery(
      `SELECT
         (SELECT COUNT(*) FROM trustcore_frames) AS frames,
         (SELECT COUNT(DISTINCT did) FROM trustcore_frames) AS agents,
         (SELECT COUNT(DISTINCT contract_id) FROM trustcore_frames WHERE contract_id IS NOT NULL) AS contracts`,
    )) ?? [];
  const r = rows[0] ?? {};
  return {
    frames: Number(r["frames"] ?? 0),
    agents: Number(r["agents"] ?? 0),
    contracts: Number(r["contracts"] ?? 0),
  };
}