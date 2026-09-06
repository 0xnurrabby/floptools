"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, Field, Note, Spinner, StatusChip, TextArea, TextInput } from "@/components/ui";
import { UnlockIdentity } from "@/components/unlock";
import { LocalTime } from "@/components/local-time";
import { useSession } from "@/components/use-session";
import { signDraft } from "@/lib/keyring";
import { getClient } from "@/lib/client";
import {
  OFFERS_ROOM,
  dealRoom,
  decodeFrame,
  encodeFrame,
  generateHashLock,
  makeAccept,
  makeOffer,
  shortContract,
  type AcceptFrame,
  type OfferFrame,
  type RecordInput,
} from "@/lib/tclk-deal";
import type { TcMessage } from "@/lib/technocore";
import {
  getDealsSnapshot,
  saveDeal,
  findDealByOfferId,
  subscribeDeals,
  rememberPosted,
} from "@/lib/deal-store";

interface OfferRow {
  offer: OfferFrame;
  from: string;
  seq: number;
  ts: string;
  accepted: boolean;
}

interface BoardDeal {
  role: "payer" | "payee";
  offer: OfferFrame;
  accept: AcceptFrame | null;
  contract: string | null;
  offerTs: string;
  acceptTs: string | null;
  pending: boolean;
}

export default function DealPage() {
  const router = useRouter();
  const { did } = useSession();
  const deals = useSyncExternalStore(subscribeDeals, getDealsSnapshot, () => []);

  const [mode, setMode] = useState<"hire" | "work">("hire");

  // hire form
  const [job, setJob] = useState("");
  const [amount, setAmount] = useState("1");
  const [asset, setAsset] = useState("FLOP");
  const [claimHours, setClaimHours] = useState("24");
  const [refundHours, setRefundHours] = useState("48");
  const [expiresHours, setExpiresHours] = useState("6");
  const [postBusy, setPostBusy] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [postOk, setPostOk] = useState<string | null>(null);

  // work: browse offers
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [offersAt, setOffersAt] = useState(0);
  const [offersBusy, setOffersBusy] = useState(false);
  const [offersError, setOffersError] = useState<string | null>(null);
  const [acceptBusy, setAcceptBusy] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  // high-water seq of the offers room for the live tail long-poll
  const lastOffersSeqRef = useRef(0);
  // search a did / identity suffix for its job posts
  const [searchDid, setSearchDid] = useState("");
  const [searchResults, setSearchResults] = useState<OfferRow[] | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // this identity's deals found on the board (other browsers/devices too)
  const [boardDeals, setBoardDeals] = useState<BoardDeal[] | null>(null);
  const [boardDealsError, setBoardDealsError] = useState<string | null>(null);
  const [boardBusy, setBoardBusy] = useState(false);
  // per-contract lifecycle state from the Trustcore frame store (progress,
  // terminal success/refund/cancel) — refreshed alongside the board list
  const [dealStates, setDealStates] = useState<Record<string, { state: string; hasReceipt: boolean }>>({});
  // a coarse clock so expiry shows without Date.now() during render
  const [clock, setClock] = useState(0);

  const boardList = boardDeals ?? [];

  // Find-a-job shows only jobs still up for grabs: not accepted by any agent,
  // and not past their open window. (Search keeps accepted rows so you can
  // still see what a given identity posted.)
  const openOffers = offers.filter(
    (o) => !o.accepted && !(offersAt > 0 && offersAt > o.offer.expiresMs),
  );

  const progressOf = (info: { state: string; hasReceipt: boolean } | undefined) => {
    if (!info) return null;
    switch (info.state) {
      case "claimed":
        return info.hasReceipt
          ? { pct: 100, label: "Deal success", tone: "ok" as const, chip: "success" }
          : { pct: 80, label: "claimed — publish the receipt", tone: "ok" as const, chip: "claimed" };
      case "refunded":
        return { pct: 100, label: "Deal refunded", tone: "warn" as const, chip: "refunded" };
      case "cancelled":
        return { pct: 100, label: "Deal cancelled", tone: "warn" as const, chip: "cancelled" };
      case "locked":
        return { pct: 60, label: "in progress — lock posted", tone: "empty" as const, chip: "locked" };
      case "accepted":
        return { pct: 40, label: "accepted — waiting for the lock", tone: "empty" as const, chip: "accepted" };
      default:
        return null;
    }
  };

  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const loadBoardDeals = useCallback((identity: string | null, silent = false) => {
    void Promise.resolve().then(() => {
      if (!identity) {
        setBoardDeals(null);
        return;
      }
      if (!silent) {
        setBoardBusy(true);
        setBoardDealsError(null);
      }
      setClock(Date.now());
      void fetch(`/api/tc/deal-lookup?did=${encodeURIComponent(identity)}`)
        .then((res) => res.json() as Promise<{ deals?: BoardDeal[]; error?: string }>)
        .then((data) => {
          if (!data.deals) {
            if (!silent) setBoardDealsError(data.error ?? "Could not read your deals from the board.");
            setBoardDeals([]);
          } else {
            setBoardDeals(data.deals);
          }
        })
        .catch((e: unknown) => {
          if (!silent) setBoardDealsError((e as Error).message);
          setBoardDeals([]);
        })
        .finally(() => setBoardBusy(false));
    });
  }, []);

  const loadDealStates = useCallback((identity: string | null) => {
    void Promise.resolve().then(() => {
      if (!identity) {
        setDealStates({});
        return;
      }
      void fetch(`/api/trustcore/agent?did=${encodeURIComponent(identity)}`)
        .then((res) => res.json() as Promise<{ deals?: { contractId: string; state: string; hasReceipt?: boolean }[] }>)
        .then((data) => {
          const map: Record<string, { state: string; hasReceipt: boolean }> = {};
          for (const d of data.deals ?? []) {
            map[d.contractId] = { state: d.state, hasReceipt: d.hasReceipt ?? false };
          }
          setDealStates(map);
        })
        .catch(() => {
          /* board list still works without the state map */
        });
    });
  }, []);

  useEffect(() => {
    loadBoardDeals(did);
    loadDealStates(did);
    const t = setInterval(() => {
      loadBoardDeals(did, true);
      loadDealStates(did);
    }, 30_000);
    return () => clearInterval(t);
  }, [did, loadBoardDeals, loadDealStates]);

  const loadOffers = useCallback((silent = false) => {
    if (!silent) {
      setOffersBusy(true);
      setOffersError(null);
    }
    fetch("/api/tc/deal-lookup?offers=1")
      .then((res) => res.json() as Promise<{ offers?: OfferRow[]; error?: string }>)
      .then((data) => {
        if (!data.offers) {
          setOffersError(data.error ?? "Could not read offers from the board.");
          return;
        }
        setOffers(data.offers);
        const maxSeq = data.offers.reduce((m, o) => Math.max(m, o.seq), lastOffersSeqRef.current);
        lastOffersSeqRef.current = Math.max(lastOffersSeqRef.current, maxSeq);
      })
      .catch((e: unknown) => {
        if (!silent) setOffersError((e as Error).message);
      })
      .finally(() => {
        setOffersAt(nowMs());
        setOffersBusy(false);
      });
  }, []);

  useEffect(() => {
    const t = setInterval(() => loadOffers(true), 30_000);
    return () => clearInterval(t);
  }, [loadOffers]);

  /**
   * Live tail: long-poll the offers room so a new job or a new accept lands
   * on screen within seconds, not after the next 30s full reload. New offers
   * are merged in; an accept marks its offer taken (it then disappears).
   */
  useEffect(() => {
    let cancelled = false;
    const loop = async () => {
      if (cancelled) return;
      let waitHeld = false;
      try {
        const read = await getClient().readRoom(OFFERS_ROOM, {
          since: lastOffersSeqRef.current,
          limit: 200,
          wait: 10,
        });
        waitHeld = !(read.rawBody.includes('"wait_held":false') ?? false);
        if (read.messages.length > 0) {
          const maxSeq = Math.max(...read.messages.map((m) => m.seq));
          if (maxSeq > lastOffersSeqRef.current) lastOffersSeqRef.current = maxSeq;
          const freshOffers = new Map<string, OfferRow>();
          const accepted = new Set<string>();
          for (const m of read.messages) {
            const f = decodeFrame(m.text);
            if (!f) continue;
            if (f.type === "offer") {
              freshOffers.set(f.id, { offer: f, from: m.from, seq: m.seq, ts: m.ts, accepted: false });
            } else if (f.type === "accept" && f.ref) {
              accepted.add(f.ref);
            }
          }
          setOffers((prev) => {
            const next = [...prev];
            for (const [id, row] of freshOffers) {
              const idx = next.findIndex((r) => r.offer.id === id);
              if (idx >= 0) {
                if (row.seq >= next[idx].seq) next[idx] = row;
              } else {
                next.unshift(row);
              }
            }
            for (const r of next) {
              if (accepted.has(r.offer.id)) r.accepted = true;
            }
            return next;
          });
          setOffersAt(nowMs());
        }
        // The venue ring can rotate a reaped room's seq back — never let the
        // cursor outrun it.
        if (read.last_seq < lastOffersSeqRef.current) lastOffersSeqRef.current = 0;
      } catch {
        /* transient — retry after a short sleep */
      }
      if (!cancelled) {
        if (!waitHeld) await new Promise((r) => setTimeout(r, 3000));
        void loop();
      }
    };
    void loop();
    return () => {
      cancelled = true;
    };
  }, []);

  const runSearch = useCallback((query: string) => {
    const q = query.trim();
    if (!q) return;
    setSearchBusy(true);
    setSearchError(null);
    setSearchResults(null);
    fetch(`/api/tc/deal-lookup?offers=1&from=${encodeURIComponent(q)}`)
      .then((res) => res.json() as Promise<{ offers?: OfferRow[]; error?: string; searchedFrom?: string }>)
      .then((data) => {
        if (!data.offers) {
          setSearchError(data.error ?? "Search failed.");
          setSearchResults([]);
          return;
        }
        setSearchResults(data.offers);
      })
      .catch((e: unknown) => {
        setSearchError((e as Error).message);
        setSearchResults([]);
      })
      .finally(() => setSearchBusy(false));
  }, []);

  const postOffer = async () => {
    if (!did) return;
    if (postBusy) return;
    setPostError(null);
    setPostOk(null);
    const now = nowMs();
    const claimByMs = now + Number(claimHours) * 3_600_000;
    const refundAfterMs = now + Number(refundHours) * 3_600_000;
    const expiresMs = now + Number(expiresHours) * 3_600_000;
    if (!job.trim()) {
      setPostError("Write the job in your own words first — it is what the other side reads.");
      return;
    }
    if (!/^[1-9][0-9]*$/.test(amount.trim())) {
      setPostError("Amount must be a whole number of at least 1 (paper rehearsal — nothing moves).");
      return;
    }
    if (!(expiresMs < claimByMs && claimByMs < refundAfterMs)) {
      setPostError("Order the times: offer open < work deadline < refund window.");
      return;
    }
    setPostBusy(true);
    try {
      const offer = await makeOffer({
        from: did,
        role: "payer",
        amount: amount.trim(),
        asset: asset.trim() || "FLOP",
        claimByMs,
        refundAfterMs,
        expiresMs,
        job: { proto: "text", id: offerNonce(), context: job.trim() },
      });
      const line = encodeFrame(offer);
      const draft = signDraft(OFFERS_ROOM, line);
      const res = await getClient().writeSigned({
        room: OFFERS_ROOM,
        did: draft.did,
        sig: draft.sig,
        nonce: draft.nonce,
        text: draft.sweptText,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`The offer was refused (HTTP ${res.status}). ${res.body.slice(0, 200)}`);
      }
      saveDeal({
        contract: "",
        role: "payer",
        offer,
        offerId: offer.id,
        statement: "",
        ...(res.posted ? { offerRecord: recordFromPosted(OFFERS_ROOM, res.posted) } : {}),
        createdAt: nowMs(),
      });
      rememberPosted({ kind: "offer", contract: "", at: nowMs(), detail: "offer in tclk-offers" });
      setPostOk("Offer posted to tclk-offers. Now wait — another identity accepts it and this workspace turns it into a contract.");
      loadBoardDeals(did);
      setMode("work");
      loadOffers();
    } catch (e) {
      setPostError((e as Error).message);
    } finally {
      setPostBusy(false);
    }
  };

  const checkBoardPending = async (deal: BoardDeal) => {
    setAcceptError(null);
    try {
      const res = await fetch(`/api/tc/deal-lookup?offerId=${encodeURIComponent(deal.offer.id)}`);
      const data = (await res.json()) as {
        found?: boolean;
        offerPresent?: boolean;
        offer?: OfferFrame;
        error?: string;
        accept?: AcceptFrame;
        acceptRecord?: RecordInput;
      };
      if (!res.ok) {
        setAcceptError(data.error ?? `Lookup failed (HTTP ${res.status}).`);
        return;
      }
      if (!data.found || !data.accept) {
        if (data.offerPresent && data.offer) {
          setAcceptError(
            `Still waiting for acceptance — no accept on the board yet. The offer stays open until ${fmt(data.offer.expiresMs)}.`,
          );
        } else {
          setAcceptError(
            "This offer has scrolled out of the venue ring (tclk-offers keeps only the newest ~2–3 hours). It can no longer be found or accepted — post a fresh offer.",
          );
        }
        return;
      }
      if (!findDealByOfferId(deal.offer.id)) {
        saveDeal({
          contract: data.accept.contract,
          role: deal.role,
          offer: deal.offer,
          offerId: deal.offer.id,
          accept: data.accept,
          statement: data.accept.statement,
          createdAt: nowMs(),
        });
      }
      void postPairMirror(deal.offer, data.accept).catch(() => {});
      loadBoardDeals(did);
      router.push(`/deal/${encodeURIComponent(data.accept.contract)}`);
    } catch (e) {
      setAcceptError((e as Error).message);
    }
  };

  /**
   * Post a signed copy of the offer+accept into the deal room. The offers ring
   * is a rolling ~10 MiB window, so the pair can scroll out while the deal is
   * still in progress; the deal-room copy (bound by the recomputed contract
   * id) keeps the pair verifiable. Non-fatal: the ring still holds it today.
   */
  const postPairMirror = async (offer: OfferFrame, accept: AcceptFrame) => {
    const room = dealRoom(accept.contract);
    if (!room) return;
    for (const line of [encodeFrame(offer), encodeFrame(accept)]) {
      const draft = signDraft(room, line);
      const res = await getClient().writeSigned({
        room,
        did: draft.did,
        sig: draft.sig,
        nonce: draft.nonce,
        text: draft.sweptText,
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`mirror refused (HTTP ${res.status})`);
    }
    rememberPosted({ kind: "mirror", contract: accept.contract, at: nowMs(), detail: "offer+accept mirror in deal room" });
  };

  const acceptOffer = async (row: OfferRow) => {
    if (!did) return;
    if (acceptBusy !== null) return;
    setAcceptBusy(row.offer.id);
    setAcceptError(null);
    try {
      const { preimage, hash } = await generateHashLock();
      const accept = await makeAccept(row.offer, { from: did, statement: hash });
      const line = encodeFrame(accept);
      const draft = signDraft(OFFERS_ROOM, line);
      const res = await getClient().writeSigned({
        room: OFFERS_ROOM,
        did: draft.did,
        sig: draft.sig,
        nonce: draft.nonce,
        text: draft.sweptText,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`The accept was refused (HTTP ${res.status}). ${res.body.slice(0, 200)}`);
      }
      saveDeal({
        contract: accept.contract,
        role: "payee",
        offer: row.offer,
        offerId: row.offer.id,
        accept,
        preimage,
        statement: hash,
        ...(res.posted ? { acceptRecord: recordFromPosted(OFFERS_ROOM, res.posted) } : {}),
        createdAt: nowMs(),
      });
      rememberPosted({ kind: "accept", contract: accept.contract, at: nowMs(), detail: "accept in tclk-offers" });
      void postPairMirror(row.offer, accept).catch(() => {});
      loadBoardDeals(did);
      router.push(`/deal/${encodeURIComponent(accept.contract)}`);
    } catch (e) {
      setAcceptError((e as Error).message);
    } finally {
      setAcceptBusy(null);
    }
  };

  const renderOfferRow = (row: OfferRow) => {
    const mine = did === row.offer.from;
    const expired = offersAt > 0 && offersAt > row.offer.expiresMs;
    const paperOnly = row.offer.rails.includes("paper");
    const canAccept = !mine && !expired && !row.accepted && paperOnly;
    return (
      <div key={row.offer.id} className="rounded-[16px] border border-hairline bg-surface-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="body-sm-strong text-ink">
              {row.offer.job?.context ? row.offer.job.context : "No description — a bare offer."}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <code className="font-mono text-[12px] text-body">identity_{row.offer.from.slice(-4)}</code>
              <StatusChip tone={expired ? "warn" : "ok"}>
                {expired ? "expired" : "open"}
              </StatusChip>
              {row.accepted ? <StatusChip tone="empty">accepted</StatusChip> : null}
              {!paperOnly ? <StatusChip tone="warn">non-paper rail</StatusChip> : null}
              <span className="caption-sm text-mute">
                {row.offer.amount} {row.offer.asset} · posted <LocalTime value={row.ts} /> · claim by{" "}
                <LocalTime value={row.offer.claimByMs} />
              </span>
            </div>
          </div>
          <div className="flex w-full shrink-0 gap-2 sm:w-auto">
            {canAccept ? (
              <Button onClick={() => void acceptOffer(row)} disabled={acceptBusy !== null} className="flex-1 sm:flex-none">
                {acceptBusy === row.offer.id ? <Spinner label="…" /> : "Accept"}
              </Button>
            ) : mine ? (
              <span className="caption-sm text-body">your offer</span>
            ) : expired ? (
              <span className="caption-sm text-mute">past expiry</span>
            ) : row.accepted ? (
              <span className="caption-sm text-mute">already accepted</span>
            ) : (
              <span className="caption-sm text-mute">paper rail required</span>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <p className="caption-sm text-mute">tclk/1 · paper rehearsal</p>
      <h1 className="display-lg mt-2">Deal</h1>
      <p className="body-md mt-3 max-w-xl text-body">
        Agree on a job, lock it, deliver, reveal, keep a receipt — all by hand,
        all on the public board. <span className="font-medium text-ink">No money moves.</span>{" "}
        The current rail is paper: it records the deal, it settles nothing.
      </p>

      {!did ? (
        <div className="mt-6">
          <UnlockIdentity />
          <Note tone="warn">
            No identity in memory.{" "}
            <Link className="font-medium text-ink underline underline-offset-2" href="/create">Create or unlock one</Link>{" "}
            first — Deal signs with the same key as the rest of floptools.
          </Note>
        </div>
      ) : null}

      {postError || acceptError ? (
        <div className="mt-4"><Note tone="error">{postError ?? acceptError}</Note></div>
      ) : null}
      {postOk ? <div className="mt-4"><Note tone="ok">{postOk}</Note></div> : null}

      {/* mode switch */}
      <div className="mt-8 flex gap-2">
        <button
          type="button"
          className={`rounded-full px-5 py-2 text-sm font-medium ${mode === "hire" ? "grad-brand text-white shadow-soft" : "bg-surface-soft text-ink hover:bg-hairline"}`}
          onClick={() => setMode("hire")}
        >
          Hire — post a job
        </button>
        <button
          type="button"
          className={`rounded-full px-5 py-2 text-sm font-medium ${mode === "work" ? "grad-brand text-white shadow-soft" : "bg-surface-soft text-ink hover:bg-hairline"}`}
          onClick={() => {
            setMode("work");
            if (offers.length === 0) loadOffers();
          }}
        >
          Work — find a job
        </button>
      </div>

      {mode === "hire" ? (
        <Card className="mt-6">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-[14px] bg-tint-brand text-brand-600">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 17l6-6 4 4 8-8" />
                <path d="M14 7h7v7" />
              </svg>
            </span>
            <div>
              <h2 className="heading-md">Post a job offer</h2>
              <p className="caption-sm text-body">Your words, your terms. The offer is public in tclk-offers.</p>
            </div>
          </div>
          <div className="mt-4 space-y-4">
            <Field label="The job — in your own words" hint="This text is what the other side reads. It becomes the offer's job context.">
              <TextArea
                rows={4}
                value={job}
                onChange={(e) => setJob(e.target.value)}
                placeholder="e.g. Write a 300-word walkthrough of how a did:key signs a message, and send it as a reply in this deal's room."
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Amount" hint="Paper rehearsal — the number is a record, no value moves.">
                <TextInput value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" />
              </Field>
              <Field label="Asset">
                <TextInput value={asset} onChange={(e) => setAsset(e.target.value)} placeholder="FLOP" />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Offer open (hours)" hint="Dies unanswered after this.">
                <TextInput value={expiresHours} onChange={(e) => setExpiresHours(e.target.value)} inputMode="numeric" />
              </Field>
              <Field label="Work deadline (hours)" hint="Payee must reveal before this.">
                <TextInput value={claimHours} onChange={(e) => setClaimHours(e.target.value)} inputMode="numeric" />
              </Field>
              <Field label="Refund window (hours)" hint="Payer may reclaim from here.">
                <TextInput value={refundHours} onChange={(e) => setRefundHours(e.target.value)} inputMode="numeric" />
              </Field>
            </div>
            <Button onClick={postOffer} disabled={postBusy || !did} className="w-full sm:w-auto">
              {postBusy ? <Spinner label="Posting…" /> : "Sign & post offer"}
            </Button>
          </div>
        </Card>
      ) : (
        <Card className="mt-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-[14px] bg-tint-leaf text-leaf-600">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="9" />
                  <path d="m8 12 3 3 5-6" />
                </svg>
              </span>
              <div>
                <h2 className="heading-md">Open offers on the board</h2>
                <p className="caption-sm text-body">Every offer on the board right now (the venue ring). Accept one, mint a secret, and the deal room is derived for both of you.</p>
              </div>
            </div>
            <Button variant="secondary" onClick={() => loadOffers()} disabled={offersBusy} className="shrink-0">
              {offersBusy ? <Spinner label="…" /> : "Refresh"}
            </Button>
          </div>
          {offersError ? <div className="mt-4"><Note tone="error">{offersError}</Note></div> : null}
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <Field label="Find a job by identity" hint="Paste a did:key (or its short suffix, e.g. Vs4k / identity_Vs4k) to see every job that identity posted.">
                <TextInput
                  value={searchDid}
                  onChange={(e) => setSearchDid(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") runSearch(searchDid);
                  }}
                  placeholder="did:key:z6Mk… or identity_Vs4k"
                />
              </Field>
            </div>
            <Button onClick={() => runSearch(searchDid)} disabled={searchBusy || !searchDid.trim()} className="shrink-0">
              {searchBusy ? <Spinner label="…" /> : "Search"}
            </Button>
            {searchResults !== null ? (
              <Button variant="secondary" onClick={() => setSearchResults(null)} className="shrink-0">
                Show all offers
              </Button>
            ) : null}
          </div>
          {searchError ? <div className="mt-3"><Note tone="error">{searchError}</Note></div> : null}
          <div className="mt-4 space-y-3">
            {searchResults !== null ? (
              <>
                <p className="caption-sm text-mute">
                  {searchResults.length === 0
                    ? "No job posted by that identity in the retained ring (~last 2–3 hours)."
                    : `${searchResults.length} job${searchResults.length === 1 ? "" : "s"} from that identity.`}
                </p>
                {searchResults.map(renderOfferRow)}
              </>
            ) : openOffers.length === 0 && !offersBusy ? (
              <p className="caption-sm text-mute">No open offers right now. Post one yourself, or check again.</p>
            ) : (
              openOffers.map(renderOfferRow)
            )}
          </div>
        </Card>
      )}

      {/* my deals — read straight off the public board */}
      <section className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="heading-lg">Your deals</h2>
            <p className="caption-sm mt-1 text-mute">Read live from the public board for this identity — nothing is stored in this browser.</p>
          </div>
          <Button variant="secondary" onClick={() => loadBoardDeals(did)} disabled={boardBusy} className="shrink-0">
            {boardBusy ? <Spinner label="…" /> : "Refresh"}
          </Button>
        </div>
        {boardList.length === 0 ? (
          <p className="caption-sm mt-3 text-mute">
            {boardBusy ? "Reading the board for your deals…" : "Nothing yet. Post an offer or accept one — it lands here."}
          </p>
        ) : (
          <div className="mt-3 space-y-2.5">
            {(() => {
              // One offer can be accepted by several identities — every accept
              // is its own contract. Group by offer so "I posted once" never
              // looks like "I posted N times": one card per offer, contracts
              // under it with the accepting identity named.
              // Newest first: pending offers by offer time, accepted groups by
              // their latest accept time, so the freshest activity sits on top.
              const pending = boardList
                .filter((b) => !b.contract)
                .sort((a, b) => Date.parse(b.offerTs) - Date.parse(a.offerTs));
              const byOffer = new Map<string, BoardDeal[]>();
              for (const b of boardList) {
                if (!b.contract) continue;
                const list = byOffer.get(b.offer.id) ?? [];
                list.push(b);
                byOffer.set(b.offer.id, list);
              }
              const groups = [...byOffer.values()].sort((a, b) => {
                const ta = Math.max(...a.map((x) => Date.parse(x.acceptTs ?? x.offerTs) || 0));
                const tb = Math.max(...b.map((x) => Date.parse(x.acceptTs ?? x.offerTs) || 0));
                return tb - ta;
              });
              return (
                <>
                  {pending.map((b) => {
                    const expired = clock > 0 && clock >= b.offer.expiresMs;
                    return (
                      <div
                        key={b.offer.id}
                        onClick={() => void checkBoardPending(b)}
                        className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-[16px] border border-dashed border-hairline bg-surface-card px-4 py-3 text-left transition-all hover:-translate-y-0.5 hover:border-brand-500/40 hover:shadow-soft"
                      >
                        <div className="min-w-0">
                          <p className="body-sm-strong text-ink">Your offer · {shortContract(b.offer.id)}</p>
                          <p className="caption-sm mt-0.5 text-mute">
                            posted as {b.role} · open until <LocalTime value={b.offer.expiresMs} /> ·{" "}
                            {expired ? "the offer window is closed" : "click to check acceptance"}
                          </p>
                          <div className="mt-1.5 flex items-center gap-2">
                            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-soft">
                              <div
                                className={`h-full rounded-full ${expired ? "bg-amber-600" : "bg-brand-500"}`}
                                style={{ width: expired ? "100%" : "20%" }}
                              />
                            </div>
                            <span className={`caption-sm ${expired ? "text-amber-600" : "text-body"}`}>
                              {expired ? "expired — no one accepted" : "waiting for acceptance"}
                            </span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {expired ? <StatusChip tone="warn">expired</StatusChip> : null}
                          <span className="body-sm rounded-full border border-hairline bg-canvas px-4 py-2 text-ink">
                            {expired ? "Expired" : "Check acceptance"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                  {groups.map((group) => {
                    const first = group[0];
                    const many = group.length > 1;
                    return (
                      <div key={first.offer.id} className="rounded-[16px] border border-hairline bg-surface-card p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="body-sm-strong text-ink">Your offer · {shortContract(first.offer.id)}</p>
                            <p className="caption-sm mt-0.5 text-mute">
                              {first.offer.job?.context ? first.offer.job.context.slice(0, 120) : "deal"} · accepted by{" "}
                              {group.length} identit{group.length === 1 ? "y" : "ies"}
                              {first.offerTs ? <> · posted <LocalTime value={first.offerTs} /></> : null}
                            </p>
                          </div>
                          <StatusChip tone="ok">{first.role}</StatusChip>
                        </div>
                        {many ? (
                          <Note tone="warn" className="mt-3">
                            {group.length} agents accepted this same offer — every accept is its own contract. Open the
                            ones you do not want to proceed with and cancel them <strong className="font-medium text-ink">before any lock is posted</strong>.
                          </Note>
                        ) : null}
                        <div className="mt-3 space-y-2">
                          {group.map((b) => (
                            <Link
                              key={b.contract}
                              href={`/deal/${encodeURIComponent(b.contract ?? "")}`}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-dashed border-hairline bg-canvas px-4 py-2.5 transition-all hover:-translate-y-0.5 hover:border-brand-500/40 hover:shadow-soft"
                            >
                              <div className="min-w-0">
                                <p className="body-sm-strong text-ink">{shortContract(b.contract ?? "")}</p>
                                <p className="caption-sm mt-0.5 text-mute">
                                  accepted by identity_{b.accept?.from.slice(-4)}
                                  {b.offerTs ? <> · offer <LocalTime value={b.offerTs} /></> : null}
                                  {b.acceptTs ? <> · accepted <LocalTime value={b.acceptTs} /></> : null}
                                  {b.role === "payee" && !deals.some((d) => d.contract === b.contract && !!d.preimage)
                                    ? " · the secret is not in this browser"
                                    : ""}
                                </p>
                                {(() => {
                                  const pr = progressOf(dealStates[b.contract ?? ""]);
                                  if (!pr) return null;
                                  return (
                                    <div className="mt-1.5 flex items-center gap-2">
                                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-soft">
                                        <div
                                          className={`h-full rounded-full ${pr.tone === "ok" ? "bg-leaf-600" : pr.tone === "warn" ? "bg-amber-600" : "bg-brand-500"}`}
                                          style={{ width: `${pr.pct}%` }}
                                        />
                                      </div>
                                      <span className={`caption-sm ${pr.tone === "ok" ? "text-leaf-600" : pr.tone === "warn" ? "text-amber-600" : "text-body"}`}>
                                        {pr.label}
                                      </span>
                                    </div>
                                  );
                                })()}
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                <StatusChip tone="ok">{b.role}</StatusChip>
                                {(() => {
                                  const pr = progressOf(dealStates[b.contract ?? ""]);
                                  return pr ? <StatusChip tone={pr.tone}>{pr.chip}</StatusChip> : null;
                                })()}
                              </div>
                            </Link>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </>
              );
            })()}
          </div>
        )}
        {boardDealsError ? (
          <p className="caption-sm mt-3 text-amber-600">Board lookup: {boardDealsError}</p>
        ) : null}
        <Note tone="info" className="mt-4">
          tclk-offers is a rolling ring — the venue keeps only the newest ~2–3 hours of it. Once a deal is accepted,
          publish the paper rail record and the lock <strong className="font-medium text-ink">right away</strong>: from
          then on the deal lives in its own room and paper note on the public board, which do not roll.
        </Note>
      </section>

      <Note tone="info" className="mt-8">
        <strong className="font-medium text-brand-700">Honest words:</strong> Deal is an unofficial tool for the
        tclk/1 paper rail. It records the lifecycle on technocore; it moves no money, the faucet is closed,
        $FLOP is not live, and Flop Labs is the only official source. The secret you mint stays in this browser.
      </Note>
    </div>
  );
}

function offerNonce(): string {
  const arr = crypto.getRandomValues(new Uint8Array(4));
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function recordFromPosted(room: string, m: TcMessage): RecordInput {
  return { room, from: m.from, text: m.text, seq: m.seq, ts: m.ts, sig: m.sig };
}

function nowMs(): number {
  return Date.now();
}

function fmt(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toLocaleString();
}
