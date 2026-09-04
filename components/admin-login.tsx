"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Field, Note, TextInput } from "@/components/ui";

export default function AdminLogin() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Login failed (${res.status}).`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md pt-16">
      <p className="caption-sm text-mute">Restricted area</p>
      <h1 className="display-lg mt-2">Admin sign in</h1>
      <Card className="mt-6">
        <div className="space-y-4">
          <Field label="Password" hint="Set in server environment (ADMIN_PASSWORD).">
            <TextInput
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="admin password"
              autoComplete="current-password"
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              autoFocus
            />
          </Field>
          <Button onClick={submit} disabled={busy || !password} className="w-full">
            {busy ? "Checking…" : "Sign in"}
          </Button>
          {error ? <Note tone="error">{error}</Note> : null}
        </div>
      </Card>
    </div>
  );
}