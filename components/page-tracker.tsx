"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Fires one anonymous pageview per path every 30 minutes (per browser).
 * Purely local: no keys, no user content, no identifiers beyond the server
 * deriving the IP for the admin dashboard.
 */
export function PageTracker() {
  const pathname = usePathname();
  useEffect(() => {
    const KEY = "floptools.pv";
    const now = Date.now();
    let last: Record<string, number> = {};
    try {
      last = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>;
    } catch {
      /* fresh */
    }
    const lastForPath = last[pathname] ?? 0;
    if (now - lastForPath > 30 * 60 * 1000) {
      last[pathname] = now;
      try {
        localStorage.setItem(KEY, JSON.stringify(last));
      } catch {
        /* storage unavailable */
      }
      void fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "pageview", path: pathname }),
      }).catch(() => undefined);
    }
  }, [pathname]);
  return null;
}