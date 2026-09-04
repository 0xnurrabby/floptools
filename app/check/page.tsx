"use client";

import { useState, useSyncExternalStore } from "react";
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
import { getClient, TECHNOBASE } from "@/lib/client";
import { checkDid, verifyRecord, type DidCheckResult, type RecordVerification } from "@/lib/check";
import { isValidDid } from "@/lib/didkey";
import { TechnocoreError } from "@/lib/technocore";
import {
  subscribeReceipts,
  getReceiptsSnapshot,
  EMPTY_RECEIPTS,
} from "@/lib/receipts";

export default function CheckPage() {
  const [did, setDid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DidCheckResult | null>(null);

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

  const run = async () => {
    setError(null);
    setResult(null);
    const candidate = did.trim();
    if (!isValidDid(candidate)) {
      setError("Not a valid did:key (did:key:z6Mk…).");
      return;
    }
    const local = receipts
      .filter((r) => r.did === candidate)
      .map((r) => ({ room: r.room, seq: r.seq, nonce: r.nonce, text: r.text, ts: r.ts }));
    setBusy(true);
    try {
      const res = await checkDid(getClient(), candidate, { local });
      setResult(res);
    } catch (e) {
      const msg = e instanceof TechnocoreError ? e.body.slice(0, 300) : (e as Error).message;
      setError(`Could not complete the check: ${msg}`);
    } finally {
      setBusy(false);
    }
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
      <h1 className="display-lg mt-2">Check any did:key</h1>
      <p className="body-md mt-3 max-w-xl text-body">
        Paste a <code className="rounded-sm bg-surface-soft px-1.5 py-0.5 font-mono text-[13px]">did:key:z6Mk…</code> — all
        reads are public.
      </p>

      <div className="mt-8 max-w-2xl">
        <div className="flex flex-col gap-2 sm:flex-row">
          <TextInput
            value={did}
            onChange={(e) => setDid(e.target.value)}
            placeholder="did:key:z6Mk…"
            mono
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
          />
          <Button onClick={run} disabled={busy || !did.trim()} className="shrink-0">
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
                    ? `${result.signedMessageCount} observed in public rooms`
                    : result.localCount > 0
                      ? `${result.localCount} recorded locally (public ring rolled past them)`
                      : "nothing recorded"
                }
              />
            </div>
            {!result.noteFound ? (
              <p className="caption-sm mt-3 text-body">
                <strong className="font-medium text-ink">Durable step missing:</strong> publish your DID note from{" "}
                <span className="font-mono">/activity</span> — notes survive room rotation, messages do not.
              </p>
            ) : null}
          </Card>

          {result.localCount > 0 ? (
            <div>
              <h2 className="heading-md">Local evidence (this browser)</h2>
              <p className="caption-sm mt-1 text-body">
                Signed publishes recorded here — the server accepted each one (status 200, seq assigned).
              </p>
              <div className="mt-3 space-y-3">
                {result.localActivity.map((a) => (
                  <div
                    key={a.room}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-hairline bg-surface-card px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <code className="font-mono text-[13px] text-ink">/{a.room}</code>
                      <StatusChip tone="ok">{a.count} recorded</StatusChip>
                    </div>
                    <span className="caption-sm text-body">latest seq {a.latestSeq}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <h2 className="heading-md">Signed activity by room</h2>
            <div className="mt-3 space-y-3">
              {result.activity.length === 0 ? (
                <p className="caption-sm text-mute">No rooms scanned.</p>
              ) : (
                result.activity.map((a) => (
                  <div
                    key={a.room}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-hairline bg-surface-card px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <code className="font-mono text-[13px] text-ink">/{a.room}</code>
                      <StatusChip tone={a.signedMessages > 0 ? "ok" : "empty"}>
                        {a.signedMessages === 0 ? "none" : `${a.signedMessages} signed`}
                      </StatusChip>
                    </div>
                    {a.latestSeq > 0 ? (
                      <span className="caption-sm text-body">seq {a.latestSeq}</span>
                    ) : (
                      <span className="caption-sm text-mute">—</span>
                    )}
                  </div>
                ))
              )}
            </div>
            {result.signedMessageCount === 0 ? (
              <p className="caption-sm mt-3 text-body">
                {result.localCount > 0
                  ? "The public ring rolled past your records — this room turns over in seconds, and reads only see the newest ~200 messages. That is why the local evidence above matters: the server accepted each publish (200 + seq)."
                  : "No signed message from this key is currently in the readable tail. If you signed recently, use the receipt's seq below; otherwise the public room record has rolled past."}
              </p>
            ) : null}
          </div>

          <div>
            <h2 className="heading-md">Verify with curl</h2>
            <TerminalCard title="independent check" className="mt-3">
              curl -s &apos;{TECHNOBASE}/kv/{result.notePath}&apos;
              {"\n"}
              curl -s &apos;{TECHNOBASE}/r/lobby?limit=200&format=json&apos;
            </TerminalCard>
            <div className="mt-3 flex gap-2">
              <CopyButton value={`curl -s '${TECHNOBASE}/kv/${result.notePath}'`} label="Copy note curl" />
              <CopyButton value={`curl -s '${TECHNOBASE}/r/lobby?limit=200&format=json'`} label="Copy room curl" />
            </div>
          </div>

          <Note tone="info">
            A note proves nothing on its own — trust it only because signed messages verify against the did inside.
            Signature = possession of a key, not honesty.
          </Note>
        </div>
      ) : null}

      {/* Record verifier */}
      <section className="mt-12">
        <h2 className="heading-lg">Verify one record</h2>
        <p className="caption-sm mt-1 text-body">Room + seq of any signed message — re-verify its signature right now.</p>
        <div className="mt-4 grid max-w-2xl gap-3 sm:grid-cols-[1fr_120px_auto]">
          <Field label="Room">
            <TextInput value={recRoom} onChange={(e) => setRecRoom(e.target.value)} placeholder="lobby" mono />
          </Field>
          <Field label="Seq">
            <TextInput value={recSeq} onChange={(e) => setRecSeq(e.target.value)} placeholder="21414442" mono />
          </Field>
          <div className="flex items-end">
            <Button onClick={verifyRecordNow} disabled={recBusy}>
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
    <div className="rounded-[12px] border border-hairline bg-surface-soft p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="body-sm-strong text-ink">{label}</span>
        <span className={`font-mono text-[13px] ${ok ? "text-ink" : "text-mute"}`}>{ok ? "yes" : "no"}</span>
      </div>
      <p className="caption-sm mt-1 break-all text-body">{hint}</p>
    </div>
  );
}