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
    <div className="banner-in border-b border-surface-dark bg-surface-dark text-on-dark">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-2">
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-2">
            <span className="pulse-dot h-2 w-2 shrink-0 rounded-full bg-terminal-green" aria-hidden />
            <span className="caption-sm text-on-dark">
              Signed in as{" "}
              <Link
                href="/create"
                className="font-mono font-medium text-on-dark underline decoration-white/30 underline-offset-2 hover:decoration-white"
              >
                {name}
              </Link>
            </span>
          </p>
        </div>
        <p className="caption-sm min-w-0 shrink-0 text-on-dark-mute sm:shrink">
          <span className="hidden sm:inline">key in memory only · </span>
          <span className="font-mono">z6Mk…{tail}</span>
        </p>
      </div>
    </div>
  );
}