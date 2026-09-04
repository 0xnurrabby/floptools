"use client";

import { useState, useSyncExternalStore } from "react";
import { Button, Card, Spinner, TextInput } from "@/components/ui";
import { useSession } from "@/components/use-session";
import {
  unlockFromFile,
  getStoredIdentitySnapshot,
  subscribeStoredIdentity,
} from "@/lib/keyring";

/**
 * Inline unlock for an identity copy saved in this browser (encrypted).
 * Renders nothing if no stored copy exists or the session is already unlocked.
 * A reload clears the in-memory key by design — this makes the recovery path
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
    <Card className="mb-6">
      <h2 className="heading-md">Identity found in this browser</h2>
      <p className="caption-sm mt-1 text-body">
        An encrypted copy is stored here — unlock with your passphrase. The key
        stays in memory only, so a reload asks again.
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
    </Card>
  );
}