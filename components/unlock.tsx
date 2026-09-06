"use client";

import { useState, useSyncExternalStore } from "react";
import { Button, Card, Spinner, TextInput } from "@/components/ui";
import { useSession } from "@/components/use-session";
import {
  unlockFromFile,
  getStoredIdentitySnapshot,
  subscribeStoredIdentity,
} from "@/lib/keyring";
import { identityShortName } from "@/lib/identity";

/**
 * Inline unlock for an identity copy saved in this browser (encrypted).
 * Renders nothing if no stored copy exists or the session is already unlocked.
 * A reload clears the in-memory key by design · this makes the recovery path
 * a single passphrase, no file picker.
 */
export function UnlockIdentity() {
  const { did } = useSession();
  const stored = useSyncExternalStore(
    subscribeStoredIdentity,
    () => getStoredIdentitySnapshot(),
    () => null,
  );
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (did) return null;
  if (!stored) return null;

  const onUnlock = async () => {
    setBusy(true);
    setError(null);
    try {
      await unlockFromFile(stored, pass);
      setPass("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mb-6 border-brand-500/25">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-tint-brand text-brand-600">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="4" y="10" width="16" height="11" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="heading-md">Identity found in this browser</h2>
          <p className="caption-sm mt-1 text-body">
            <span className="font-mono font-medium text-ink">{identityShortName(stored.public.did)}</span>
            {" "}is stored here (encrypted). Enter your passphrase{" "}
            <span className="font-medium text-ink">once</span> — from then on it stays unlocked on this
            device until you Lock or switch identity.
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <TextInput
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder="passphrase"
              autoComplete="current-password"
              onKeyDown={(e) => {
                if (e.key === "Enter") void onUnlock();
              }}
            />
            <Button onClick={onUnlock} disabled={busy || !pass} className="shrink-0">
              {busy ? <Spinner label="Unlocking…" /> : "Unlock"}
            </Button>
          </div>
          {error ? <p className="caption-sm mt-2 text-body">{error}</p> : null}
        </div>
      </div>
    </Card>
  );
}