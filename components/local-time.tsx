"use client";

import { useSyncExternalStore } from "react";

/**
 * Renders a timestamp in the visitor's OWN timezone (the device/browser zone —
 * the same region their IP is in), never the server's. The serverless runtime
 * is UTC, so a server-rendered `toLocaleString()` would paint UTC times; this
 * component shows a stable placeholder on the server and swaps in the real
 * local string after mount. Durations are timezone-independent and never need
 * this.
 */

type DateStyle = "full" | "long" | "medium" | "short";
type TimeStyle = "full" | "long" | "medium" | "short";

const noop = () => () => {};

export function LocalTime({
  value,
  dateStyle = "medium",
  timeStyle = "short",
  dateOnly = false,
  className = "",
}: {
  value: string | number;
  dateStyle?: DateStyle;
  timeStyle?: TimeStyle;
  dateOnly?: boolean;
  className?: string;
}) {
  // true only after hydration: the browser is the only place that knows the
  // visitor's timezone, so the server never renders a wrong local time.
  const mounted = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  return (
    <span className={className} suppressHydrationWarning>
      {mounted ? formatLocal(value, { dateStyle, timeStyle, dateOnly }) : "…"}
    </span>
  );
}

export function formatLocal(
  value: string | number,
  opts: { dateStyle?: DateStyle; timeStyle?: TimeStyle; dateOnly?: boolean } = {},
): string {
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return typeof value === "number" ? String(value) : value;
  try {
    if (opts.dateOnly) {
      return d.toLocaleDateString(undefined, { dateStyle: opts.dateStyle ?? "medium" });
    }
    return d.toLocaleString(undefined, {
      dateStyle: opts.dateStyle ?? "medium",
      timeStyle: opts.timeStyle ?? "short",
    });
  } catch {
    return d.toLocaleString();
  }
}
