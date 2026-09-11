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
  decryptIdentity,
  encryptIdentity,
  identityFilenameFor,
  identityShortName,
  isIdentityFile,
  MIN_PASSPHRASE_LENGTH,
  type IdentityFile,
} from "@/lib/identity";
import { didNoteValue } from "@/lib/keyring";
import { getClient } from "@/lib/client";
import { sweep } from "@/lib/sweep";
import { TechnocoreError } from "@/lib/technocore";
import {
  BUILTIN_TEMPLATES,
  SLOT_META,
  TEMPLATE_SLOTS,
  type Persona,
  type TemplateSlot,
} from "@/lib/personalize";
import { downloadBlob, makeZip, readZip } from "@/lib/zip";

/**
 * /pro/auto — Pro bulk wallet runner.
 *
 * Generates up to 5 fresh did:key identities IN THE BROWSER (or imports an
 * existing wallets ZIP), encrypts / decrypts identity files locally, and
 * publishes for every wallet straight to the public technocore ledger:
 *   - the DID note at /kv/did-<shard>/<key> (skipped when already present)
 *   - the five activity check-ins, each wallet with its OWN AI persona
 *     (unique name + persona + text; no two wallets sound alike)
 * Wallets run in parallel (rate-limit aware pools) and every task retries
 * until the ledger accepts it. Nothing is recorded on this site.
 */

const MAX_WALLETS = 100;
const WALLET_CONCURRENCY = 6;
const ENCRYPT_CONCURRENCY = 6;
const PERSONA_ATTEMPTS = 2;
const PERSONA_TIMEOUT_MS = 25_000;
const ACCEPTED = new Set([409, 422]); // already on the board

const PERSONA_CYCLE: Persona[] = ["developer", "creator", "tester", "surprise"];

/** Distinct display names: a base + the wallet's own did suffix — unique forever. */
const NAME_BASES = [
  "Aarav", "Nadia", "Rafi", "Mira", "Tanvir", "Sadia", "Imran", "Lina", "Farhan", "Rupa",
  "Arif", "Nabila", "Rasel", "Tisha", "Sohan", "Joya", "Riyad", "Mou", "Fahim", "Anika",
  "Sajid", "Priya", "Nayan", "Shila", "Rifat", "Muna", "Zahir", "Borsha", "Adil", "Keya",
];

type TaskId = "did-note" | TemplateSlot;

interface TaskRun {
  id: TaskId;
  label: string;
  room?: string;
  status: "pending" | "running" | "done" | "retrying" | "skipped" | "failed";
  attempts: number;
  lastError?: string;
}

const MAX_TASK_ATTEMPTS = 20;

/**
 * A wallet needs a persona when any slot text is missing. An empty object is
 * truthy, so never test the object itself — check the slots.
 */
const needsPersona = (w: WalletRun): boolean => TEMPLATE_SLOTS.some((s) => !w.templates?.[s]);

/** Transient failures retry until the cap; permanent ones fail fast. */
const retryableStatus = (status: number): boolean => status === 0 || status === 429 || status >= 500;

/** Built-in check-in lines, still unique per wallet via its short name. */
const builtinFor = (short: string): Record<TemplateSlot, string> =>
  Object.fromEntries(
    TEMPLATE_SLOTS.map((s) => [s, `${BUILTIN_TEMPLATES[s]} · ${short}`]),
  ) as Record<TemplateSlot, string>;

interface WalletRun {
  did: string;
  short: string;
  seed: Uint8Array;
  file: IdentityFile;
  name: string;
  persona: Persona;
  personaTitle?: string;
  templates: Record<TemplateSlot, string>;
  noteAlready: boolean;
  /** True when the wallet already has public history (note or messages). */
  established: boolean;
  /** Excerpt of its existing public line, so new messages match that voice. */
  styleHint?: string;
  tasks: TaskRun[];
}

type Preset = "checking" | "pro" | "not-pro";
type Phase = "idle" | "generating" | "personas" | "running" | "stopped" | "finished";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function taskList(): TaskRun[] {
  return [
    {
      id: "did-note",
      label: "Publish / refresh DID note",
      status: "pending",
      attempts: 0,
    },
    ...TEMPLATE_SLOTS.map((slot): TaskRun => ({
      id: slot,
      label: SLOT_META[slot].label,
      room: SLOT_META[slot].room,
      status: "pending",
      attempts: 0,
    })),
  ];
}

async function runPool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        await worker(items[i], i);
      }
    }),
  );
}

export default function ProAutoPage() {
  const [preset, setPreset] = useState<Preset>("checking");
  const [count, setCount] = useState("3");
  const [passphrase, setPassphrase] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPass, setImportPass] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [prepared, setPrepared] = useState<WalletRun[] | null>(null);
  const [useAi, setUseAi] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [wallets, setWallets] = useState<WalletRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);
  const nonceRef = useRef(0);

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

  const patchWallet = useCallback((did: string, patch: Partial<WalletRun>) => {
    setWallets((prev) => prev.map((w) => (w.did === did ? { ...w, ...patch } : w)));
  }, []);

  /** One AI persona per wallet: unique name + persona + fresh text. */
  const generatePersona = async (w: WalletRun) => {
    let attempt = 0;
    for (;;) {
      if (stopRef.current) return;
      try {
        const res = await fetch("/api/personalize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Established wallets get compact, voice-matched top-ups (fewer
          // tokens); fresh wallets get the full persona set.
          body: JSON.stringify({
            name: w.name,
            persona: w.persona,
            did: w.did,
            compact: w.established,
            style: w.styleHint,
          }),
          signal: AbortSignal.timeout(PERSONA_TIMEOUT_MS),
        });
        const data = (await res.json()) as {
          personaTitle?: string;
          templates?: Record<TemplateSlot, string>;
        };
        if (!res.ok || !data.templates) throw new Error(`HTTP ${res.status}`);
        patchWallet(w.did, { personaTitle: data.personaTitle, templates: data.templates });
        return;
      } catch {
        attempt++;
        if (attempt >= PERSONA_ATTEMPTS) {
          // Fast, honest fallback: unique built-in lines for this wallet, so a
          // slow AI never blocks the run or duplicates another wallet.
          patchWallet(w.did, { templates: builtinFor(w.short), personaTitle: "built-in" });
          return;
        }
        await sleep(1500);
      }
    }
  };

  /** Publish one task, retrying until the ledger accepts (409/422 = already there). */
  const runTask = async (client: ReturnType<typeof getClient>, w: WalletRun, t: TaskRun) => {
    let attempt = 0;
    for (;;) {
      if (stopRef.current) return;
      updateTask(w.did, t.id, {
        status: attempt === 0 ? "running" : "retrying",
        attempts: attempt + 1,
        lastError: undefined,
      });
      try {
        if (t.id === "did-note") {
          // Unconditional: the first write creates the note, every later run
          // refreshes the same record and keeps the wallet alive. No conflict.
          const { ns, key } = (await didNotePaths(w.did)).sharded;
          await client.setNote(ns, key, didNoteValue(w.did));
        } else {
          // A missing slot text falls back to a unique built-in line so a
          // persona hiccup can never spin the runner or duplicate a wallet.
          const text = w.templates[t.id] ?? `${BUILTIN_TEMPLATES[t.id]} · ${w.short}`;
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
        if (ACCEPTED.has(status)) {
          updateTask(w.did, t.id, { status: "done", attempts: attempt + 1 });
          return;
        }
        attempt++;
        const msg = e instanceof Error ? e.message.slice(0, 160) : "unknown error";
        const detail = status > 0 ? `${msg} (HTTP ${status})` : msg;
        // Permanent errors (bad request, rejected signature) never get better
        // by repeating; transient ones stop at a sane cap and wait for Resume.
        if (!retryableStatus(status) || attempt >= MAX_TASK_ATTEMPTS) {
          updateTask(w.did, t.id, { status: "failed", attempts: attempt, lastError: detail });
          return;
        }
        updateTask(w.did, t.id, { status: "retrying", attempts: attempt, lastError: detail });
        await sleep(Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4)));
      }
    }
  };

  /**
   * One pipeline per wallet: persona first (when needed), then its tasks —
   * publishing starts as soon as the first persona is ready, so a long run
   * never sits at 0% while all 100 personas generate.
   */
  const startRun = async (list: WalletRun[], imported: boolean) => {
    setError(null);
    stopRef.current = false;
    nonceRef.current = Date.now();
    setPhase("running");

    const client = getClient();
    await runPool(list, WALLET_CONCURRENCY, async (w) => {
      if (stopRef.current) return;
      if (needsPersona(w)) await generatePersona(w);
      if (stopRef.current) return;
      for (const t of w.tasks) {
        if (stopRef.current) return;
        if (t.status === "done" || t.status === "skipped") continue;
        await runTask(client, w, t);
      }
    });

    const doneNow = stopRef.current ? "stopped" : "finished";
    setPhase(doneNow);
    if (!stopRef.current) {
      // Anonymous pro telemetry (counts only — no wallet identities).
      void fetch("/api/pro/auto-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallets: list.length, imported }),
      }).catch(() => {});
    }
  };

  const buildNewWallets = async (n: number): Promise<WalletRun[]> => {
    const slots: (WalletRun | null)[] = Array.from({ length: n }, () => null);
    await runPool(
      Array.from({ length: n }, (_, i) => i),
      ENCRYPT_CONCURRENCY,
      async (i) => {
        const seed = generateSeed();
        const publicKey = publicKeyFromSeed(seed);
        const did = didFromPublicKey(publicKey);
        const file = await encryptIdentity(seed, did, publicKey, passphrase);
        const short = identityShortName(did);
        slots[i] = {
          did,
          short,
          seed,
          file,
          name: `${NAME_BASES[i % NAME_BASES.length]}-${did.slice(-4)}`,
          persona: PERSONA_CYCLE[i % PERSONA_CYCLE.length],
          templates: useAi ? ({} as Record<TemplateSlot, string>) : builtinFor(short),
          noteAlready: false,
          established: false,
          tasks: taskList(),
        };
      },
    );
    return slots.filter((w): w is WalletRun => w !== null);
  };

  const downloadWalletsZip = (list: WalletRun[]) => {
    const enc = new TextEncoder();
    const stamp = new Date().toISOString();
    const readme = [
      "floptools pro auto - generated wallets",
      `Generated: ${stamp}`,
      `Wallets: ${list.length}`,
      "",
      "Each identity_*.json is an ENCRYPTED identity file. Import it on /pro/create",
      "(or import the whole ZIP on /pro/auto) with the SAME passphrase you typed.",
      "The passphrase is not stored anywhere - if you lose it, these files cannot",
      "be recovered.",
      "",
      "Every wallet publishes its DID note and check-in messages to the public",
      "technocore ledger. floptools keeps no record of these keys.",
      "",
      "Files:",
      ...list.map((w) => `${identityFilenameFor(w.did)}  ${w.did}`),
      "",
    ].join("\n");
    const zip = makeZip([
      { name: "README.txt", data: enc.encode(readme) },
      ...list.map((w) => ({
        name: identityFilenameFor(w.did),
        data: enc.encode(JSON.stringify(w.file, null, 2)),
      })),
    ]);
    downloadBlob(zip, `floptools-pro-wallets-${list.length}-${stamp.slice(0, 10)}.zip`);
  };

  const startGenerate = async () => {
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
    try {
      const built = await buildNewWallets(n);
      setWallets(built);
      downloadWalletsZip(built);
      await startRun(built, false);
    } catch (e) {
      setError((e as Error).message);
      setPhase("stopped");
    }
  };

  const noteExists = async (did: string): Promise<boolean> => {
    try {
      const paths = await didNotePaths(did);
      const client = getClient();
      const [a, b] = await Promise.all([
        client.readNote(paths.sharded.ns, paths.sharded.key).catch(() => null),
        client.readNote(paths.legacy.ns, paths.legacy.key).catch(() => null),
      ]);
      const value = a?.found ? a.value : b?.found ? b.value : "";
      return value.trim().split(/\s+/)[0] === did;
    } catch {
      return false;
    }
  };

  /** Step 1+2: read the ZIP, decrypt locally, check notes — no publishing yet. */
  const prepareImport = async () => {
    setError(null);
    if (!importFile) {
      setError("Choose a wallets ZIP first.");
      return;
    }
    if (importPass.length < MIN_PASSPHRASE_LENGTH) {
      setError(`Enter this ZIP's passphrase (at least ${MIN_PASSPHRASE_LENGTH} characters).`);
      return;
    }
    setImportBusy(true);
    try {
      const entries = readZip(await importFile.arrayBuffer());
      const idEntries = entries.filter((e) => /^identity_.*\.json$/i.test(e.name));
      if (idEntries.length === 0) {
        throw new Error("No identity_*.json files found in this ZIP.");
      }
      const dec = new TextDecoder();
      const imported: WalletRun[] = [];
      const seen = new Set<string>();
      for (const e of idEntries) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(dec.decode(e.data));
        } catch {
          throw new Error(`"${e.name}" is not valid JSON.`);
        }
        if (!isIdentityFile(parsed)) {
          throw new Error(`"${e.name}" is not a floptools identity file.`);
        }
        if (seen.has(parsed.public.did)) continue;
        seen.add(parsed.public.did);
        let unlocked;
        try {
          unlocked = await decryptIdentity(parsed, importPass);
        } catch {
          throw new Error(`Could not decrypt "${e.name}" — wrong passphrase?`);
        }
        const short = identityShortName(unlocked.did);
        imported.push({
          did: unlocked.did,
          short,
          seed: unlocked.seed,
          file: parsed,
          name: short,
          persona: PERSONA_CYCLE[imported.length % PERSONA_CYCLE.length],
          templates: useAi ? ({} as Record<TemplateSlot, string>) : builtinFor(short),
          noteAlready: false,
          established: false,
          tasks: [],
        });
      }
      if (imported.length === 0) throw new Error("No wallets to import.");
      if (imported.length > MAX_WALLETS) {
        throw new Error(`This ZIP has ${imported.length} wallets — at most ${MAX_WALLETS} per run. Split the ZIP and import in batches.`);
      }
      // A DID note already on the ledger is never republished; activity is.
      const notes = await Promise.all(imported.map((w) => noteExists(w.did)));

      // Read each wallet's retained public voice (best effort, batched): a
      // wallet that already posted gets SHORT, voice-matched top-up lines —
      // cheaper AI, same quality bar, still unique.
      const styleByDid = new Map<string, string>();
      const activityByDid = new Map<string, number>();
      for (let i = 0; i < imported.length; i += 20) {
        const chunk = imported.slice(i, i + 20).map((w) => w.did);
        try {
          const res = await fetch(`/api/tc/room-scan?dids=${encodeURIComponent(chunk.join(","))}`, { cache: "no-store" });
          const data = (await res.json()) as {
            dids?: Record<string, Record<string, { count: number; latestTs?: string; latestText?: string }>>;
          };
          for (const did of chunk) {
            const rooms = data.dids?.[did] ?? {};
            let total = 0;
            let latest: { ts: string; text: string } | null = null;
            for (const r of Object.values(rooms)) {
              total += r.count ?? 0;
              if (r.latestText && r.latestTs && (!latest || r.latestTs > latest.ts)) {
                latest = { ts: r.latestTs, text: r.latestText };
              }
            }
            activityByDid.set(did, total);
            if (latest) styleByDid.set(did, latest.text);
          }
        } catch {
          /* voice hint is best-effort */
        }
      }

      imported.forEach((w, i) => {
        w.noteAlready = notes[i];
        w.established = notes[i] || (activityByDid.get(w.did) ?? 0) > 0;
        w.styleHint = styleByDid.get(w.did);
        // The note task always runs: re-publishing refreshes the record and
        // keeps the wallet active (no skip, no conflict).
        w.tasks = taskList();
      });
      // Ready to run — the Run button appears; nothing is published yet.
      setPrepared(imported);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImportBusy(false);
    }
  };

  const runImported = async () => {
    if (!prepared) return;
    const list = prepared;
    setPrepared(null);
    setImportOpen(false);
    setWallets(list);
    await startRun(list, true);
  };

  const stop = () => {
    stopRef.current = true;
    setPhase("stopped");
  };

  const resume = () => {
    stopRef.current = false;
    // Failed tasks get a fresh shot; done/skipped ones stay untouched.
    const reset = wallets.map((w) => ({
      ...w,
      tasks: w.tasks.map((t) =>
        t.status === "failed"
          ? { ...t, status: "pending" as const, attempts: 0, lastError: undefined }
          : t,
      ),
    }));
    setWallets(reset);
    void startRun(reset, false);
  };

  const total = wallets.reduce((n, w) => n + w.tasks.length, 0);
  const done = wallets.reduce((n, w) => n + w.tasks.filter((t) => t.status === "done").length, 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const busy = phase === "generating" || phase === "personas" || phase === "running";

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <p className="caption-sm text-mute">floptools · pro · auto</p>
      <h1 className="display-lg mt-2">Auto wallet runner</h1>
      <p className="body-md mt-3 max-w-2xl text-body">
        Generate up to {MAX_WALLETS} fresh did:key identities in this browser (or import an existing
        wallets ZIP), and publish every wallet&apos;s DID note + five check-ins to the public
        technocore ledger — the note is refreshed on every run to keep the wallet active, each wallet
        with its OWN AI persona, running in parallel, retrying until every task lands.
      </p>

      {preset === "not-pro" ? (
        <div className="mt-6">
          <Note tone="warn">
            This is a Pro feature.{" "}
            <Link className="font-medium text-ink underline underline-offset-2" href="/">Unlock Pro first</Link>{" "}
            — then come back.
          </Note>
        </div>
      ) : null}

      {preset !== "not-pro" ? (
        <Card className="mt-6">
          <h2 className="heading-md">Generate new wallets</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Wallets to generate" hint={`1 to ${MAX_WALLETS}. Each wallet is a fresh did:key.`}>
              <TextInput
                value={count}
                onChange={(e) => setCount(e.target.value)}
                inputMode="numeric"
                placeholder="3"
                disabled={busy}
              />
            </Field>
            <Field label="Passphrase for the files" hint={`At least ${MIN_PASSPHRASE_LENGTH} characters. Encrypts every wallet; never stored.`}>
              <TextInput
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="your passphrase"
                autoComplete="off"
                disabled={busy}
              />
            </Field>
          </div>
          <label className="mt-4 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={useAi}
              onChange={(e) => setUseAi(e.target.checked)}
              disabled={busy}
              className="mt-0.5 h-4 w-4 rounded-sm accent-ink"
            />
            <span className="text-body">
              Use AI personas — one unique generated persona per wallet. Uncheck for instant
              built-in unique lines (much faster on large batches like 100).
            </span>
          </label>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button onClick={() => void startGenerate()} disabled={busy}>
              {phase === "generating" ? <Spinner label="Generating…" /> : "Create & run"}
            </Button>
            <Button variant="secondary" onClick={() => setImportOpen((v) => !v)} disabled={busy}>
              {importOpen ? "Hide import" : "Import wallets (.zip)"}
            </Button>
            {phase === "running" || phase === "personas" ? (
              <Button variant="secondary" onClick={stop}>
                Stop
              </Button>
            ) : null}
            {(phase === "stopped" || phase === "finished") && wallets.length > 0 && done < total ? (
              <Button variant="secondary" onClick={resume}>
                Resume
              </Button>
            ) : null}
          </div>

          {importOpen ? (
            <div className="mt-4 rounded-[12px] border border-hairline bg-canvas p-4">
              <p className="body-sm-strong text-ink">Import an existing wallets ZIP</p>
              <p className="caption-sm mt-1 text-body">
                1 · choose the ZIP · 2 · type that ZIP&apos;s passphrase · 3 · Import, then Run. Every
                wallet re-publishes its DID note as a refresh (keeping it alive) and runs the five
                check-ins — established wallets get short, voice-matched top-ups.
              </p>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="caption-sm text-mute">Wallets ZIP</p>
                  <input
                    type="file"
                    accept=".zip,application/zip"
                    disabled={busy || importBusy}
                    onChange={(e) => {
                      setImportFile(e.target.files?.[0] ?? null);
                      setPrepared(null);
                      setError(null);
                    }}
                    className="mt-1 block w-full cursor-pointer rounded-[10px] border border-hairline bg-surface-card px-3 py-2 text-[13px] text-ink file:mr-3 file:cursor-pointer file:rounded-full file:border-0 file:bg-tint-brand file:px-4 file:py-1.5 file:text-[13px] file:font-medium file:text-brand-700"
                  />
                </div>
                <Field label="Passphrase for this ZIP" hint="The passphrase you used when these wallets were generated.">
                  <TextInput
                    type="password"
                    value={importPass}
                    onChange={(e) => setImportPass(e.target.value)}
                    placeholder="passphrase for the imported files"
                    autoComplete="off"
                    disabled={busy || importBusy}
                  />
                </Field>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void prepareImport()}
                  disabled={busy || importBusy || !importFile || !importPass.trim()}
                >
                  {importBusy ? <Spinner label="Importing…" /> : "Import"}
                </Button>
                {prepared ? (
                  <Button onClick={() => void runImported()} disabled={busy}>
                    Run imported wallets
                  </Button>
                ) : null}
              </div>

              {prepared ? (
                <div className="mt-3 rounded-[10px] border border-leaf-600/25 bg-tint-leaf p-3">
                  <p className="caption-sm text-ink">
                    {prepared.length} wallet{prepared.length === 1 ? "" : "s"} imported and ready ·{" "}
                    {prepared.filter((w) => w.noteAlready).length} DID note
                    {prepared.filter((w) => w.noteAlready).length === 1 ? "" : "s"} already on the
                    ledger (they will be refreshed) · activity runs for all.
                  </p>
                  <div className="mt-2 space-y-1">
                    {prepared.map((w) => (
                      <div key={w.did} className="flex flex-wrap items-center justify-between gap-2">
                        <code className="font-mono text-[12px] text-body">{w.short}</code>
                        <StatusChip tone={w.noteAlready ? "ok" : "empty"}>
                          {w.noteAlready ? "note on ledger (refresh)" : "note will publish"}
                        </StatusChip>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? <div className="mt-3"><Note tone="error">{error}</Note></div> : null}
          <p className="caption-sm mt-3 text-body">
            The ZIP downloads before any publishing starts. Keys stay local; only signed public
            messages leave this browser. Nothing is saved to floptools&apos; database or your browser
            storage.
          </p>
        </Card>
      ) : null}

      {wallets.length > 0 ? (
        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="heading-lg">Progress</h2>
            <StatusChip tone={phase === "finished" ? "ok" : phase === "running" || phase === "personas" ? "empty" : "warn"}>
              {phase === "finished" ? "all published" : phase === "running" ? "running" : phase}
            </StatusChip>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-soft">
            <div className="h-full rounded-full bg-leaf-600" style={{ width: `${pct}%` }} />
          </div>
          <p className="caption-sm mt-1 text-body">
            {done} / {total} tasks published ({pct}%)
          </p>

          <div className="mt-4 max-h-[70vh] space-y-3 overflow-y-auto pr-1">
            {wallets.map((w) => (
              <Card key={w.did}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="body-sm-strong text-ink">
                      {w.short}
                      {w.personaTitle ? (
                        <span className="ml-2 caption-sm font-normal text-body">· {w.personaTitle} ({w.persona})</span>
                      ) : needsPersona(w) ? (
                        <span className="ml-2 caption-sm font-normal text-mute">· persona…</span>
                      ) : null}
                    </p>
                    <p className="break-all font-mono text-[12px] text-mute">{w.did}</p>
                  </div>
                  <span className="font-mono text-[12px] text-body">{identityFilenameFor(w.did)}</span>
                </div>
                <div className="mt-3 space-y-2">
                  {w.tasks.map((t) => (
                    <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-hairline bg-canvas px-3 py-2">
                      <div className="min-w-0">
                        <p className="body-sm text-ink">
                          {t.label}
                          {t.room ? (
                            <span className="ml-2 font-mono text-[12px] text-mute">/{t.room}</span>
                          ) : (
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
                          t.status === "done"
                            ? "ok"
                            : t.status === "retrying"
                              ? "warn"
                              : t.status === "failed"
                                ? "error"
                                : "empty"
                        }
                      >
                        {t.status === "done"
                          ? "published"
                          : t.status === "skipped"
                            ? "already on ledger"
                            : t.status === "failed"
                              ? "failed — press Resume"
                              : t.status}
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
        identity files — import them on /pro/create (or right here) with the same passphrase. floptools
        stores nothing: no wallet list, no activity counters, no offline copy. If the tab closes
        mid-run, import the ZIP again and resume — every task retries until the ledger accepts it.
      </Note>
    </div>
  );
}
