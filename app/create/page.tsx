"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Button, Card, CopyButton, DidText, Field, Note, TextArea, TextInput, TerminalCard } from "@/components/ui";
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

  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [keepInBrowser, setKeepInBrowser] = useState(true);

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
        await unlockFromFile(file, importNewPass);
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
        await unlockFromFile(file, importSourcePass);
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
    setBusy("create");
    try {
      const { identity } = await createIdentity(pass);
      const filename = identityFilenameFor(identity.public.did);
      downloadFile(identity, filename);
      void trackDid(identity.public.did, "create");
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
      <h1 className="display-lg mt-2">Create your identity</h1>
      <p className="body-md mt-3 max-w-xl text-body">
        One Ed25519 keypair, generated in this tab. No server ever sees the key.
      </p>

      {error ? <div className="mt-6"><Note tone="error">{error}</Note></div> : null}
      {notice ? <div className="mt-6"><Note tone="ok">{notice}</Note></div> : null}

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {/* Create */}
        <Card>
          <h2 className="heading-md">New keypair</h2>
          <div className="mt-4 space-y-4">
            <Field label="Passphrase" hint={`≥ ${MIN_PASSPHRASE_LENGTH} chars. No recovery: this is the only way back.`}>
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
                className="h-4 w-4 rounded-sm accent-ink"
              />
              Keep encrypted copy here (recommended: unlock with passphrase only)
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
          <h2 className="heading-md">Import from anywhere</h2>
          <p className="caption-sm mt-1 text-body">
            Bring in a did:key from any tool: floptools identity.json, encrypted
            or plain PKCS8 PEM (e.g. identity.pem), community JSON backups
            (cryptotelugu, technocore-work-passport, DID Studio), seed JSON, or
            a raw seed. Sniffed from content, never the extension.
          </p>
          <div className="mt-4 space-y-4">
            <div className="flex gap-2">
              <button
                type="button"
                className={`rounded-full px-4 py-2 text-sm font-medium ${importMode === "file" ? "bg-ink text-on-primary" : "bg-surface-soft text-ink hover:bg-hairline"}`}
                onClick={() => setImportMode("file")}
              >
                File
              </button>
              <button
                type="button"
                className={`rounded-full px-4 py-2 text-sm font-medium ${importMode === "paste" ? "bg-ink text-on-primary" : "bg-surface-soft text-ink hover:bg-hairline"}`}
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
              <div className="rounded-[12px] border border-hairline bg-surface-soft px-3 py-2.5 text-[13px]">
                <span className="font-medium text-ink">{importDetected.detail}</span>
                <span className="text-body"> · detected</span>
                {importDetected.did ? (
                  <span className="mt-1 block break-all font-mono text-[12px] text-charcoal">{importDetected.did}</span>
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
              <p className="font-mono text-[15px] font-medium text-ink">{identityShortName(did)}</p>
              <p className="caption-sm mt-0.5 text-mute">
                Unlocked in this session{createdAt ? ` · created ${new Date(createdAt).toLocaleDateString()}` : ""}
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
          <div className="mt-3 space-y-2 text-[14px] leading-relaxed text-body">
            <p>
              <span className="font-medium text-ink">Public:</span> the DID. Share anywhere.
            </p>
            <p>
              <span className="font-medium text-ink">Private:</span> identity file + passphrase. Never upload, never commit to git.
            </p>
            <p>
              <span className="font-medium text-ink">Never:</span> paste a seed or wallet key into any room. A did:key is not a wallet.
            </p>
          </div>
        </div>
      </div>

      <Note tone="info">
        <strong className="font-medium text-ink">One identity forever.</strong> Next:{" "}
        <Link className="text-ink underline underline-offset-2" href="/sign">sign a message →</Link>
      </Note>
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