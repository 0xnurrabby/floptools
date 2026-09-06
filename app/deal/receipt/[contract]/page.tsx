"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Note, Spinner, StatusChip } from "@/components/ui";
import { getClient } from "@/lib/client";
import {
  contractId,
  dealRoom,
  foldContract,
  paperNote,
  decodePaperRecord,
  shortContract,
  verifySecret,
  type AcceptFrame,
  type FoldResult,
  type OfferFrame,
  type PaperRecord,
  type RecordInput,
} from "@/lib/tclk-deal";

interface ReceiptView {
  records: RecordInput[];
  paper: PaperRecord | null;
  loaded: boolean;
  error: string | null;
  pairFound: boolean;
  pairChecked: boolean;
}

export default function DealReceiptPage() {
  const params = useParams<{ contract: string }>();
  const contract = decodeURIComponent(params.contract);
  const [view, setView] = useState<ReceiptView>({ records: [], paper: null, loaded: false, error: null, pairFound: false, pairChecked: false });
  const [fold, setFold] = useState<FoldResult | null>(null);

  const refresh = useCallback(() => {
    const room = dealRoom(contract);
    const roomName = room ?? "";
    const client = getClient();
    const job = Promise.all([
      (async () => {
        try {
          const res = await fetch(`/api/tc/deal-lookup?contract=${encodeURIComponent(contract)}`);
          const data = (await res.json()) as { found?: boolean; error?: string; offer?: OfferFrame; offerRecord?: RecordInput; accept?: AcceptFrame; acceptRecord?: RecordInput };
          return res.ok ? data : { error: data.error ?? `lookup failed (HTTP ${res.status})` };
        } catch (e) {
          return { error: (e as Error).message };
        }
      })(),
      room ? client.readRoom(room, { limit: 200 }).catch(() => null) : Promise.resolve(null),
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
    void job.then(async ([lookup, dealRoomRead, paperRaw]) => {
      const records: RecordInput[] = [];
      let pairFound = false;
      let error: string | null = null;
      if (lookup.error) {
        error = `Could not read the board: ${lookup.error}`;
      } else if (lookup.found && lookup.offer && lookup.offerRecord && lookup.accept && lookup.acceptRecord) {
        records.push(lookup.offerRecord, lookup.acceptRecord);
        pairFound = true;
      }
      for (const m of dealRoomRead?.messages ?? []) {
        records.push({ room: roomName, from: m.from, text: m.text, seq: m.seq, ts: m.ts, sig: m.sig });
      }
      const paper = paperRaw ? decodePaperRecord(paperRaw) : null;
      const f = await foldContract(records, paper, { contract });
      setFold(f);
      setView({ records, paper, loaded: true, error, pairFound, pairChecked: true });
    });
  }, [contract]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const offer = fold?.offer ?? null;
  const accept = fold?.accept ?? null;

  const [idCheck, setIdCheck] = useState<null | { ok: boolean; detail: string }>(null);
  useEffect(() => {
    if (!offer || !accept) return;
    let cancelled = false;
    void contractId(offer, {
      from: accept.from,
      ref: accept.ref,
      statement: accept.statement,
      paymentKey: accept.paymentKey,
      nonce: accept.nonce,
    }).then((computed) => {
      if (cancelled) return;
      setIdCheck({
        ok: computed === contract,
        detail: computed === contract ? "recomputed from the public offer + accept" : `recomputed ${shortContract(computed)} — does not match`,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [offer, accept, contract]);

  const [secretCheck, setSecretCheck] = useState<null | { ok: boolean; detail: string }>(null);
  useEffect(() => {
    if (!offer || !accept || !fold?.reveal || !fold?.reveal.secret) return;
    let cancelled = false;
    void verifySecret(offer.lock, accept.statement, fold.reveal.secret).then((ok) => {
      if (cancelled) return;
      setSecretCheck({
        ok,
        detail: ok ? "sha256(preimage) opens the statement" : "the secret does not open the statement",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [offer, accept, fold?.reveal]);

  const idOk = idCheck?.ok ?? null;
  const idDetail = idCheck?.detail ?? "recomputing…";

  const verified =
    idOk === true && fold?.state === "claimed" && fold?.reveal !== null && fold?.receipt?.outcome === "claimed";

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <p className="caption-sm text-mute">Public receipt · tclk/1 paper deal</p>
      <h1 className="display-lg mt-2">Deal receipt</h1>
      <p className="body-md mt-3 max-w-xl text-body">
        Anyone can open this page and verify the deal by folding the public room frames and
        checking the rail. It is proof of a completed <span className="font-medium text-ink">paper</span> deal —
        not a claim of tokens or airdrop eligibility.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <StatusChip tone={verified ? "ok" : "warn"}>
          {verified ? "verified paper deal" : "incomplete or unverified"}
        </StatusChip>
        <StatusChip tone={fold?.state === "claimed" ? "ok" : "empty"}>{fold?.state}</StatusChip>
        <code className="font-mono text-[12px] text-body">{shortContract(contract)}</code>
        <button type="button" onClick={refresh} className="caption-sm rounded-full border border-hairline bg-canvas px-3 py-1 text-ink hover:bg-surface-soft">
          Refresh
        </button>
      </div>

      {view.error ? <div className="mt-4"><Note tone="error">{view.error}</Note></div> : null}
      {!view.loaded ? (
        <div className="mt-8"><Spinner label="Folding the public board…" /></div>
      ) : (
        <div className="mt-8 space-y-6">
          {/* checks */}
          <section>
            <h2 className="heading-lg">Checks</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <CheckRow label="Contract id" ok={idOk} hint={idDetail} />
              <CheckRow
                label="Offer + accept on the board"
                ok={view.pairChecked ? offer !== null && accept !== null : null}
                hint={
                  offer && accept
                    ? "both public in tclk-offers, matched by this contract id"
                    : view.pairChecked
                      ? "not found in the retained ring of tclk-offers (only the newest ~10 MiB is kept)"
                      : "checking…"
                }
              />
              <CheckRow label="Lock on the deal room" ok={!!fold?.lock} hint={fold?.lock ? `rail ${fold?.lock.rail} · ref ${fold?.lock.ref.slice(0, 14)}…` : "missing"} />
              <CheckRow label="Reveal + secret opens statement" ok={secretCheck?.ok ?? false} hint={secretCheck?.detail ?? "no reveal frame yet"} />
              <CheckRow label="Paper rail record agrees" ok={view.paper !== null} hint={view.paper ? `status ${view.paper.status}` : "no record"} />
              <CheckRow label="Receipt matches terminal state" ok={!!fold?.receipt} hint={fold?.receipt ? `outcome ${fold?.receipt.outcome}` : "missing"} />
            </div>
            {!verified ? (
              <Note tone="warn" className="mt-4">
                This receipt is not a completed paper deal yet. The checks above say exactly what is missing.
                A receipt proves the transcript — it never proves value moved (on the paper rail, none can).
              </Note>
            ) : (
              <Note tone="ok" className="mt-4">
                Verified: the public offer, accept, lock, reveal and receipt fold to <span className="font-mono">claimed</span>,
                the contract id recomputes from the public frames, and the rail record says claimed. This is a
                completed paper deal — a rehearsal, not a payment.
              </Note>
            )}
          </section>

          {/* timeline */}
          <section>
            <h2 className="heading-lg">Folded timeline</h2>
            <div className="mt-3 space-y-2">
              {fold?.steps.map((s) => (
                <div key={s.step} className="flex items-start gap-3 rounded-[12px] border border-hairline bg-surface-card px-4 py-2.5">
                  <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${s.done ? "bg-leaf-600 text-white" : "bg-surface-soft text-mute"}`}>
                    {s.done ? "✓" : "·"}
                  </span>
                  <div className="min-w-0">
                    <p className="body-sm-strong text-ink">{s.label}{s.at ? <span className="caption-sm ml-2 font-normal text-mute">{s.at}</span> : null}</p>
                    {s.reason ? <p className="caption-sm mt-0.5 text-body">{s.reason}</p> : null}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* parties */}
          <section>
            <h2 className="heading-lg">Parties</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {offer ? <DidChip label="payer" did={offer.from} /> : null}
              {accept ? <DidChip label="payee" did={accept.from} /> : null}
            </div>
          </section>

          {/* job */}
          {offer?.job?.context ? (
            <section>
              <h2 className="heading-lg">The job</h2>
              <p className="body-sm mt-2 text-body">“{offer.job.context}”</p>
            </section>
          ) : null}
        </div>
      )}

      <Note tone="info" className="mt-10">
        <strong className="font-medium text-brand-700">Honest words:</strong> Deal is an unofficial community tool
        for the tclk/1 paper rail. The rail moves no money, the faucet is closed, $FLOP is not live, and Flop Labs
        (flop.finance, @flop_labs) is the only official source. A receipt is a reading of a public transcript, never
        a claim of value or eligibility.
      </Note>
    </div>
  );
}

function CheckRow({ label, ok, hint }: { label: string; ok: boolean | null; hint: string }) {
  return (
    <div className={`flex items-start gap-3 rounded-[16px] border p-4 ${ok === true ? "border-leaf-600/25 bg-tint-leaf" : ok === false ? "border-rose-600/25 bg-tint-rose" : "border-hairline bg-surface-card"}`}>
      <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] ${ok === true ? "bg-leaf-600 text-white" : ok === false ? "bg-rose-600 text-white" : "bg-surface-soft text-mute"}`}>
        {ok === null ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M12 6v6l3 2" /><circle cx="12" cy="12" r="9" />
          </svg>
        ) : ok ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        )}
      </span>
      <div className="min-w-0">
        <p className="body-sm-strong text-ink">{label}</p>
        <p className="caption-sm mt-0.5 break-all text-body">{hint}</p>
      </div>
    </div>
  );
}

function DidChip({ label, did }: { label: string; did: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-hairline bg-surface-card px-4 py-2">
      <span className="caption-sm text-body">{label}</span>
      <code className="font-mono text-[12px] text-ink">{did.slice(0, 20)}…{did.slice(-8)}</code>
    </span>
  );
}
