"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Button, Card, CopyButton, DidText, Field, Note, TextInput, TerminalCard } from "@/components/ui";
import { useSession } from "@/components/use-session";
import {
  createIdentity,
  unlockFromFile,
  lock,
  saveEncryptedIdentity,
  getStoredIdentitySnapshot,
  subscribeStoredIdentity,
  getLastIdentityFile,
} from "@/lib/keyring";
import {
  MIN_PASSPHRASE_LENGTH,
  isIdentityFile,
  DEFAULT_IDENTITY_FILENAME,
  type IdentityFile,
} from "@/lib/identity";

export default function CreatePage() {
  const { did, createdAt } = useSession();
  const [busy, setBusy] = useState<"create" | "unlock" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [keepInBrowser, setKeepInBrowser] = useState(true);

  const [restorePass, setRestorePass] = useState("");
  const [pickedFile, setPickedFile] = useState<IdentityFile | null>(null);
  const [pickedName, setPickedName] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const storedFile = useSyncExternalStore(
    subscribeStoredIdentity,
    () => getStoredIdentitySnapshot(),
    () => null,
  );
  const restoreFile = pickedFile ?? storedFile;
  const fileName = pickedName || (storedFile ? "browser copy" : "none");

  const onFileChosen = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      if (!isIdentityFile(parsed)) throw new Error("not a floptools identity file");
      setPickedFile(parsed);
      setPickedName(file.name);
      setError(null);
    } catch (e) {
      setPickedFile(null);
      setPickedName("");
      setError((e as Error).message);
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
      downloadFile(identity, DEFAULT_IDENTITY_FILENAME);
      if (keepInBrowser) {
        saveEncryptedIdentity(identity);
        setNotice("Created. A copy is saved in this browser (encrypted).");
      } else {
        setNotice("Created. Keep the file and passphrase — they are the only way back.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onRestore = async () => {
    setError(null);
    setNotice(null);
    if (!restoreFile) {
      setError("Choose an identity file first.");
      return;
    }
    setBusy("unlock");
    try {
      await unlockFromFile(restoreFile, restorePass);
      setNotice("Unlocked — the key is in memory only.");
      setRestorePass("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onLock = () => {
    lock();
    setNotice("Locked — key removed from memory.");
  };

  const redownload = () => {
    const file = getLastIdentityFile();
    if (file) downloadFile(file, DEFAULT_IDENTITY_FILENAME);
  };

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
            <Field label="Passphrase" hint={`≥ ${MIN_PASSPHRASE_LENGTH} chars. No recovery — this is the only way back.`}>
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
              Keep encrypted copy here (recommended — unlock with passphrase only)
            </label>
            <Button onClick={onCreate} disabled={busy !== null || !!did} className="w-full">
              {busy === "create" ? "Generating…" : did ? "Identity already unlocked" : "Generate & encrypt"}
            </Button>
            {did ? (
              <p className="caption-sm text-body">Lock first to create a different one.</p>
            ) : null}
          </div>
        </Card>

        {/* Restore */}
        <Card>
          <h2 className="heading-md">Restore from file</h2>
          <div className="mt-4 space-y-4">
            <Field label="Identity file">
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json,.enc"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFileChosen(f);
                }}
              />
              <div className="flex items-center gap-3">
                <Button variant="secondary" onClick={() => fileInput.current?.click()} className="shrink-0">
                  Choose file
                </Button>
                <span className="body-sm font-mono text-body">{fileName || "none"}</span>
              </div>
            </Field>
            <Field label="Passphrase">
              <TextInput
                type="password"
                value={restorePass}
                onChange={(e) => setRestorePass(e.target.value)}
                placeholder="passphrase"
                autoComplete="current-password"
              />
            </Field>
            <Button onClick={onRestore} disabled={busy !== null} className="w-full">
              {busy === "unlock" ? "Unlocking…" : "Unlock"}
            </Button>
          </div>
        </Card>
      </div>

      {/* Current identity */}
      {did ? (
        <Card className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="caption-sm text-mute">
                Unlocked{createdAt ? ` · since ${new Date(createdAt).toLocaleDateString()}` : ""}
              </p>
              <div className="mt-1">
                <DidText did={did} prefixChars={24} suffixChars={8} />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <CopyButton value={did} label="Copy DID" />
              <Button variant="secondary" onClick={redownload}>Download file</Button>
              <Button variant="secondary" onClick={onLock}>Lock</Button>
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
              <span className="font-medium text-ink">Private:</span> file + passphrase. Never upload, never commit to git.
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

function downloadFile(file: IdentityFile, name: string): void {
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