"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Button,
  Card,
  Field,
  Note,
  Spinner,
  StatusChip,
  TextInput,
} from "@/components/ui";
import { generateSeed, publicKeyFromSeed, signBytes, bytesToBase64Url } from "@/lib/crypto";
import { didFromPublicKey, didNotePaths } from "@/lib/didkey";
import {
  encryptIdentity,
  identityFilenameFor,
  identityShortName,
  MIN_PASSPHRASE_LENGTH,
  type IdentityFile,
} from "@/lib/identity";
import { didNoteValue } from "@/lib/keyring";
import { getClient } from "@/lib/client";
import { sweep } from "@/lib/sweep";
import { TechnocoreError } from "@/lib/technocore";
import { BUILTIN_TEMPLATES, SLOT_META, TEMPLATE_SLOTS, type TemplateSlot } from "@/lib/personalize";
import { getTemplatesSnapshot } from "@/lib/templates";
import { downloadBlob, makeZip } from "@/lib/zip";

/**
 * /pro/auto — Pro bulk wallet runner.
 *
 * Generates up to 5 fresh did:key identities IN THE BROWSER, encrypts each
 * identity file with the passphrase you type, downloads them as one ZIP, then
 * publishes for every wallet, straight to the public technocore ledger:
 *   - the DID note at /kv/did-<shard>/<key>
 *   - the five activity check-ins (same rooms as /activity)
 * and keeps retrying every task until the ledger accepts it.
 *
 * Nothing is written to this site's database or localStorage: no usage rows,
 * no task counters, no wallet records. The encrypted files go to you only.
 */

const MAX_WALLETS = 5;

type TaskId = "did-note" | TemplateSlot;

interface TaskRun {
  id: TaskId;
  label: string;
  room?: string;
  status: "pending" | "running" | "done" | "retrying";
  attempts: number;
  lastError?: string;
}

interface WalletRun {
  did: string;
  short: string;
  seed: Uint8Array;
  file: IdentityFile;
  tasks: TaskRun[];
}

type Preset = "checking" | "pro" | "not-pro";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function ProAutoPage() {
  const [preset, setPreset] = useState<Preset>("checking");
  const [count, setCount] = useState("3");
  const [passphrase, setPassphrase] = useState("");
  const [phase, setPhase] = useState<"idle" | "generating" | "running" | "stopped" | "finished">("idle");
  const [wallets, setWallets] = useState<WalletRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);
  const nonceRef = useRef(0);
  const templatesRef = useRef<Record<TemplateSlot, string>>({ ...BUILTIN_TEMPLATES });

  useEffect(() => {
    void fetch("/api/pro/status", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ pro?: boolean }>)
      .then((d) => setPreset(d.pro ? "pro" : "not-pro"))
      .catch(() => setPreset("not-pro"));
  }, []);

  const updateTask = useCallback((did: string, taskId: TaskId, patch: Partial<TaskRun>) => {
    setWallets((prev) =>
      prev.map((w) =>
        w.did === did
          ? { ...w, tasks: w.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) }
          : w,
      ),
    );
  }, []);

  /** Publish one task, retrying until the ledger accepts (409/422 = already there). */
  const runTask = async (
    client: ReturnType<typeof getClient>,
    w: WalletRun,
    t: TaskRun,
  ): Promise<void> => {
    let attempt = 0;
    for (;;) {
      if (stopRef.current) return;
      updateTask(w.did, t.id, { status: attempt === 0 ? "running" : "retrying", attempts: attempt + 1, lastError: undefined });
      try {
        if (t.id === "did-note") {
          const { ns, key } = (await didNotePaths(w.did)).sharded;
          await client.setNote(ns, key, didNoteValue(w.did), { ifAbsent: true });
        } else {
          const text = templatesRef.current[t.id];
          const nonce = String(nonceRef.current++);
          const sweptText = sweep(text);
          const canonical = `${t.room}|${nonce}|${sweptText}`;
          const sig = bytesToBase64Url(signBytes(w.seed, new TextEncoder().encode(canonical)));
          await client.writeSigned({ room: t.room!, did: w.did, sig, nonce, text: sweptText });
        }
        updateTask(w.did, t.id, { status: "done", attempts: attempt + 1 });
        return;
      } catch (e) {
        const status = e instanceof TechnocoreError ? e.status : 0;
        // Already on the board (note exists / duplicate message) counts as published.
        if (status === 409 || status === 422) {
          updateTask(w.did, t.id, { status: "done", attempts: attempt + 1 });
          return;
        }
        attempt++;
        const msg = e instanceof Error ? e.message.slice(0, 160) : "unknown error";
        updateTask(w.did, t.id, { status: "retrying", attempts: attempt, lastError: msg });
        await sleep(Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4)));
      }
    }
  };

  const runAll = async (list: WalletRun[]) => {
    const client = getClient();
    for (const w of list) {
      for (const t of w.tasks) {
        if (stopRef.current) return;
        if (t.status !== "done") await runTask(client, w, t);
      }
    }
    setPhase(stopRef.current ? "stopped" : "finished");
  };

  const start = async () => {
    setError(null);
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > MAX_WALLETS) {
      setError(`Wallet count must be a whole number from 1 to ${MAX_WALLETS}.`);
      return;
    }
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      setError(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters — it encrypts every wallet file.`);
      return;
    }

    setPhase("generating");
    stopRef.current = false;
    nonceRef.current = Date.now();
    const saved = getTemplatesSnapshot();
    templatesRef.current = saved ? { ...BUILTIN_TEMPLATES, ...saved.templates } : { ...BUILTIN_TEMPLATES };

    try {
      const built: WalletRun[] = [];
      for (let i = 0; i < n; i++) {
        const seed = generateSeed();
        const publicKey = publicKeyFromSeed(seed);
        const did = didFromPublicKey(publicKey);
        const file = await encryptIdentity(seed, did, publicKey, passphrase);
        built.push({
          did,
          short: identityShortName(did),
          seed,
          file,
          tasks: [
            { id: "did-note", label: "Publish DID note", status: "pending", attempts: 0 },
            ...TEMPLATE_SLOTS.map((slot): TaskRun => ({
              id: slot,
              label: SLOT_META[slot].label,
              room: SLOT_META[slot].room,
              status: "pending",
              attempts: 0,
            })),
          ],
        });
      }
      setWallets(built);

      // Export first: the encrypted files must land on disk before anything
      // is published, so a closed tab never strands a wallet.
      const enc = new TextEncoder();
      const stamp = new Date().toISOString();
      const readme = [
        "floptools pro auto - generated wallets",
        `Generated: ${stamp}`,
        `Wallets: ${built.length}`,
        "",
        "Each identity_*.json is an ENCRYPTED identity file. Import it on /create",
        "(or /pro/create) with the SAME passphrase you typed. The passphrase is not",
        "stored anywhere - if you lose it, these files cannot be recovered.",
        "",
        "Every wallet publishes its DID note and check-in messages to the public",
        "technocore ledger. floptools keeps no record of these keys.",
        "",
        "Files:",
        ...built.map((w) => `${identityFilenameFor(w.did)}  ${w.did}`),
        "",
      ].join("\n");
      const zip = makeZip([
        { name: "README.txt", data: enc.encode(readme) },
        ...built.map((w) => ({
          name: identityFilenameFor(w.did),
          data: enc.encode(JSON.stringify(w.file, null, 2)),
        })),
      ]);
      downloadBlob(zip, `floptools-pro-wallets-${built.length}-${stamp.slice(0, 10)}.zip`);

      setPhase("running");
      await runAll(built);
    } catch (e) {
      setError((e as Error).message);
      setPhase("stopped");
    }
  };

  const stop = () => {
    stopRef.current = true;
    setPhase("stopped");
  };

  const resume = () => {
    stopRef.current = false;
    setPhase("running");
    void runAll(wallets);
  };

  const total = wallets.reduce((n, w) => n + w.tasks.length, 0);
  const done = wallets.reduce((n, w) => n + w.tasks.filter((t) => t.status === "done").length, 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <p className="caption-sm text-mute">floptools · pro · auto</p>
      <h1 className="display-lg mt-2">Auto wallet runner</h1>
      <p className="body-md mt-3 max-w-2xl text-body">
        Generate up to {MAX_WALLETS} fresh did:key identities in this browser, export them as one
        encrypted ZIP, and publish every wallet&apos;s DID note + five check-ins to the public
        technocore ledger — automatically, retrying until each one lands.
      </p>

      {preset === "not-pro" ? (
        <div className="mt-6">
          <Note tone="warn">
            This is a Pro feature. <Link className="font-medium text-ink underline underline-offset-2" href="/">Unlock Pro first</Link>{" "}
            — then come back.
          </Note>
        </div>
      ) : null}

      {preset !== "not-pro" ? (
        <Card className="mt-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Wallets to generate" hint={`1 to ${MAX_WALLETS}. Each wallet is a fresh did:key.`}>
              <TextInput
                value={count}
                onChange={(e) => setCount(e.target.value)}
                inputMode="numeric"
                placeholder="3"
                disabled={phase === "generating" || phase === "running"}
              />
            </Field>
            <Field label="Passphrase for the files" hint={`At least ${MIN_PASSPHRASE_LENGTH} characters. Encrypts every wallet; never stored.`}>
              <TextInput
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="your passphrase"
                autoComplete="off"
                disabled={phase === "generating" || phase === "running"}
              />
            </Field>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button onClick={() => void start()} disabled={phase === "generating" || phase === "running"}>
              {phase === "generating" ? <Spinner label="Generating…" /> : "Create & run"}
            </Button>
            {phase === "running" ? (
              <Button variant="secondary" onClick={stop}>
                Stop
              </Button>
            ) : null}
            {phase === "stopped" && wallets.length > 0 ? (
              <Button variant="secondary" onClick={resume}>
                Resume
              </Button>
            ) : null}
          </div>
          {error ? <div className="mt-3"><Note tone="error">{error}</Note></div> : null}
          <p className="caption-sm mt-3 text-body">
            The ZIP downloads before any publishing starts. Keys are generated locally; only signed
            public messages leave this browser. Nothing is saved to floptools&apos; database or your
            browser storage.
          </p>
        </Card>
      ) : null}

      {wallets.length > 0 ? (
        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="heading-lg">Progress</h2>
            <StatusChip tone={phase === "finished" ? "ok" : phase === "running" ? "empty" : "warn"}>
              {phase === "finished" ? "all published" : phase === "running" ? "running" : phase}
            </StatusChip>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-soft">
            <div className="h-full rounded-full bg-leaf-600" style={{ width: `${pct}%` }} />
          </div>
          <p className="caption-sm mt-1 text-body">
            {done} / {total} tasks published ({pct}%)
          </p>

          <div className="mt-4 space-y-3">
            {wallets.map((w) => (
              <Card key={w.did}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="body-sm-strong text-ink">{w.short}</p>
                    <p className="break-all font-mono text-[12px] text-mute">{w.did}</p>
                  </div>
                  <span className="font-mono text-[12px] text-body">
                    {identityFilenameFor(w.did)}
                  </span>
                </div>
                <div className="mt-3 space-y-2">
                  {w.tasks.map((t) => (
                    <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-hairline bg-canvas px-3 py-2">
                      <div className="min-w-0">
                        <p className="body-sm text-ink">
                          {t.label}
                          {t.room ? <span className="ml-2 font-mono text-[12px] text-mute">/{t.room}</span> : (
                            <span className="ml-2 font-mono text-[12px] text-mute">/kv did note</span>
                          )}
                        </p>
                        {t.lastError && t.status === "retrying" ? (
                          <p className="caption-sm mt-0.5 text-amber-600">
                            attempt {t.attempts} — {t.lastError}
                          </p>
                        ) : null}
                      </div>
                      <StatusChip
                        tone={
                          t.status === "done" ? "ok" : t.status === "retrying" ? "warn" : t.status === "running" ? "empty" : "empty"
                        }
                      >
                        {t.status === "done" ? "published" : t.status}
                      </StatusChip>
                    </div>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      <Note tone="info" className="mt-8">
        <strong className="font-medium text-brand-700">Keep the ZIP safe.</strong> These are encrypted
        identity files — import them on /create with the same passphrase. floptools stores nothing:
        no wallet list, no activity counters, no offline copy. If the tab closes mid-run, reopen this
        page and re-run the same wallets (a repeat publish is treated as already-on-the-board).
      </Note>
    </div>
  );
}
