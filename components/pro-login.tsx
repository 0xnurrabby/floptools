"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Note, Spinner, TextInput } from "@/components/ui";

export function ProLogin({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = async () => {
    if (busy || !passcode.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pro/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: passcode.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Refused (HTTP ${res.status}).`);
        return;
      }
      setPasscode("");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card dark className="mx-auto max-w-md">
      <p className="caption-sm text-on-dark/60">floptools · restricted</p>
      <h1 className="heading-lg mt-1 text-on-dark">Pro access</h1>
      <p className="caption-sm mt-2 text-on-dark/70">
        Enter the passcode to lift the fair-use limits on this browser.
      </p>
      <div className="mt-4 flex flex-col gap-3">
        <TextInput
          type="password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void unlock();
          }}
          placeholder="Passcode"
          autoComplete="off"
          className="border-white/15 bg-white/5 font-mono text-on-dark placeholder:text-on-dark/40"
        />
        <Button onClick={() => void unlock()} disabled={busy || !passcode.trim()} className="w-full">
          {busy ? <Spinner label="Checking…" /> : "Unlock"}
        </Button>
      </div>
      {error ? (
        <div className="mt-3">
          <Note tone="error">{error}</Note>
        </div>
      ) : null}
      {!configured ? (
        <div className="mt-3">
          <Note tone="warn">
            Pro mode is not configured on this server (PRO_PASSCODE is unset).
          </Note>
        </div>
      ) : null}
    </Card>
  );
}
