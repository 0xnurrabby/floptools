"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Button, Card, CopyButton, DidText, Field, Note, TextArea, TextInput, TerminalCard } from "@/components/ui";
import { LimitModal } from "@/components/limit-modal";
import { LocalTime } from "@/components/local-time";
import { useSession } from "@/components/use-session";
import {
  createIdentity,
  unlockFromFile,
  lock,
  saveEncryptedIdentity,
  getLastIdentityFile,
} from "@/lib/keyring";
import {
  MIN_PASSPHRASE_LENGTH,
  encryptIdentity,
  identityShortName,
  identityFilenameFor,
  type IdentityFile,
} from "@/lib/identity";
import {
  resolveImport,
  detectImport,
  type DetectedImport,
} from "@/lib/import";
import { publicKeyFromSeed } from "@/lib/crypto";

export default function CreatePage() {
  const { did, createdAt } = useSession();
  const [busy, setBusy] = useState<"create" | "unlock" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [limitMessage, setLimitMessage] = useState<string | null>(null);

  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [keepInBrowser, setKeepInBrowser] = useState(true);
  const [keepUnlocked, setKeepUnlocked] = useState(true);

  // import card
  const [importMode, setImportMode] = useState<"file" | "paste">("file");
  const [importText, setImportText] = useState("");
  const [importDetected, setImportDetected] = useState<DetectedImport | null>(null);
  const [importSourcePass, setImportSourcePass] = useState("");
  const [importNewPass, setImportNewPass] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const onFileChosen = async (file: File) => {
    setError(null);
    setNotice(null);
    try {
      const text = await file.text();
      setImportMode("file");
      setImportText(text);
      setImportDetected(detectImport(text));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onPaste = (value: string) => {
    setText(value);
    setImportDetected(value.trim() ? detectImport(value) : null);
  };

  const doImport = async () => {
    setError(null);
    setNotice(null);
    const det = importDetected;
    if (!det || det.kind === "unknown") {
      setError("Choose or paste an identity file first.");
      return;
    }
    if (det.needsPassphrase && !importSourcePass) {
      setError("This identity is encrypted: its passphrase is required.");
      return;
    }
    // seed flows (pem-plain, seed-json, seed-raw) need a NEW passphrase to store
    const needsNew = det.kind !== "floptools-encrypted";
    if (needsNew && importNewPass.length < MIN_PASSPHRASE_LENGTH) {
      setError(`Choose a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters to store this identity securely.`);
      return;
    }
    setBusy("import");
    try {
      const resolved = await resolveImport(importText, det.needsPassphrase ? importSourcePass : undefined);
      if (needsNew) {
        const file = await encryptIdentity(
          resolved.seed,
          resolved.did,
          publicKeyFromSeed(resolved.seed),
          importNewPass,
        );
        await unlockFromFile(file, importNewPass, { keepUnlocked });
        saveEncryptedIdentity(file);
        const filename = identityFilenameFor(resolved.did);
        downloadFile(file, filename);
        void trackDid(resolved.did, "import");
        setNotice(
          `Imported and re-encrypted. Downloaded as ${filename}; a copy is saved in this browser.`,
        );
      } else {
        // floptools encrypted: reuse the already-decrypted result
        const file = JSON.parse(importText) as IdentityFile;
        await unlockFromFile(file, importSourcePass, { keepUnlocked });
        saveEncryptedIdentity(file);
        void trackDid(file.public.did, "restore");
        setNotice(`Unlocked as ${identityShortName(file.public.did)}. Encrypted copy saved in this browser.`);
      }
      setImportText("");
      setImportDetected(null);
      setImportSourcePass("");
      setImportNewPass("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onCreate = async () => {
    setError(null);
    setNotice(null);
    if (pass.length < MIN_PASSPHRASE_LENGTH) {
      setError(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      return;
    }
    if (pass !== pass2) {
      setError("Passphrases do not match.");
      return;
    }
    // Fair use: precheck the IP cap before doing any local work.
    setBusy("create");
    try {
      const pre = await fetch("/api/limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "did_create", commit: false }),
      });
      const preBody = (await pre.json()) as { ok: boolean; message?: string };
      if (!pre.ok || !preBody.ok) {
        setLimitMessage(preBody.message ?? "Identity creation limit reached.");
        setBusy(null);
        return;
      }

      const { identity } = await createIdentity(pass, { keepUnlocked });

      // Record (double-checked server-side). Denied => lock and drop.
      const commit = await fetch("/api/limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "did_create", did: identity.public.did, commit: true }),
      });
      const commitBody = (await commit.json()) as { ok: boolean; message?: string };
      if (!commit.ok || !commitBody.ok) {
        lock();
        setLimitMessage(commitBody.message ?? "Identity creation limit reached.");
        setBusy(null);
        return;
      }

      const filename = identityFilenameFor(identity.public.did);
      downloadFile(identity, filename);
      if (keepInBrowser) {
        saveEncryptedIdentity(identity);
        setNotice(`Created ${identityShortName(identity.public.did)}. File downloaded (${filename}) and a copy is saved in this browser.`);
      } else {
        setNotice(`Created ${identityShortName(identity.public.did)}. Keep the file and passphrase: they are the only way back.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onLock = () => {
    lock();
    setNotice("Locked. Key removed from memory.");
  };

  const redownload = () => {
    const file = getLastIdentityFile();
    if (file) downloadFile(file, identityFilenameFor(file.public.did));
  };

  const setText = (value: string) => setImportText(value);

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <p className="caption-sm text-mute">Step 1 of 3</p>
      <h1 className="display-lg mt-2">
        Create your <span className="text-grad">identity</span>
      </h1>
      <p className="body-md mt-3 max-w-xl text-body">
        One Ed25519 keypair, generated in this tab. No server ever sees the key.
      </p>

      {error ? <div className="mt-6"><Note tone="error">{error}</Note></div> : null}
      {notice ? <div className="mt-6"><Note tone="ok">{notice}</Note></div> : null}

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {/* Create */}
        <Card>
          <div className="flex items-center gap-3">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-[14px] bg-tint-brand text-brand-600">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="8" cy="15" r="4" />
                <path d="M10.8 12.2 20 3M17 6l2 2M14 9l2 2" />
              </svg>
            </span>
            <h2 className="heading-md">New keypair</h2>
          </div>
          <div className="mt-4 space-y-4">
            <Field label="Passphrase" hint={`≥ ${MIN_PASSPHRASE_LENGTH} chars. This is the only way back.`}>
              <TextInput
                type="password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                placeholder="passphrase"
                autoComplete="new-password"
              />
            </Field>
            <Field label="Repeat passphrase">
              <TextInput
                type="password"
                value={pass2}
                onChange={(e) => setPass2(e.target.value)}
                placeholder="repeat"
                autoComplete="new-password"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm text-charcoal">
              <input
                type="checkbox"
                checked={keepInBrowser}
                onChange={(e) => setKeepInBrowser(e.target.checked)}
                className="h-4 w-4 rounded-sm accent-brand-600"
              />
              <span className="caption-sm text-charcoal">Keep encrypted copy here</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-charcoal">
              <input
                type="checkbox"
                checked={keepUnlocked}
                onChange={(e) => setKeepUnlocked(e.target.checked)}
                className="h-4 w-4 rounded-sm accent-brand-600"
              />
              <span className="caption-sm text-charcoal">Stay unlocked on this device</span>
            </label>
            <Button onClick={onCreate} disabled={busy !== null || !!did} className="w-full">
              {busy === "create" ? "Generating…" : did ? "Identity already unlocked" : "Generate & encrypt"}
            </Button>
            {did ? (
              <p className="caption-sm text-body">Lock first to create a different one.</p>
            ) : null}
          </div>
        </Card>

        {/* Master import */}
        <Card>
          <div className="flex items-center gap-3">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-[14px] bg-tint-violet text-violet-600">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 3v12M6 9l6 6 6-6" />
                <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
            </span>
            <h2 className="heading-md">Import from anywhere</h2>
          </div>
          <p className="caption-sm mt-3 text-body">
            Already have a key? Bring it in — any format:
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="rounded-full border border-violet-600/25 bg-tint-violet px-3 py-1 font-mono text-[11px] text-violet-600">floptools JSON</span>
            <span className="rounded-full border border-violet-600/25 bg-tint-violet px-3 py-1 font-mono text-[11px] text-violet-600">identity.pem</span>
            <span className="rounded-full border border-violet-600/25 bg-tint-violet px-3 py-1 font-mono text-[11px] text-violet-600">seed JSON / raw</span>
            <span className="rounded-full border border-violet-600/25 bg-tint-violet px-3 py-1 font-mono text-[11px] text-violet-600">community backups</span>
          </div>
          <div className="mt-4 space-y-4">
            <div className="flex gap-2">
              <button
                type="button"
                className={`rounded-full px-4 py-2 text-sm font-medium ${importMode === "file" ? "grad-brand text-white shadow-soft" : "bg-surface-soft text-ink hover:bg-hairline"}`}
                onClick={() => setImportMode("file")}
              >
                File
              </button>
              <button
                type="button"
                className={`rounded-full px-4 py-2 text-sm font-medium ${importMode === "paste" ? "grad-brand text-white shadow-soft" : "bg-surface-soft text-ink hover:bg-hairline"}`}
                onClick={() => setImportMode("paste")}
              >
                Paste
              </button>
            </div>

            {importMode === "file" ? (
              <div>
                <input
                  ref={fileInput}
                  type="file"
                  className="hidden"
                  accept=".json,.pem,.key,.enc"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onFileChosen(f);
                  }}
                />
                <div className="flex items-center gap-3">
                  <Button variant="secondary" onClick={() => fileInput.current?.click()} className="shrink-0">
                    Choose file
                  </Button>
                  <span className="body-sm font-mono text-body">
                    {importText ? "file loaded" : "none"}
                  </span>
                </div>
              </div>
            ) : (
              <TextArea
                rows={5}
                value={importText}
                onChange={(e) => onPaste(e.target.value)}
                placeholder={"Paste the identity file contents, PEM block, or a 64-char seed…"}
                mono
              />
            )}

            {importDetected ? (
              <div className="rounded-[12px] border border-brand-500/25 bg-tint-brand px-3 py-2.5 text-[13px]">
                <span className="font-medium text-brand-700">{importDetected.detail}</span>
                <span className="text-brand-600/70"> · detected</span>
                {importDetected.did ? (
                  <span className="mt-1 block break-all font-mono text-[12px] text-brand-700/80">{importDetected.did}</span>
                ) : null}
              </div>
            ) : null}

            {importDetected?.needsPassphrase ? (
              <Field label="Passphrase of the source key">
                <TextInput
                  type="password"
                  value={importSourcePass}
                  onChange={(e) => setImportSourcePass(e.target.value)}
                  placeholder="passphrase used by the other tool"
                  autoComplete="current-password"
                />
              </Field>
            ) : null}

            {importDetected && importDetected.kind !== "floptools-encrypted" ? (
              <Field label="New passphrase to store it" hint={`It is re-encrypted into identity.json with this passphrase (≥ ${MIN_PASSPHRASE_LENGTH} chars).`}>
                <TextInput
                  type="password"
                  value={importNewPass}
                  onChange={(e) => setImportNewPass(e.target.value)}
                  placeholder="new passphrase"
                  autoComplete="new-password"
                />
              </Field>
            ) : null}

            <Button
              onClick={doImport}
              disabled={busy !== null || !importDetected || importDetected.kind === "unknown"}
              className="w-full"
            >
              {busy === "import" ? "Importing…" : importDetected?.kind === "floptools-encrypted" ? "Unlock" : "Import & store"}
            </Button>
          </div>
        </Card>
      </div>

      {/* Current identity */}
      {did ? (
        <Card className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-mono text-[15px] font-medium text-ink">
                <span className="pulse-dot h-2 w-2 rounded-full bg-leaf-600" aria-hidden />
                {identityShortName(did)}
              </p>
              <p className="caption-sm mt-0.5 text-mute">
                Unlocked in this session{createdAt ? <> · created <LocalTime value={createdAt} dateOnly /></> : ""}
              </p>
              <div className="mt-1">
                <DidText did={did} prefixChars={24} suffixChars={8} />
              </div>
            </div>
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              <CopyButton value={did} label="Copy DID" className="flex-1 sm:flex-none" />
              <Button variant="secondary" onClick={redownload} className="flex-1 sm:flex-none">Download file</Button>
              <Button variant="secondary" onClick={onLock} className="flex-1 sm:flex-none">Lock</Button>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="heading-md">Share</h2>
          <TerminalCard title="X post" className="mt-3">
            @flop_labs my agent DID is {did ? did : "did:key:z6Mk…"} building on technocore.chat
          </TerminalCard>
          {did ? (
            <div className="mt-3">
              <CopyButton
                value={`@flop_labs my agent DID is ${did} building on technocore.chat`}
                label="Copy post"
              />
            </div>
          ) : (
            <p className="caption-sm mt-3 text-body">Generate a key first.</p>
          )}
        </div>
        <div>
          <h2 className="heading-md">Public / private</h2>
          <div className="mt-3 space-y-2">
            <div className="flex items-start gap-3 rounded-[12px] border border-hairline bg-surface-card p-3.5">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-tint-sky text-sky-600">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18" />
                </svg>
              </span>
              <div>
                <p className="body-sm-strong text-ink">Public</p>
                <p className="caption-sm text-body">The DID. Share it anywhere.</p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-[12px] border border-hairline bg-surface-card p-3.5">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-tint-amber text-amber-600">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="4" y="10" width="16" height="11" rx="2" />
                  <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                </svg>
              </span>
              <div>
                <p className="body-sm-strong text-ink">Private</p>
                <p className="caption-sm text-body">File + passphrase. Never upload or commit.</p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-[12px] border border-hairline bg-surface-card p-3.5">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-tint-rose text-rose-600">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </span>
              <div>
                <p className="body-sm-strong text-ink">Never</p>
                <p className="caption-sm text-body">Paste a seed or wallet key. A did:key is not a wallet.</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Note tone="info">
        <strong className="font-medium text-brand-700">One identity forever.</strong> Next:{" "}
        <Link className="text-brand-700 underline underline-offset-2" href="/sign">sign a message →</Link>
      </Note>

      {limitMessage ? (
        <LimitModal message={limitMessage} onClose={() => setLimitMessage(null)} />
      ) : null}
    </div>
  );
}

function downloadFile(file: unknown, name: string): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function trackDid(did: string, detail: string): void {
  void fetch("/api/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "did_created", did, detail }),
  }).catch(() => undefined);
}