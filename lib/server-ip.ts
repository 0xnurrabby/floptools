/**
 * Best-effort client IP from proxy headers. Works behind Vercel/Cloudflare
 * and anywhere else; never trusted for security, only used for stats and
 * coarse rate limits. Domain-independent.
 */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const xri = headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}