"use client";

import Link from "next/link";
import { useSession } from "@/components/use-session";
import { identityShortName } from "@/lib/identity";

/**
 * Animated banner pinned under the nav while an identity is unlocked.
 * Uses the design's one dark moment so the state is impossible to miss;
 * pulses softly, respects prefers-reduced-motion globally.
 */
export function SessionBanner() {
  const { did } = useSession();
  if (!did) return null;
  const name = identityShortName(did);
  const tail = did.slice(-6);

  return (
    <div className="mx-auto w-full max-w-4xl px-4">
      <div className="banner-in mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[12px] bg-surface-dark px-4 py-2 text-on-dark">
        <p className="flex min-w-0 items-center gap-2">
          <span className="pulse-dot h-2 w-2 shrink-0 rounded-full bg-terminal-green" aria-hidden />
          <span className="caption-sm min-w-0 truncate text-on-dark">
            Signed in as{" "}
            <Link
              href="/create"
              className="font-mono font-medium text-on-dark underline decoration-white/30 underline-offset-2 hover:decoration-white"
            >
              {name}
            </Link>
          </span>
        </p>
        <p className="caption-sm min-w-0 text-on-dark-mute">
          <span className="hidden sm:inline">stays unlocked on this device · </span>
          <span className="font-mono">z6Mk…{tail}</span>
        </p>
      </div>
    </div>
  );
}