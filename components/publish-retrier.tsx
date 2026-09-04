"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  getPendingSnapshot,
  markAttempt,
  removePending,
  subscribePending,
  EMPTY_PENDING,
  type PendingPublish,
} from "@/lib/pending-publishes";
import { useSession } from "@/components/use-session";
import { getUnlocked, signDraft } from "@/lib/keyring";
import { getClient } from "@/lib/client";
import { saveReceipt, sha256Hex, type Receipt } from "@/lib/receipts";
import { TechnocoreError } from "@/lib/technocore";

const RETRY_MS = 15_000;
const MAX_ATTEMPTS = 240;

/**
 * Background publish retrier. While the browser tab is open:
 *  - every 15s it tries the queued publishes (fast path: right away);
 *  - if the session is unlocked, it re-signs (fresh nonce) and republishes;
 *  - a success is promoted to a receipt and the queue entry removed;
 *  - a 422 (identical text already on the board in the dup window) is treated
 *    as "already posted" — the item is marked done, never left hanging.
 * Nonces are per (did, room) and strictly increasing, so a retry is always
 * acceptable to the server.
 */
export function PublishRetrier() {
  const { did } = useSession();
  const pending = useSyncExternalStore(subscribePending, getPendingSnapshot, () => EMPTY_PENDING);
  const [status, setStatus] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    const publish = async (item: PendingPublish) => {
      const draft = signDraft(item.room, item.text);
      const client = getClient();
      const res = await client.writeSigned({
        room: item.room,
        did: draft.did,
        sig: draft.sig,
        nonce: draft.nonce,
        text: draft.sweptText,
      });
      if (res.posted?.seq) {
        const responseHash = await sha256Hex(res.body);
        const receipt: Receipt = {
          id: `${draft.did.slice(-6)}-${draft.nonce}`,
          did: draft.did,
          room: item.room,
          seq: res.posted.seq,
          nonce: draft.nonce,
          text: draft.sweptText,
          sig: draft.sig,
          ts: res.posted.ts,
          url: res.url,
          status: res.status,
          responseHash,
          createdAt: new Date().toISOString(),
        };
        saveReceipt(receipt);
        removePending(item.id);
        setStatus(`Publish landed: seq ${res.posted.seq} in /${item.room}`);
        return;
      }
      if (res.status === 422) {
        // identical text already posted by someone in the dup window — done.
        removePending(item.id);
        setStatus(`Already on the board (same text) — marked as published`);
        return;
      }
      markAttempt(item.id);
    };

    const tick = async () => {
      if (busy.current) return;
      const list = getPendingSnapshot();
      if (list.length === 0) return;
      const unlocked = getUnlocked();
      if (!unlocked) return;
      busy.current = true;
      try {
        for (const item of list) {
          if (item.attempts >= MAX_ATTEMPTS) {
            markAttempt(item.id); // keeps counting; honestly rare
            continue;
          }
          try {
            await publish(item);
          } catch (e) {
            if (e instanceof TechnocoreError && e.status === 422) {
              removePending(item.id);
              setStatus("Already on the board (same text) — marked as published");
            } else {
              markAttempt(item.id);
            }
          }
        }
      } finally {
        busy.current = false;
      }
    };
    const t = setInterval(() => void tick(), RETRY_MS);
    void tick();
    return () => clearInterval(t);
  }, []);

  // Expire the toast after a while.
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 8000);
    return () => clearTimeout(t);
  }, [status]);

  if (pending.length === 0 && !status) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[90] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 px-0">
      <div className="banner-in flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-full border border-hairline-strong bg-canvas px-4 py-2 text-[13px]">
        {status ? (
          <span className="flex items-center gap-2 text-ink">
            <span className="pulse-dot h-2 w-2 rounded-full bg-terminal-green" aria-hidden />
            <span className="min-w-0">{status}</span>
          </span>
        ) : null}
        {pending.length > 0 ? (
          <span className="flex items-center gap-2 text-body">
            <span className="pulse-dot h-2 w-2 shrink-0 rounded-full bg-terminal-yellow" aria-hidden />
            <span className="min-w-0">
              {pending.length} pending publish{pending.length > 1 ? "es" : ""}
              {did ? " · retrying automatically" : " · unlock identity to retry"}
              {" · "}
              <Link
                href="/sign"
                onClick={() => setStatus(null)}
                className="font-medium text-ink underline underline-offset-2"
              >
                open /sign
              </Link>
            </span>
          </span>
        ) : null}
      </div>
    </div>
  );
}