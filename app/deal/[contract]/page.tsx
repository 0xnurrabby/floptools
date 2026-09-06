"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button, Card, CopyButton, Note, Spinner, StatusChip, TextArea } from "@/components/ui";
import { UnlockIdentity } from "@/components/unlock";
import { useSession } from "@/components/use-session";
import { signDraft } from "@/lib/keyring";
import { getClient } from "@/lib/client";
import {
  OFFERS_ROOM,
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
  type FoldResult,
  type PaperRecord,
  type RecordInput,
} from "@/lib/tclk-deal";
import { findDeal, patchDeal, rememberPosted, type DealRecord } from "@/lib/deal-store";

interface Board {
  records: RecordInput[];
  paper: PaperRecord | null;
  paperRaw: string | null;
  loaded: boolean;
  error: string | null;
  at: number;
}

export default function DealDetailPage() {
  const params = useParams<{ contract: string }>();
  const contract = decodeURIComponent(params.contract);
  const { did } = useSession();
  const [board, setBoard] = useState<Board>({ records: [], paper: null, paperRaw: null, loaded: false, error: null, at: 0 });
  const [fold, setFold] = useState<FoldResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [workText, setWorkText] = useState("");
  const [deal] = useState<DealRecord | null>(() => findDeal(contract));

  const dealRoomName = dealRoom(contract);
  const offer = fold?.offer ?? null;
  const accept = fold?.accept ?? null;
  const paper = board.paper;
  const isPayer = did !== null && offer !== null && did === offer.from;
  const isPayee = did !== null && accept !== null && did === accept.from;

  const refresh = useCallback(() => {
    if (!dealRoomName) return;
    const client = getClient();
    const job = Promise.all([
      client.readRoom(OFFERS_ROOM, { limit: 200 }).catch(() => null),
      client.readRoom(dealRoomName, { limit: 200 }).catch(() => null),
      (async () => {
        try {
          const { ns, key } = paperNote(contract);
          const note = await client.readNote(ns, key);
          return note.found ? note.value : null;
        } catch {
          return null;
        }
      })(),
    ]);
    void job.then(([offersRoom, dealRoomRead, paperRaw]) => {
      const records: RecordInput[] = [];
      for (const m of offersRoom?.messages ?? []) {
        records.push({ room: OFFERS_ROOM, from: m.from, text: m.text, seq: m.seq, ts: m.ts, sig: m.sig });
      }
      for (const m of dealRoomRead?.messages ?? []) {
        records.push({ room: dealRoomName, from: m.from, text: m.text, seq: m.seq, ts: m.ts, sig: m.sig });
      }
      setBoard({
        records,
        paper: paperRaw ? decodePaperRecord(paperRaw) : null,
        paperRaw,
        loaded: true,
        error: null,
        at: nowMs(),
      });
    });
  }, [contract, dealRoomName]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void foldContract(board.records, board.paper).then((f) => {
      if (!cancelled) setFold(f);
    });
    return () => {
      cancelled = true;
    };
  }, [board, did]);

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

  const writePaperRecord = async () => {
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
      const res = await getClient().setNote(ns, key, value, { ifAbsent: true });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`The rail record was refused (HTTP ${res.status}). ${res.body.slice(0, 200)}`);
      }
      rememberPosted({ kind: "paper", contract, at: nowMs(), detail: `tclk-paper-${ns.slice(-2)}/${key}` });
      setActionMsg({ ok: true, text: `Paper rail record written to kv/${ns}/${key}. Now post the lock — it names the full contract id.` });
      refresh();
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
      refresh();
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
      refresh();
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
      refresh();
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
      refresh();
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
      refresh();
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
      refresh();
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

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <p className="caption-sm text-mute">Deal · tclk/1</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="display-lg">{shortContract(contract)}</h1>
        <StatusChip tone={fold?.state === "claimed" ? "ok" : fold?.state === "refunded" || fold?.state === "cancelled" ? "warn" : "empty"}>
          {fold?.state ?? "reading"}
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
        <Button variant="secondary" onClick={refresh} className="shrink-0">
          {board.loaded ? "Refresh" : <Spinner label="Reading…" />}
        </Button>
      </div>

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

      {board.error ? <div className="mt-4"><Note tone="error">{board.error}</Note></div> : null}
      {actionMsg ? (
        <div className="mt-4"><Note tone={actionMsg.ok ? "ok" : "error"}>{actionMsg.text}</Note></div>
      ) : null}

      {/* Timeline */}
      <section className="mt-8">
        <h2 className="heading-lg">Timeline</h2>
        <div className="mt-4 rounded-[16px] border border-hairline bg-surface-card p-4 sm:p-5">
          <ol className="space-y-3">
            {fold?.steps.map((s) => (
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
              </li>
            ))}
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
        </section>
      ) : null}

      {fold?.state === "locked" && isPayee ? (
        <section className="mt-4">
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

function fmtTs(ts: string): string {
  if (!ts) return "time unknown";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}
