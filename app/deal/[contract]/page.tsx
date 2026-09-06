"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button, Card, CopyButton, Note, Spinner, StatusChip, TextArea } from "@/components/ui";
import { UnlockIdentity } from "@/components/unlock";
import { useSession } from "@/components/use-session";
import { signDraft } from "@/lib/keyring";
import { getClient } from "@/lib/client";
import {
  OFFERS_ROOM,
  contractId,
  decodeFrame,
  dealRoom,
  encodeFrame,
  encodePaperRecord,
  foldContract,
  makeLock,
  makeReceipt,
  makeRefund,
  makeReveal,
  makeCancel,
  nextGuard,
  paperNote,
  decodePaperRecord,
  shortContract,
  type AcceptFrame,
  type FoldResult,
  type OfferFrame,
  type PaperRecord,
  type RecordInput,
  type StepStatus,
} from "@/lib/tclk-deal";
import { findDeal, patchDeal, rememberPosted, type DealRecord } from "@/lib/deal-store";
import { identityShortName } from "@/lib/identity";

interface Board {
  records: RecordInput[];
  paper: PaperRecord | null;
  paperRaw: string | null;
  loaded: boolean;
  error: string | null;
  at: number;
  localFallback: boolean;
}

type PairState =
  | { status: "loading" }
  | { status: "found"; offer: OfferFrame; offerRecord: RecordInput; accept: AcceptFrame; acceptRecord: RecordInput }
  | { status: "notfound" }
  | { status: "error"; error: string };

export default function DealDetailPage() {
  const params = useParams<{ contract: string }>();
  const contract = decodeURIComponent(params.contract);
  const { did } = useSession();
  const [board, setBoard] = useState<Board>({
    records: [],
    paper: null,
    paperRaw: null,
    loaded: false,
    error: null,
    at: 0,
    localFallback: false,
  });
  const [fold, setFold] = useState<FoldResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [workText, setWorkText] = useState("");
  const [deal] = useState<DealRecord | null>(() => findDeal(contract));
  const pairRef = useRef<PairState>({ status: "loading" });
  const [pairState, setPairState] = useState<PairState>({ status: "loading" });
  const lastDealSeqRef = useRef(0);

  const dealRoomName = dealRoom(contract);
  const validContract = dealRoomName !== null;
  const offer = fold?.offer ?? null;
  const accept = fold?.accept ?? null;
  const paper = board.paper;
  const isPayer = did !== null && offer !== null && did === offer.from;
  const isPayee = did !== null && accept !== null && did === accept.from;

  /**
   * Find this contract's offer+accept pair on the board. The room is busy and
   * a rolling ring, so we never read "the first offer in the tail" — the
   * server scans the retained ring export and matches by the recomputed
   * contract id, or honestly reports that it is not there.
   */
  const loadPair = useCallback(() => {
    if (!validContract) return;
    void fetch(`/api/tc/deal-lookup?contract=${encodeURIComponent(contract)}`)
      .then((res) => res.json() as Promise<{ found?: boolean; error?: string; offer?: OfferFrame; offerRecord?: RecordInput; accept?: AcceptFrame; acceptRecord?: RecordInput }>)
      .then((data) => {
        let next: PairState;
        if (data.found && data.offer && data.offerRecord && data.accept && data.acceptRecord) {
          next = { status: "found", offer: data.offer, offerRecord: data.offerRecord, accept: data.accept, acceptRecord: data.acceptRecord };
        } else {
          next = { status: "notfound" };
        }
        pairRef.current = next;
        setPairState(next);
      })
      .catch((e: unknown) => {
        const next: PairState = { status: "error", error: (e as Error).message };
        pairRef.current = next;
        setPairState(next);
      });
  }, [contract, validContract]);

  /**
   * Read the deal room + paper rail. The deal room is append-only, so once we
   * know its last seq we long-poll with `since=<seq>&wait=8` — the venue holds
   * the request until something lands, so the page updates by itself within
   * seconds, with no manual refresh and no busy polling. Returns whether the
   * venue actually held the wait (false = retry after a sleep).
   */
  const readBoard = useCallback(async (opts: { wait?: boolean } = {}): Promise<boolean> => {
    if (!validContract || !dealRoomName) return true;
    const client = getClient();
    const dealRoomRead = await client
      .readRoom(dealRoomName, {
        since: lastDealSeqRef.current,
        limit: 200,
        ...(opts.wait === true ? { wait: 8 } : {}),
      })
      .catch(() => null);
    const waitHeld = opts.wait !== true || !(dealRoomRead?.rawBody.includes('"wait_held":false') ?? false);

    let paperRaw: string | null = null;
    try {
      const { ns, key } = paperNote(contract);
      const note = await client.readNote(ns, key);
      paperRaw = note.found ? note.value : null;
    } catch {
      paperRaw = null;
    }

    const pair = pairRef.current;
    const records: RecordInput[] = [];
    let localFallback = false;
    if (pair.status === "found") {
      records.push(pair.offerRecord, pair.acceptRecord);
    } else if (deal?.accept) {
      // Offline / scrolled-out fallback: trust the local copy only if it
      // really hashes to THIS contract id.
      const computed = await contractId(deal.offer, {
        from: deal.accept.from,
        ref: deal.accept.ref,
        statement: deal.accept.statement,
        paymentKey: deal.accept.paymentKey,
        nonce: deal.accept.nonce,
      });
      if (computed.toLowerCase() === contract.toLowerCase()) {
        records.push(
          deal.offerRecord ?? { room: OFFERS_ROOM, from: deal.offer.from, text: encodeFrame(deal.offer), seq: 0, ts: "", sig: undefined },
          deal.acceptRecord ?? { room: OFFERS_ROOM, from: deal.accept.from, text: encodeFrame(deal.accept), seq: 0, ts: "", sig: undefined },
        );
        localFallback = true;
      }
    }
    for (const m of dealRoomRead?.messages ?? []) {
      records.push({ room: dealRoomName, from: m.from, text: m.text, seq: m.seq, ts: m.ts, sig: m.sig });
    }
    if (dealRoomRead?.messages?.length) {
      const maxSeq = Math.max(...dealRoomRead.messages.map((m) => m.seq));
      if (maxSeq > lastDealSeqRef.current) lastDealSeqRef.current = maxSeq;
    }
    setBoard({
      records,
      paper: paperRaw ? decodePaperRecord(paperRaw) : null,
      paperRaw,
      loaded: true,
      error: pair.status === "error" ? `Could not read the board: ${pair.error}` : null,
      at: nowMs(),
      localFallback,
    });
    return waitHeld;
  }, [contract, dealRoomName, validContract, deal]);

  useEffect(() => {
    loadPair();
    void readBoard();
    let cancelled = false;
    const loop = async () => {
      if (cancelled) return;
      const held = await readBoard({ wait: true });
      if (cancelled) return;
      if (!held) await new Promise((r) => setTimeout(r, 8000));
      void loop();
    };
    void loop();
    return () => {
      cancelled = true;
    };
  }, [loadPair, readBoard]);

  useEffect(() => {
    if (pairState.status === "loading") return;
    void readBoard();
  }, [pairState, readBoard]);

  useEffect(() => {
    if (!validContract) return;
    let cancelled = false;
    void foldContract(board.records, board.paper, { contract }).then((f) => {
      if (!cancelled) setFold(f);
    });
    return () => {
      cancelled = true;
    };
  }, [board, contract, validContract]);

  const postTo = async (room: string, text: string) => {
    const draft = signDraft(room, text);
    const res = await getClient().writeSigned({
      room,
      did: draft.did,
      sig: draft.sig,
      nonce: draft.nonce,
      text: draft.sweptText,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Refused by the venue (HTTP ${res.status}). ${res.body.slice(0, 200)}`);
    }
    return res;
  };

  const paperMatches = (rec: PaperRecord | null): boolean =>
    offer !== null &&
    accept !== null &&
    rec !== null &&
    rec.lock === offer.lock &&
    rec.statement === accept.statement &&
    rec.refundAfterMs === offer.refundAfterMs;

  const writePaperRecord = async (overwrite = false) => {
    if (!offer || !accept) return;
    setBusy("paper");
    setActionMsg(null);
    try {
      const { ns, key } = paperNote(contract);
      const value = encodePaperRecord({
        status: "locked",
        lock: offer.lock,
        statement: accept.statement,
        refundAfterMs: offer.refundAfterMs,
      });

      const existing = await getClient().readNote(ns, key).catch(() => null);
      if (existing?.found && existing.value) {
        const rec = decodePaperRecord(existing.value);
        if (paperMatches(rec)) {
          setActionMsg({ ok: true, text: `The rail record is already on the board and matches this contract — skip straight to posting the lock.` });
          void readBoard();
          return;
        }
        if (!overwrite) {
          setActionMsg({
            ok: false,
            text: `A different paper record is on the rail for this contract. Overwrite it with the matching record (CAS), or ask the other side to fix theirs first.`,
          });
          return;
        }
        const res = await getClient().setNote(ns, key, value, { if: existing.value });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`The rail record was refused (HTTP ${res.status}). ${res.body.slice(0, 200)}`);
        }
        rememberPosted({ kind: "paper", contract, at: nowMs(), detail: `tclk-paper-${ns.slice(-2)}/${key}` });
        setActionMsg({ ok: true, text: `Paper rail record written to kv/${ns}/${key} (replaced the mismatched one). Now post the lock — it names the full contract id.` });
        void readBoard();
        return;
      }

      try {
        const res = await getClient().setNote(ns, key, value, { ifAbsent: true });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`The rail record was refused (HTTP ${res.status}). ${res.body.slice(0, 200)}`);
        }
      } catch (e) {
        const err = e as { status?: number };
        if (err?.status === 409) {
          // It appeared between our read and write (a parallel worker won).
          const again = await getClient().readNote(ns, key).catch(() => null);
          const rec = again?.found && again.value ? decodePaperRecord(again.value) : null;
          if (paperMatches(rec)) {
            setActionMsg({ ok: true, text: "The rail record landed just now (a parallel write won) and it matches — post the lock." });
            void readBoard();
            return;
          }
          throw new Error("The rail record appeared between your read and write, and it does NOT match this contract. Overwrite it to proceed.");
        }
        throw e;
      }
      rememberPosted({ kind: "paper", contract, at: nowMs(), detail: `tclk-paper-${ns.slice(-2)}/${key}` });
      setActionMsg({ ok: true, text: `Paper rail record written to kv/${ns}/${key}. Now post the lock — it names the full contract id.` });
      void readBoard();
    } catch (e) {
      setActionMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const postLock = async () => {
    if (!offer || !did) return;
    if (!dealRoomName) return;
    setBusy("lock");
    setActionMsg(null);
    try {
      // Guard (spec §5 + PaperRail): re-check the rail record matches the signed
      // statement and refund deadline, then lock with the FULL contract id as ref.
      const { ns, key } = paperNote(contract);
      const note = await getClient().readNote(ns, key);
      const rec = note.found ? decodePaperRecord(note.value) : null;
      if (
        !rec ||
        rec.lock !== offer.lock ||
        rec.statement !== accept?.statement ||
        rec.refundAfterMs !== offer.refundAfterMs
      ) {
        throw new Error(
          "Blocked: the paper rail record does not match this contract's statement and refund deadline. Write a matching record first — a lock can only name the full contract id after the record exists.",
        );
      }
      const frame = makeLock({ from: did, contract, rail: "paper", ref: contract });
      await postTo(dealRoomName, encodeFrame(frame));
      if (deal) patchDeal(contract, { lock: frame });
      rememberPosted({ kind: "lock", contract, at: nowMs(), detail: "lock frame in deal room" });
      setActionMsg({ ok: true, text: "Lock posted. The payee now submits the work and reveals." });
      void readBoard();
    } catch (e) {
      setActionMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const postWork = async () => {
    if (!did || !dealRoomName) return;
    if (!workText.trim()) return;
    setBusy("work");
    setActionMsg(null);
    try {
      await postTo(dealRoomName, workText.trim());
      rememberPosted({ kind: "work", contract, at: nowMs(), detail: "deliverable message in deal room" });
      setActionMsg({ ok: true, text: "Your deliverable is on the board. Now reveal the secret to claim the deal." });
      setWorkText("");
      void readBoard();
    } catch (e) {
      setActionMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const reveal = async () => {
    if (!did || !accept || !deal || !deal.preimage || !dealRoomName) return;
    setBusy("reveal");
    setActionMsg(null);
    try {
      const lockRef = fold?.lock?.ref;
      const frame = makeReveal({ from: did, contract, ...(lockRef ? { ref: lockRef } : {}), secret: deal.preimage });
      await postTo(dealRoomName, encodeFrame(frame));
      patchDeal(contract, { reveal: frame });
      // paper rail: CAS the record to claimed with the secret (the rail's own action)
      try {
        const { ns, key } = paperNote(contract);
        if (board.paperRaw) {
          await getClient().setNote(ns, key, encodePaperRecord({
            status: "claimed",
            lock: offer?.lock ?? "hash",
            statement: accept.statement,
            refundAfterMs: offer?.refundAfterMs ?? 0,
            secret: deal.preimage,
          }), { if: board.paperRaw });
        }
      } catch {
        /* the rail record may be missing — the reveal frame still stands */
      }
      rememberPosted({ kind: "reveal", contract, at: nowMs(), detail: "reveal frame in deal room" });
      setActionMsg({ ok: true, text: "Revealed. The deal is claimed on the board and the paper record now says claimed. Publish the receipt to finish." });
      void readBoard();
    } catch (e) {
      setActionMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const postRefund = async () => {
    if (!did || !dealRoomName) return;
    setBusy("refund");
    setActionMsg(null);
    try {
      const frame = makeRefund({ from: did, contract, ...(fold?.lock?.ref ? { ref: fold?.lock.ref } : {}) });
      await postTo(dealRoomName, encodeFrame(frame));
      rememberPosted({ kind: "refund", contract, at: nowMs(), detail: "refund frame in deal room" });
      setActionMsg({ ok: true, text: "Refund posted — the deal is refunded." });
      void readBoard();
    } catch (e) {
      setActionMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const postCancel = async () => {
    if (!did || !dealRoomName) return;
    setBusy("cancel");
    setActionMsg(null);
    try {
      const frame = makeCancel({ from: did, contract });
      await postTo(dealRoomName, encodeFrame(frame));
      rememberPosted({ kind: "cancel", contract, at: nowMs(), detail: "cancel frame in deal room" });
      setActionMsg({ ok: true, text: "Cancelled before any lock — the deal is closed." });
      void readBoard();
    } catch (e) {
      setActionMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const postReceipt = async () => {
    if (!did || !dealRoomName) return;
    const outcome = fold?.state === "claimed" ? "claimed" : fold?.state === "refunded" ? "refunded" : fold?.state === "cancelled" ? "cancelled" : null;
    if (!outcome) return;
    setBusy("receipt");
    setActionMsg(null);
    try {
      const frame = makeReceipt({ from: did, contract, outcome, rail: "paper", ref: contract });
      await postTo(dealRoomName, encodeFrame(frame));
      if (deal) patchDeal(contract, { receipt: frame });
      rememberPosted({ kind: "receipt", contract, at: nowMs(), detail: `receipt ${outcome}` });
      setActionMsg({ ok: true, text: `Receipt published (${outcome}). Anyone can open /deal/receipt/${contract} and verify it.` });
      void readBoard();
    } catch (e) {
      setActionMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const guard = fold
    ? nextGuard(fold, paper, { myDid: did ?? "" })
    : { action: "reading the board", blocked: true, reason: "Loading the public rooms…" };
  const refundDue = !!offer && board.at > 0 && board.at >= offer.refundAfterMs;

  /**
   * The one action this identity can take right now, per timeline step. The
   * step's row gets a small button so "whose turn it is" is one click away.
   * Returns a kind only — the handler is bound in the click event, never here.
   */
  type StepActionKind = "paper" | "lock" | "work" | "reveal" | "receipt" | "recheck";
  const actionForStep = (step: StepStatus["step"]): { label: string; kind: StepActionKind; disabled: boolean } | null => {
    if (!offer || !did || (!isPayer && !isPayee)) return null;
    switch (step) {
      case "paper":
        if (isPayer && fold?.state === "accepted" && !paper) {
          return { label: "Write it", kind: "paper", disabled: busy !== null };
        }
        if (isPayer && paper && !paperMatches(paper)) {
          return { label: "Fix record", kind: "paper", disabled: busy !== null };
        }
        return null;
      case "lock":
        if (isPayer && fold?.state === "accepted" && paper && paperMatches(paper)) {
          return { label: "Post lock", kind: "lock", disabled: busy !== null };
        }
        return null;
      case "work":
        if (isPayee && fold?.state === "locked") {
          return { label: "Write deliverable", kind: "work", disabled: false };
        }
        return null;
      case "reveal":
        if (isPayee && fold?.state === "locked") {
          return { label: "Reveal & claim", kind: "reveal", disabled: busy !== null || !deal?.preimage };
        }
        return null;
      case "receipt":
        if ((fold?.state === "claimed" || fold?.state === "refunded" || fold?.state === "cancelled") && !fold?.receipt) {
          return { label: "Publish receipt", kind: "receipt", disabled: busy !== null };
        }
        return null;
      case "accept":
        if (isPayer && !accept) {
          return { label: "Re-check", kind: "recheck", disabled: false };
        }
        return null;
      default:
        return null;
    }
  };

  const runStepAction = (act: { kind: StepActionKind }) => {
    switch (act.kind) {
      case "paper":
        void writePaperRecord();
        break;
      case "lock":
        void postLock();
        break;
      case "work":
        document.getElementById("deal-work")?.scrollIntoView({ behavior: "smooth", block: "center" });
        break;
      case "reveal":
        void reveal();
        break;
      case "receipt":
        void postReceipt();
        break;
      case "recheck":
        loadPair();
        void readBoard();
        break;
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <p className="caption-sm text-mute">Deal · tclk/1</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="display-lg">{shortContract(contract)}</h1>
        <StatusChip
          tone={
            fold?.state === "claimed"
              ? "ok"
              : fold?.state === "refunded" || fold?.state === "cancelled"
                ? "warn"
                : pairState.status === "notfound"
                  ? "warn"
                  : "empty"
          }
        >
          {pairState.status === "notfound" ? "not found on board" : fold?.state ?? "reading"}
        </StatusChip>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <CopyButton value={contract} label="Copy contract id" />
        <Link
          href={`/deal/receipt/${encodeURIComponent(contract)}`}
          className="body-sm rounded-full border border-hairline bg-canvas px-4 py-2 text-ink transition-colors hover:border-brand-500/40 hover:bg-tint-brand hover:text-brand-700"
        >
          Public receipt →
        </Link>
        <Button
          variant="secondary"
          onClick={() => {
            loadPair();
            void readBoard();
          }}
          className="shrink-0"
        >
          {board.loaded ? "Refresh" : <Spinner label="Reading…" />}
        </Button>
      </div>

      {!validContract ? (
        <div className="mt-6">
          <Note tone="error">
            This is not a valid tclk contract id (it must be 0x followed by 64 hex digits). The link is
            incomplete or mistyped — open the deal from <span className="font-mono">Your deals</span> on{" "}
            <Link className="font-medium text-ink underline underline-offset-2" href="/deal">/deal</Link>.
          </Note>
        </div>
      ) : null}

      {!did ? (
        <div className="mt-6">
          <UnlockIdentity />
          <Note tone="warn">
            You are viewing this deal read-only.{" "}
            <Link className="font-medium text-ink underline underline-offset-2" href="/create">Create or unlock an identity</Link>{" "}
            to act on it.
          </Note>
        </div>
      ) : null}

      {did && offer && !isPayer && !isPayee ? (
        <div className="mt-6">
          <Note tone="warn">
            <strong className="font-medium text-ink">This is not your deal.</strong>{" "}
            You are signed in as <span className="font-mono">{identityShortName(did)}</span>
            {accept ? (
              <>
                , but this deal&apos;s parties are <span className="font-mono">payer {identityShortName(offer.from)}</span>{" "}
                and <span className="font-mono">payee {identityShortName(accept.from)}</span> — these are{" "}
                <em>different identities</em>. The one that posted or accepted this deal is not unlocked right now.
              </>
            ) : (
              <> — the accept is still incoming, and the payer is <span className="font-mono">{identityShortName(offer.from)}</span>.</>
            )}{" "}
            To act on it, unlock the matching identity: open{" "}
            <Link className="font-medium text-ink underline underline-offset-2" href="/create">/create</Link> and unlock the
            stored copy (or import the file), then come back here. If you expected to be signed in as{" "}
            <span className="font-mono">{accept ? identityShortName(accept.from) : ""}</span>, this browser is holding a
            different saved identity — the last one created or unlocked here is what auto-unlocks.
          </Note>
          <NextSteps />
        </div>
      ) : null}

      {board.localFallback ? (
        <div className="mt-4">
          <Note tone="warn">
            Showing the offer and accept from <strong className="font-medium text-ink">your local copy</strong> — the public
            pair was not found in the retained ring of tclk-offers (the venue keeps only the newest ~10 MiB). The deal
            room and paper rail below are still read live from the board.
          </Note>
        </div>
      ) : null}

      {board.error ? <div className="mt-4"><Note tone="error">{board.error}</Note></div> : null}
      {actionMsg ? (
        <div className="mt-4"><Note tone={actionMsg.ok ? "ok" : "error"}>{actionMsg.text}</Note></div>
      ) : null}

      {/* Timeline */}
      <section className="mt-8">
        <h2 className="heading-lg">Timeline</h2>
        <div className="mt-4 rounded-[16px] border border-hairline bg-surface-card p-4 sm:p-5">
          <ol className="space-y-3">
            {fold?.steps.map((s) => {
              const act = actionForStep(s.step);
              return (
                <li key={s.step} className="flex items-start gap-3">
                  <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                    s.done ? "bg-leaf-600 text-white" : s.blocked ? "bg-tint-amber text-amber-600 border border-amber-600/30" : "bg-surface-soft text-mute"
                  }`}>
                    {s.done ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    ) : s.blocked ? "!" : String(fold?.steps.indexOf(s) + 1)}
                  </span>
                  <div className="min-w-0">
                    <p className="body-sm-strong text-ink">
                      {s.label}
                      {s.at ? <span className="caption-sm ml-2 font-normal text-mute">{s.at}</span> : null}
                    </p>
                    {s.reason ? <p className="caption-sm mt-0.5 text-body">{s.reason}</p> : null}
                  </div>
                  {act ? (
                    <button
                      type="button"
                      onClick={() => runStepAction(act)}
                      disabled={act.disabled}
                      className={`ml-auto shrink-0 self-center rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors ${
                        act.disabled
                          ? "cursor-not-allowed bg-surface-soft text-mute"
                          : "bg-tint-brand text-brand-700 hover:bg-brand-500/20"
                      }`}
                    >
                      {act.label}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      {/* Next action */}
      {did && offer && (isPayer || isPayee) ? (
        <section className="mt-6">
          <Card className={guard.blocked ? "border-amber-600/30" : "border-brand-500/30"}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="body-sm-strong text-ink">Next: {guard.action}</p>
                <p className="caption-sm mt-1 text-body">{guard.reason}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {fold?.state === "accepted" && isPayer && !paper ? (
                  <Button onClick={() => void writePaperRecord()} disabled={busy !== null}>
                    {busy === "paper" ? <Spinner label="…" /> : "Write paper rail record"}
                  </Button>
                ) : null}
                {fold?.state === "accepted" && isPayer && paper ? (
                  <Button onClick={() => void postLock()} disabled={busy !== null}>
                    {busy === "lock" ? <Spinner label="…" /> : "Post lock"}
                  </Button>
                ) : null}
                {fold?.state === "accepted" && isPayer && paper && !paperMatches(paper) ? (
                  <Button variant="secondary" onClick={() => void writePaperRecord(true)} disabled={busy !== null}>
                    {busy === "paper" ? <Spinner label="…" /> : "Overwrite rail record"}
                  </Button>
                ) : null}
                {fold?.state === "locked" && isPayee ? (
                  <>
                    <Button variant="secondary" onClick={() => void postWork()} disabled={busy !== null || !workText.trim()}>
                      {busy === "work" ? <Spinner label="…" /> : "Post my work"}
                    </Button>
                    <Button onClick={() => void reveal()} disabled={busy !== null || !deal?.preimage}>
                      {busy === "reveal" ? <Spinner label="…" /> : "Reveal & claim"}
                    </Button>
                  </>
                ) : null}
                {fold?.state === "locked" && isPayer && refundDue ? (
                  <Button variant="secondary" onClick={() => void postRefund()} disabled={busy !== null}>
                    {busy === "refund" ? <Spinner label="…" /> : "Refund"}
                  </Button>
                ) : null}
                {(fold?.state === "claimed" || fold?.state === "refunded" || fold?.state === "cancelled") && !fold?.receipt ? (
                  <Button onClick={() => void postReceipt()} disabled={busy !== null}>
                    {busy === "receipt" ? <Spinner label="…" /> : "Publish receipt"}
                  </Button>
                ) : null}
                {(fold?.state === "proposed" || fold?.state === "accepted") && !fold?.cancel ? (
                  <Button variant="secondary" onClick={() => void postCancel()} disabled={busy !== null}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </div>
          </Card>
          {fold?.state === "locked" && isPayee && !deal?.preimage ? (
            <Note tone="warn" className="mt-3">
              This browser does not hold the secret — it was minted in the browser that accepted this deal and the
              secret never left it. You cannot reveal from here. The payer can refund after the refund window, or you
              can re-accept a fresh offer for a new secret.
            </Note>
          ) : null}
        </section>
      ) : null}

      {fold?.state === "locked" && isPayee ? (
        <section className="mt-4" id="deal-work">
          <FieldLike label="The work — what you are delivering" hint="Posted as a signed message in the deal room. Your own words.">
            <TextArea rows={3} value={workText} onChange={(e) => setWorkText(e.target.value)} placeholder="e.g. Here is the walkthrough: /kv/… — text below. (The reveal opens the lock.)" />
          </FieldLike>
        </section>
      ) : null}

      {/* Parties + contract facts */}
      <section className="mt-8 grid gap-3 lg:grid-cols-2">
        <Card>
          <h2 className="heading-md">Parties</h2>
          <div className="mt-3 space-y-2">
            <PartyRow label="Payer" did={offer?.from} tone="brand" />
            <PartyRow label="Payee" did={accept?.from} tone="leaf" />
          </div>
        </Card>
        <Card>
          <h2 className="heading-md">Contract</h2>
          <dl className="mt-3 space-y-1.5 text-[13px]">
            <div className="flex gap-2"><dt className="w-24 shrink-0 text-mute">offer id</dt><dd className="break-all font-mono text-ink">{offer?.id ?? "—"}</dd></div>
            <div className="flex gap-2"><dt className="w-24 shrink-0 text-mute">amount</dt><dd className="font-mono text-ink">{offer ? `${offer.amount} ${offer.asset}` : "—"}</dd></div>
            <div className="flex gap-2"><dt className="w-24 shrink-0 text-mute">rail</dt><dd className="font-mono text-ink">{offer?.rails.join(", ") ?? "—"}</dd></div>
            <div className="flex gap-2"><dt className="w-24 shrink-0 text-mute">claim by</dt><dd className="text-ink">{offer ? fmtMs(offer.claimByMs) : "—"}</dd></div>
            <div className="flex gap-2"><dt className="w-24 shrink-0 text-mute">refund after</dt><dd className="text-ink">{offer ? fmtMs(offer.refundAfterMs) : "—"}</dd></div>
            <div className="flex gap-2"><dt className="w-24 shrink-0 text-mute">expires</dt><dd className="text-ink">{offer ? fmtMs(offer.expiresMs) : "—"}</dd></div>
          </dl>
        </Card>
      </section>

      {/* Rooms + board frames */}
      <section className="mt-8">
        <h2 className="heading-lg">Where this lives</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <RoomChip label="tclk-offers" href="https://technocore.chat/r/tclk-offers" />
          {dealRoomName ? <RoomChip label={dealRoomName} href={`https://technocore.chat/r/${dealRoomName}`} /> : null}
          <RoomChip label="paper note" href="https://technocore.chat" />
        </div>
        <h3 className="heading-md mt-6">Frames on the board</h3>
        {board.records.length === 0 && !board.loaded ? (
          <p className="caption-sm mt-2 text-mute">Reading the board…</p>
        ) : board.records.length === 0 ? (
          <p className="caption-sm mt-2 text-mute">Nothing found in tclk-offers or the deal room yet.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {board.records.map((r, i) => {
              const f = decodeFrame(r.text);
              return (
                <div key={i} className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-hairline bg-surface-card px-4 py-2.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] ${f ? "bg-tint-brand text-brand-700" : "bg-surface-soft text-body"}`}>
                      {f ? f.type : "message"}
                    </span>
                    {f && "from" in f ? <code className="font-mono text-[12px] text-body">identity_{r.from.slice(-4)}</code> : null}
                    <span className="caption-sm text-mute">seq {r.seq} · {fmtTs(r.ts)}</span>
                  </div>
                  <span className="min-w-0 truncate text-[12px] text-body">{r.text.slice(0, 80)}</span>
                </div>
              );
            })}
          </div>
        )}
        {paper ? (
          <div className="mt-3">
            <StatusChip tone={paper.status === "claimed" ? "ok" : paper.status === "locked" ? "warn" : "empty"}>
              paper rail: {paper.status}
            </StatusChip>
          </div>
        ) : null}
      </section>

      <Note tone="info" className="mt-8">
        <strong className="font-medium text-brand-700">Why steps are blocked:</strong> the lock must name the{" "}
        <span className="font-mono">full</span> contract id (never a shortened label), the paper record must already
        exist at <span className="font-mono">kv/tclk-paper-&lt;hh&gt;/&lt;14 hex&gt;</span> and match the signed
        statement and refund deadline — the record is written <em>first</em>, then the lock. Nothing posts by itself;
        every write above is one deliberate click.
      </Note>
    </div>
  );
}

function PartyRow({ label, did, tone }: { label: string; did?: string; tone: "brand" | "leaf" }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-flex h-8 w-8 items-center justify-center rounded-[10px] text-[11px] font-semibold ${tone === "brand" ? "bg-tint-brand text-brand-600" : "bg-tint-leaf text-leaf-600"}`}>
        {label.slice(0, 2)}
      </span>
      <div className="min-w-0">
        <p className="caption-sm text-body">{label}</p>
        {did ? <code className="font-mono text-[12px] text-ink">{did.slice(0, 20)}…{did.slice(-8)}</code> : <p className="caption-sm text-mute">—</p>}
      </div>
    </div>
  );
}

function RoomChip({ label, href }: { label: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="body-sm rounded-full border border-hairline bg-canvas px-4 py-2 font-mono text-[13px] text-ink transition-colors hover:border-brand-500/40 hover:bg-tint-brand hover:text-brand-700"
    >
      {label}
    </a>
  );
}

function FieldLike({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="body-sm-strong text-ink">{label}</p>
      <div className="mt-2">{children}</div>
      <p className="caption-sm mt-1.5 text-body">{hint}</p>
    </div>
  );
}

function fmtMs(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toLocaleString();
}

function nowMs(): number {
  return Date.now();
}

function NextSteps() {
  const steps = [
    { who: "Payer", text: "Write the paper rail record (one click).", tone: "bg-tint-brand text-brand-600" },
    { who: "Payer", text: "Post the lock to the deal room.", tone: "bg-tint-brand text-brand-600" },
    { who: "Payee", text: "Submits the work — a signed message in the deal room.", tone: "bg-tint-sky text-acc-sky" },
    { who: "Payee", text: "Reveals the secret — that claims the deal.", tone: "bg-tint-sky text-acc-sky" },
    { who: "Either", text: "Publishes the receipt. Done.", tone: "bg-tint-leaf text-leaf-600" },
  ];
  return (
    <div className="mt-4 rounded-[16px] border border-hairline bg-surface-card p-4 sm:p-5">
      <p className="heading-sm text-ink">What happens next</p>
      <ol className="mt-3 space-y-2.5">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-semibold ${s.tone}`}>
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="body-sm-strong text-ink">{s.who}</p>
              <p className="caption-sm text-body">{s.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="caption-sm mt-3 text-body">
        The paper rail is a rehearsal — it records the deal, it moves no money.
      </p>
    </div>
  );
}

function fmtTs(ts: string): string {
  if (!ts) return "time unknown";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}
