"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  Button,
  Card,
  CopyButton,
  Field,
  Note,
  Spinner,
  StatusChip,
  TerminalCard,
  TextInput,
} from "@/components/ui";
import { useSession } from "@/components/use-session";
import { UnlockIdentity } from "@/components/unlock";
import { getClient, TECHNOBASE } from "@/lib/client";
import {
  checkDid,
  mergeDeepScan,
  verifyRecord,
  type DeepScanRoom,
  type DidCheckResult,
  type RecordVerification,
} from "@/lib/check";

interface TcAgentResult {
  ok?: boolean;
  frames?: { type: string; ts: string; room: string; seq: number; amount: string | null; asset: string | null }[];
}
import { isValidDid } from "@/lib/didkey";
import { TechnocoreError } from "@/lib/technocore";
import {
  subscribeReceipts,
  getReceiptsSnapshot,
  EMPTY_RECEIPTS,
} from "@/lib/receipts";

export default function CheckPage() {
  const session = useSession();
  const [did, setDid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DidCheckResult | null>(null);
  const [tcResult, setTcResult] = useState<TcAgentResult | null>(null);
  const [autoRan, setAutoRan] = useState(false);

  const [recRoom, setRecRoom] = useState("");
  const [recSeq, setRecSeq] = useState("");
  const [recBusy, setRecBusy] = useState(false);
  const [recResult, setRecResult] = useState<RecordVerification | null>(null);
  const [recError, setRecError] = useState<string | null>(null);

  const receipts = useSyncExternalStore(
    subscribeReceipts,
    getReceiptsSnapshot,
    () => EMPTY_RECEIPTS,
  );

  // Default target: the signed-in identity; editable to any other DID.
  const target = (did.trim() || session.did || "").trim();

  const runFetch = useCallback(
    (candidate: string) => {
      return Promise.resolve()
        .then(async () => {
          setError(null);
          setResult(null);
          const local = receipts
            .filter((r) => r.did === candidate)
            .map((r) => ({ room: r.room, seq: r.seq, nonce: r.nonce, text: r.text, ts: r.ts }));
          const [res, tc, scan] = await Promise.all([
            checkDid(getClient(), candidate, { local }),
            fetch(`/api/trustcore/agent?did=${encodeURIComponent(candidate)}`, { cache: "no-store" })
              .then((r) => r.json())
              .catch(() => null),
            // Full retained-ring scan: the tail alone makes published activity
            // look missing once a busy room rolls past it.
            fetch(`/api/tc/room-scan?did=${encodeURIComponent(candidate)}`, { cache: "no-store" })
              .then((r) => r.json() as Promise<{ dids?: Record<string, Record<string, DeepScanRoom>> } | null>)
              .catch(() => null),
          ]);
          const deep = scan?.dids?.[candidate];
          setResult(mergeDeepScan(res, deep));
          setTcResult(tc);
          setAutoRan(true);
        })
        .catch(async (e) => {
          const msg = e instanceof TechnocoreError ? e.body.slice(0, 300) : (e as Error).message;
          setError(`Could not complete the check: ${msg}`);
        });
    },
    [receipts],
  );

  // Auto-check the signed-in identity once (no interaction needed).
  useEffect(() => {
    if (autoRan || !session.did || did) return;
    void runFetch(session.did);
  }, [autoRan, session.did, did, runFetch]);

  const run = () => {
    if (!target || !isValidDid(target)) {
      setError("Enter a valid did:key (did:key:z6Mk…).");
      return;
    }
    setBusy(true);
    void runFetch(target).finally(() => setBusy(false));
  };

  const verifyRecordNow = async () => {
    setRecError(null);
    setRecResult(null);
    const seq = Number(recSeq.trim());
    if (!recRoom.trim() || !Number.isInteger(seq) || seq < 1) {
      setRecError("Enter a room and a positive seq.");
      return;
    }
    setRecBusy(true);
    try {
      const res = await verifyRecord(
        getClient(),
        recRoom.trim(),
        seq,
        isValidDid(did.trim()) ? did.trim() : undefined,
      );
      setRecResult(res);
    } catch (e) {
      setRecError((e as Error).message);
    } finally {
      setRecBusy(false);
    }
  };

  const stateTone =
    result?.state === "SET_UP_CORRECTLY" ? "ok" : result?.state === "HALF_SET_UP" ? "warn" : "empty";

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <p className="caption-sm text-mute">Verification</p>
      <h1 className="display-lg mt-2">Check any <span className="text-grad">did:key</span></h1>
      <p className="body-md mt-3 max-w-xl text-body">
        Paste a <code className="rounded-sm bg-tint-brand px-1.5 py-0.5 font-mono text-[13px] text-brand-700">did:key:z6Mk…</code>.
        All reads are public.
      </p>

      <div className="mt-6">
        <UnlockIdentity />
      </div>

      <div className="mt-6 max-w-2xl">
        <div className="flex flex-col gap-2 sm:flex-row">
          <TextInput
            value={did}
            onChange={(e) => setDid(e.target.value)}
            placeholder={session.did ? "did:key:z6Mk… (your signed-in identity)" : "did:key:z6Mk…"}
            mono
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
          />
          <Button onClick={run} disabled={busy || !did.trim()} className="shrink-0 sm:w-auto">
            {busy ? <Spinner label="Checking…" /> : "Check"}
          </Button>
        </div>
      </div>

      {error ? <div className="mt-6"><Note tone="error">{error}</Note></div> : null}

      {result ? (
        <div className="mt-8 space-y-6">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="break-all font-mono text-[15px] text-ink">{result.did}</p>
              <StatusChip tone={stateTone}>{result.state.replace(/_/g, " ")}</StatusChip>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <CheckItem
                label="DID note on ledger"
                ok={result.checks.notePresent}
                hint={result.noteFound ? `/kv/${result.notePath}` : "none found"}
              />
              <CheckItem
                label="Key has signed"
                ok={result.checks.keyEverSigned}
                hint={
                  result.signedMessageCount > 0
                    ? `${result.signedMessageCount} signed message${result.signedMessageCount === 1 ? "" : "s"} retained on the public ledger`
                    : result.localCount > 0
                      ? `${result.localCount} accepted on the ledger (seq assigned, signature verifies)`
                      : "nothing found in the retained ring"
                }
              />
            </div>
            {!result.noteFound ? (
              <p className="caption-sm mt-3 text-body">
                <strong className="font-medium text-ink">Durable step missing:</strong> publish your DID note from{" "}
                <span className="font-mono">/activity</span>; notes survive room rotation, messages do not.
              </p>
            ) : null}
          </Card>

          {result.localCount > 0 ? (
            <div>
              <h2 className="heading-md">Ledger acceptances</h2>
              <p className="caption-sm mt-1 text-body">
                Accepted at publish time (status 200 + server seq). The signature still verifies — permanent even after busy rooms roll on.
              </p>
              <div className="mt-3 space-y-3">
                {result.localActivity.map((a) => (
                  <div
                    key={a.room}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-hairline bg-surface-card px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <code className="font-mono text-[13px] text-ink">/{a.room}</code>
                      <StatusChip tone="ok">{a.count} confirmed</StatusChip>
                    </div>
                    <span className="caption-sm text-body">latest accepted seq {a.latestSeq}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <h2 className="heading-md">Signed activity by room</h2>
            <p className="caption-sm mt-1 text-body">
              On ledger = found in the room&apos;s full retained ring (the whole export, not just the newest-200 tail that rolls within minutes). Confirmed = accepted at publish time from this browser.
            </p>
            <div className="mt-3 space-y-3">
              {result.activity.length === 0 ? (
                <p className="caption-sm text-mute">No rooms scanned.</p>
              ) : (
                result.activity.map((a) => {
                  const local = result.localActivity.find((l) => l.room === a.room);
                  const signedOnLedger = a.signedMessages > 0;
                  const accepted = (local?.count ?? 0) > 0;
                  const latest =
                    a.latestSeq > 0 ? a.latestSeq : (local?.latestSeq ?? 0);
                  return (
                    <div
                      key={a.room}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-hairline bg-surface-card px-4 py-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="font-mono text-[13px] text-ink">/{a.room}</code>
                        <StatusChip tone={signedOnLedger || accepted ? "ok" : "empty"}>
                          {signedOnLedger
                            ? `${a.signedMessages} on ledger`
                            : accepted
                              ? `${local?.count} accepted`
                              : "none"}
                        </StatusChip>
                        {accepted && signedOnLedger ? (
                          <span className="caption-sm text-mute">+{local?.count} accepted earlier</span>
                        ) : null}
                      </div>
                      {latest > 0 ? (
                        <span className="caption-sm text-body">latest seq {latest}</span>
                      ) : (
                        <span className="caption-sm text-mute">n/a</span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            <p className="caption-sm mt-3 text-body">
              {result.localCount > 0
                ? "Every message was accepted by the ledger at publish time (HTTP 200, server seq) and the signature still verifies. Scan is the full retained ring, so newer activity stays visible longer."
                : "No signed message from this key is in the public rooms' retained rings right now. If you signed recently, check the receipt's seq below."}
            </p>
          </div>

          <div>
            <h2 className="heading-md">Public record — what this DID did, when</h2>
            <p className="caption-sm mt-1 text-body">
              Real public events, timestamped. Newest first.
            </p>
            <div className="mt-3 space-y-2">
              {buildTimeline(result, tcResult).map((row, i) => (
                <div
                  key={i}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-hairline bg-surface-card px-4 py-2.5"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <StatusChip tone={row.kind === "signed-seen" ? "ok" : row.kind === "confirmed" ? "ok" : "warn"}>
                      {row.label}
                    </StatusChip>
                    <span className="caption-sm text-mute">{row.at ? fmtTs(row.at) : "time unknown"}</span>
                    {row.room ? <code className="font-mono text-[12px] text-body">/{row.room}</code> : null}
                    {row.seq ? <span className="font-mono text-[12px] text-mute">seq {row.seq}</span> : null}
                    {row.extra ? <span className="caption-sm text-body">{row.extra}</span> : null}
                  </div>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-body sm:ml-4">{row.text}</span>
                </div>
              ))}
              {buildTimeline(result, tcResult).length === 0 ? (
                <p className="caption-sm text-mute">No public items found for this DID yet (signed messages, deal frames or notes).</p>
              ) : null}
            </div>
          </div>

          <div>
            <h2 className="heading-md">Verify with curl</h2>
            <TerminalCard title="independent check" className="mt-3">
              curl -s &apos;{TECHNOBASE}/kv/{result.notePath}&apos;
              {"\n"}
              curl -s &apos;{TECHNOBASE}/r/lobby?limit=200&format=json&apos;
            </TerminalCard>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <CopyButton value={`curl -s '${TECHNOBASE}/kv/${result.notePath}'`} label="Copy note curl" className="w-full sm:w-auto" />
              <CopyButton value={`curl -s '${TECHNOBASE}/r/lobby?limit=200&format=json'`} label="Copy room curl" className="w-full sm:w-auto" />
            </div>
          </div>

          <Note tone="info">
            A note proves nothing on its own; trust it only because signed messages verify against the did inside.
            Signature = possession of a key, not honesty.
          </Note>
        </div>
      ) : null}

      {/* Record verifier */}
      <section className="mt-12">
        <h2 className="heading-lg">Verify one record</h2>
        <p className="caption-sm mt-1 text-body">Room + seq of any signed message: re-verify its signature right now.</p>
        <div className="mt-4 grid max-w-2xl gap-3 sm:grid-cols-[1fr_120px_auto]">
          <Field label="Room">
            <TextInput value={recRoom} onChange={(e) => setRecRoom(e.target.value)} placeholder="lobby" mono />
          </Field>
          <Field label="Seq">
            <TextInput value={recSeq} onChange={(e) => setRecSeq(e.target.value)} placeholder="21414442" mono />
          </Field>
          <div className="flex items-end">
            <Button onClick={verifyRecordNow} disabled={recBusy} className="w-full sm:w-auto">
              {recBusy ? <Spinner label="…" /> : "Verify"}
            </Button>
          </div>
        </div>
        {recError ? <div className="mt-4"><Note tone="error">{recError}</Note></div> : null}
        {recResult ? (
          <div className="mt-4 max-w-2xl rounded-[12px] border border-hairline bg-surface-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip
                tone={recResult.valid === true ? "ok" : recResult.found ? "warn" : "empty"}
              >
                {recResult.valid === true
                  ? "signature valid"
                  : recResult.found
                    ? "found"
                    : "not on ledger"}
              </StatusChip>
              <code className="font-mono text-[13px] text-ink">
                /{recResult.room} · {recResult.seq}
              </code>
              {recResult.valid === true ? (
                <StatusChip tone="ok">written by this did</StatusChip>
              ) : null}
            </div>
            {recResult.message?.text ? (
              <p className="mt-2 break-all font-mono text-[13px] text-body">{recResult.message.text}</p>
            ) : null}
            {recResult.error ? <p className="caption-sm mt-1.5 text-body">{recResult.error}</p> : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function CheckItem({ label, ok, hint }: { label: string; ok: boolean; hint: string }) {
  return (
    <div className={`flex gap-3 rounded-[16px] border p-4 ${ok ? "border-leaf-600/25 bg-tint-leaf" : "border-hairline bg-surface-card"}`}>
      <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] shadow-soft ${ok ? "bg-leaf-600 text-white" : "bg-surface-soft text-mute"}`}>
        {ok ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M8 8l8 8M16 8l-8 8" />
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

interface TimelineRow {
  kind: "signed-seen" | "confirmed" | "deal";
  label: string;
  at?: string;
  room?: string;
  seq?: number;
  extra?: string;
  text: string;
}

function buildTimeline(r: DidCheckResult, tc: TcAgentResult | null): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const a of r.activity) {
    for (const m of a.recent ?? []) {
      rows.push({
        kind: "signed-seen",
        label: "signed",
        at: m.ts,
        room: a.room,
        seq: m.seq,
        text: m.text,
      });
    }
  }
  for (const f of tc?.frames ?? []) {
    rows.push({
      kind: "deal",
      label: f.type,
      at: f.ts,
      room: f.room.replace("mb-p-tclk-", "deal:"),
      seq: f.seq,
      extra: f.amount ? `${f.amount} ${f.asset ?? ""}` : undefined,
      text: f.type,
    });
  }
  return rows
    .sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime())
    .slice(0, 40);
}

function fmtTs(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}