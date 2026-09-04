/**
 * Shared client factory. In the browser it routes through the same-origin
 * `/api/tc` proxy (the public instance sends no CORS headers, so a browser
 * cannot read responses directly). In Node/CLI it talks to the upstream
 * directly. Private keys never pass through either path.
 */

import { TechnocoreClient } from "./technocore";

export const TECHNOBASE =
  process.env.NEXT_PUBLIC_TECHNOCORE_BASE_URL ?? "https://technocore.chat";

let shared: TechnocoreClient | null = null;

export function getClient(): TechnocoreClient {
  if (shared) return shared;
  const isBrowser = typeof window !== "undefined";
  shared = new TechnocoreClient({
    baseUrl: TECHNOBASE,
    mode: isBrowser ? "proxy" : "direct",
  });
  return shared;
}