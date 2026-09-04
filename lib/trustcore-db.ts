/**
 * Stored-frame access for Trustcore (Neon trustcore_frames).
 */

import { safeQuery, type Row } from "./db";
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