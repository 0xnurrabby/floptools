"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, Spinner, StatusChip } from "@/components/ui";

const LINKS = [
  { href: "/pro/auto", label: "Auto" },
  { href: "/pro/deal", label: "Deal" },
  { href: "/pro/create", label: "Create" },
  { href: "/pro/sign", label: "Sign" },
  { href: "/pro/activity", label: "Activity" },
  { href: "/pro/trustcore", label: "Trustcore" },
];

export function ProPanel() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const lock = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/pro/lock", { method: "POST" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card dark className="mx-auto max-w-lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="caption-sm text-on-dark/60">floptools · pro</p>
          <h1 className="heading-lg mt-1 text-on-dark">Unlimited mode</h1>
        </div>
        <StatusChip tone="ok">active</StatusChip>
      </div>
      <p className="caption-sm mt-3 text-on-dark/70">
        Every fair-use limit is lifted on this browser: no identity-creation cap, no daily task or AI
        limits, no scan throttles. Limits still apply to everyone else.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-on-dark no-underline transition-colors hover:bg-white/10"
          >
            {l.label}
          </Link>
        ))}
      </div>
      <div className="mt-5">
        <Button variant="secondary" onClick={() => void lock()} disabled={busy}>
          {busy ? <Spinner label="…" /> : "Lock this browser"}
        </Button>
      </div>
    </Card>
  );
}
