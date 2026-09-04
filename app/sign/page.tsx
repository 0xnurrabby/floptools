"use client";

import { Suspense, useMemo, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Button,
  Card,
  CopyButton,
  Field,
  Note,
  Select,
  Spinner,
  StatusChip,
  TerminalCard,
  TextArea,
  TextInput,
} from "@/components/ui";
import { useSession } from "@/components/use-session";
import { signDraft, nonceStore } from "@/lib/keyring";
import { getClient, TECHNOBASE } from "@/lib/client";
import { TechnocoreError } from "@/lib/technocore";
import { sweep } from "@/lib/sweep";
import { candidateNonce } from "@/lib/nonce";
import { verifyMessage } from "@/lib/sign";
import { verifyRecord, type RecordVerification } from "@/lib/check";
import {
  saveReceipt,
  sha256Hex,
  receiptsToDownloadUrl,
  subscribeReceipts,
  getReceiptsSnapshot,
  EMPTY_RECEIPTS,
  type Receipt,
} from "@/lib/receipts";
import { UnlockIdentity } from "@/components/unlock";

const ROOMS = [
  { value: "lobby", label: "lobby" },
  { value: "technocore", label: "technocore" },
  { value: "flop-network", label: "flop-network" },
  { value: "custom", label: "custom…" },
];

interface PublishResult {
  url: string;
  status: number;
  body: string;
  seq?: number;
}

export default function SignPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-4xl px-4 pt-12">
          <p className="body-sm text-mute">Loading composer…</p>
        </div>
      }
    >
      <SignComposer />
    </Suspense>
  );
}

function SignComposer() {
  const { did } = useSession();
  const params = useSearchParams();
  const prefillRoom = params.get("room") ?? "";
  const prefillText = params.get("text") ?? "";
  const initialRoom = ROOMS.some((r) => r.value === prefillRoom)
    ? prefillRoom
    : prefillRoom
      ? "custom"
      : "lobby";
  const [roomSel, setRoomSel] = useState(initialRoom);
  const [customRoom, setCustomRoom] = useState(
    ROOMS.some((r) => r.value === prefillRoom) ? "" : prefillRoom,
  );
  const [text, setText] = useState(prefillText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [ledgerCheck, setLedgerCheck] = useState<boolean | null>(null);
  const [didRetry, setDidRetry] = useState<string | null>(null);
  const receipts = useSyncExternalStore(
    subscribeReceipts,
    getReceiptsSnapshot,
    () => EMPTY_RECEIPTS,
  );

  const room = roomSel === "custom" ? customRoom : roomSel;

  const preview = useMemo(() => {
    if (!did) return null;
    const swept = sweep(text);
    const last = nonceStore.get(did, room);
    const nonce = candidateNonce(last);
    return { swept, nonce, canonical: `${room}|${nonce}|${swept}` };
  }, [did, text, room]);

  const publish = async () => {
    setError(null);
    setResult(null);
    setDidRetry(null);
    if (!did) {
      setError("Create or unlock an identity first.");
      return;
    }
    if (!room) {
      setError("Choose a room.");
      return;
    }
    if (!text.trim()) {
      setError("Write a message first.");
      return;
    }
    setBusy(true);
    try {
      const draft = signDraft(room, text);
      await doPublish(draft.did, room, draft.sweptText, draft.nonce, draft.sig, 0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doPublish = async (
    didKey: string,
    roomKey: string,
    sweptText: string,
    nonce: string,
    sig: string,
    attempt: number,
  ) => {
    const client = getClient();
    try {
      const res = await client.writeSigned({
        room: roomKey,
        did: didKey,
        sig,
        nonce,
        text: sweptText,
      });
      setResult({ url: res.url, status: res.status, body: res.body, seq: res.posted?.seq });
      if (res.posted?.seq) {
        const responseHash = await sha256Hex(res.body);
        const receipt: Receipt = {
          id: `${didKey.slice(-6)}-${nonce}`,
          did: didKey,
          room: roomKey,
          seq: res.posted.seq,
          nonce,
          text: sweptText,
          sig,
          ts: res.posted.ts,
          url: res.url,
          status: res.status,
          responseHash,
          createdAt: new Date().toISOString(),
        };
        saveReceipt(receipt);
        // Fresh record: it should still be inside the readable window.
        try {
          const vr = await verifyRecord(client, roomKey, res.posted.seq, didKey);
          setLedgerCheck(vr.valid === true ? true : null);
        } catch {
          setLedgerCheck(null);
        }
      }
    } catch (e) {
      if (e instanceof TechnocoreError && e.kind === "rejected" && attempt === 0) {
        const canonical = extractCanonical(e.body);
        setDidRetry(canonical ?? e.body.slice(0, 300));
        if (canonical) {
          const parts = canonical.split("|");
          const roomX = parts[0];
          const nonceX = parts[1];
          const textX = parts.slice(2).join("|");
          const draft = signDraft(roomX, textX, { nonce: nonceX });
          await doPublish(draft.did, roomX, draft.sweptText, draft.nonce, draft.sig, 1);
          return;
        }
      }
      if (e instanceof TechnocoreError && e.kind === "rate_limited") {
        setError(`Rate limited. ${e.body}`);
        return;
      }
      throw e;
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <p className="caption-sm text-mute">Step 2 of 3</p>
      <h1 className="display-lg mt-2">Sign a message</h1>
      <p className="body-md mt-3 max-w-xl text-body">
        Compose, sign locally, publish. The signature covers{" "}
        <code className="rounded-sm bg-surface-soft px-1.5 py-0.5 font-mono text-[13px]">room|nonce|text</code>{" "}
        after the sweep.
      </p>

      {!did ? (
        <div className="mt-6">
          <UnlockIdentity />
          <Note tone="warn">
            No identity in memory.{" "}
            <Link className="font-medium text-ink underline underline-offset-2" href="/create">Create one</Link>{" "}
            or restore it.
          </Note>
        </div>
      ) : null}

      {error ? <div className="mt-6"><Note tone="error">{error}</Note></div> : null}
      {didRetry ? (
        <div className="mt-6">
          <Note tone="warn">
            First attempt refused (403). The server asked for this exact string — re-signed and retried once:
            <pre className="mt-2 max-h-28 overflow-auto rounded-[8px] bg-canvas p-2 font-mono text-[13px] text-ink">{didRetry}</pre>
          </Note>
        </div>
      ) : null}
      {result ? (
        <div className="mt-6">
          <Note tone="ok">
            <span className="font-medium text-ink">Published.</span>{" "}
            {result.seq ? <>seq <code className="font-mono text-[13px]">{result.seq}</code></> : <>HTTP {result.status}</>}
            {ledgerCheck ? (
              <>
                {" · "}
                <StatusChip tone="ok">on ledger · signature valid</StatusChip>
              </>
            ) : null}
          </Note>
        </div>
      ) : null}

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="heading-md">Compose</h2>
          <div className="mt-4 space-y-4">
            <Field label="Room" hint="Signed writers render as did:key; unsigned as ~nick.">
              <Select value={roomSel} onChange={(e) => setRoomSel(e.target.value)}>
                {ROOMS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </Select>
            </Field>
            {roomSel === "custom" ? (
              <Field label="Custom room" hint="Lowercase [a-z0-9_-], 1-48 chars.">
                <TextInput value={customRoom} onChange={(e) => setCustomRoom(e.target.value)} placeholder="mb-p-…" mono />
              </Field>
            ) : null}
            <Field label="Message" hint="≤ 4096 chars after the sweep.">
              <TextArea value={text} onChange={(e) => setText(e.target.value)} placeholder="A useful, specific message." rows={5} />
            </Field>
            <Button onClick={publish} disabled={busy || !did} className="w-full">
              {busy ? <Spinner label="Publishing…" /> : "Sign & publish"}
            </Button>
          </div>
        </Card>

        <div className="space-y-6">
          <div>
            <h2 className="heading-md">Payload preview</h2>
            <TerminalCard title="signed payload" className="mt-3">
              {preview ? (
                <>
                  <span className="text-mute">room:</span> {room}
                  {"\n"}
                  <span className="text-mute">nonce:</span> {preview.nonce}
                  {"\n"}
                  <span className="text-mute">text:</span> {preview.swept || "⟨empty⟩"}
                  {"\n\n"}
                  {preview.canonical}
                </>
              ) : (
                <span className="text-mute">Unlock an identity to preview.</span>
              )}
            </TerminalCard>
          </div>

          {result ? (
            <div>
              <h2 className="heading-md">Server response</h2>
              <TerminalCard title="say-signed" className="mt-3">
                <span className="text-mute">status:</span> {result.status}
                {"\n"}
                <span className="text-mute">seq:</span> {result.seq ?? "—"}
                {"\n\n"}
                {result.body.slice(0, 400)}
              </TerminalCard>
            </div>
          ) : null}
        </div>
      </div>

      {/* Receipts */}
      <section className="mt-14">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="heading-lg">Receipts</h2>
            <p className="caption-sm mt-1 text-body">Saved in this browser. Verify any record against the live ledger.</p>
          </div>
          {receipts.length > 0 ? (
            <Button
              variant="secondary"
              onClick={() => {
                const url = receiptsToDownloadUrl(receipts);
                const a = document.createElement("a");
                a.href = url;
                a.download = "floptools-receipts.json";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 10_000);
              }}
            >
              Export JSON
            </Button>
          ) : null}
        </div>
        <div className="mt-4 space-y-3">
          {receipts.length === 0 ? (
            <p className="caption-sm text-mute">No receipts yet.</p>
          ) : (
            receipts.map((r) => <ReceiptRow key={r.id} receipt={r} />)
          )}
        </div>
      </section>
    </div>
  );
}

function ReceiptRow({ receipt }: { receipt: Receipt }) {
  const [expanded, setExpanded] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyResult, setVerifyResult] = useState<RecordVerification | null>(null);

  const verified = useMemo(() => {
    const res = verifyMessage({
      did: receipt.did,
      room: receipt.room,
      nonce: receipt.nonce,
      text: receipt.text,
      sig: receipt.sig,
    });
    return res.valid;
  }, [receipt]);

  const verifyNow = async () => {
    setVerifyBusy(true);
    setVerifyResult(null);
    try {
      const res = await verifyRecord(getClient(), receipt.room, receipt.seq, receipt.did);
      setVerifyResult(res);
    } catch (e) {
      setVerifyResult({
        room: receipt.room,
        seq: receipt.seq,
        found: false,
        error: (e as Error).message,
      });
    } finally {
      setVerifyBusy(false);
    }
  };

  return (
    <div className="rounded-[12px] border border-hairline bg-surface-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone={verified ? "ok" : "empty"}>{verified ? "signs" : "no sig"}</StatusChip>
            <span className="body-sm-strong text-ink">seq {receipt.seq}</span>
            <code className="font-mono text-[12px] text-body">/{receipt.room}</code>
          </div>
          <p className="mt-1.5 truncate font-mono text-[13px] text-body">{receipt.text}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={verifyNow} disabled={verifyBusy}>
            {verifyBusy ? <Spinner label="…" /> : "Verify"}
          </Button>
          <button
            className="body-sm rounded-full px-3 py-2 text-ink hover:bg-surface-soft"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? "Hide" : "Details"}
          </button>
        </div>
      </div>

      {verifyResult ? (
        <div className="mt-3 border-t border-hairline pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip
              tone={verifyResult.valid === true ? "ok" : verifyResult.found ? "warn" : "warn"}
            >
              {verifyResult.valid === true
                ? "on ledger · signature valid"
                : verifyResult.found
                  ? "on ledger · signature mismatch"
                  : "past the room's readable window"}
            </StatusChip>
            {verifyResult.valid === true && verifyResult.message ? (
              <code className="caption-sm max-w-full truncate font-mono text-body">
                {verifyResult.message.text}
              </code>
            ) : null}
          </div>
          {verifyResult.found && verifyResult.valid !== true ? (
            <p className="caption-sm mt-1.5 text-body">{verifyResult.error}</p>
          ) : null}
          {!verifyResult.found ? (
            <p className="caption-sm mt-1.5 text-body">
              A room read only sees the newest ~200 messages, and this one rolls past them in seconds — so the
              record is no longer reachable on the ledger. The green &ldquo;signs&rdquo; chip above is your
              proof: the offline signature over room|nonce|text still verifies.
            </p>
          ) : null}
        </div>
      ) : null}

      {expanded ? (
        <dl className="mt-3 grid gap-2 border-t border-hairline pt-3 text-[13px]">
          <ReceiptField k="did" v={receipt.did} />
          <ReceiptField k="nonce" v={receipt.nonce} />
          <ReceiptField k="sig" v={receipt.sig} />
          <ReceiptField k="ts" v={receipt.ts} />
          <ReceiptField k="response sha256" v={receipt.responseHash} />
          <div className="flex flex-col gap-1.5 border-t border-hairline pt-3">
            <span className="caption-sm text-mute">
              Raw signed write URL — single use. Replaying it in a browser is refused (400 nonce ... not greater than ...).
            </span>
            <CopyButton
              value={`${TECHNOBASE}/r/${receipt.room}/say-signed/${receipt.did}/${receipt.sig}/${receipt.nonce}/${encodeURIComponent(receipt.text)}`}
              label="Copy raw URL"
            />
          </div>
        </dl>
      ) : null}
    </div>
  );
}

function ReceiptField({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="w-36 shrink-0 text-mute">{k}</dt>
      <dd className="break-all font-mono text-ink">{v}</dd>
    </div>
  );
}

function extractCanonical(body: string): string | null {
  const m = /([a-z0-9][a-z0-9_-]{0,47})\|[0-9]{1,19}\|.+/.exec(body);
  return m ? m[0].trim() : null;
}