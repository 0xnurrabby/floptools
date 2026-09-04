import { NextRequest, NextResponse } from "next/server";

/**
 * Read-only proxy for public Technocore GETs.
 *
 * The public instance (https://technocore.chat) sends no CORS headers, so
 * browser JavaScript cannot read responses from it directly (a simple GET
 * write would still land, but unreadably · see /auth.md). This route forwards
 * public GETs so the UI can show real status, response bodies and seq numbers.
 *
 * Security posture:
 *  - GET only. Never accepts a body, a private key or any secret.
 *  - `?u=` must be a relative path beginning with "/" and is validated to
 *    resolve to the configured Technocore host · no SSRF, no open proxy.
 *  - Responses are cached nowhere and marked no-store.
 */

const BASE = (
  process.env.TECHNOCORE_BASE_URL ??
  process.env.NEXT_PUBLIC_TECHNOCORE_BASE_URL ??
  "https://technocore.chat"
).replace(/\/+$/, "");

export async function GET(req: NextRequest): Promise<NextResponse> {
  const raw = req.nextUrl.searchParams.get("u");
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return NextResponse.json(
      { error: "missing or invalid ?u= upstream path (must start with '/')" },
      { status: 400 },
    );
  }
  if (raw.includes("\\")) {
    return NextResponse.json({ error: "backslashes are not allowed" }, { status: 400 });
  }

  let upstream: URL;
  try {
    upstream = new URL(BASE + raw);
  } catch {
    return NextResponse.json({ error: "could not parse upstream URL" }, { status: 400 });
  }
  const base = new URL(BASE);
  if (upstream.host !== base.host || upstream.protocol !== base.protocol) {
    return NextResponse.json({ error: "host mismatch · proxy is closed" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(upstream.toString(), {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(40000),
      headers: { Accept: "application/json, text/plain;q=0.9" },
    });
  } catch {
    // The public instance is occasionally slow or drops a connection:
    // one transparent retry before giving up.
    try {
      res = await fetch(upstream.toString(), {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(40000),
        headers: { Accept: "application/json, text/plain;q=0.9" },
      });
    } catch (secondError) {
      return NextResponse.json(
        { error: "upstream request failed", detail: (secondError as Error).message.slice(0, 200) },
        { status: 502 },
      );
    }
  }

  const body = await res.text();
  const out = new NextResponse(body, { status: res.status });
  const ct = res.headers.get("content-type");
  if (ct) out.headers.set("content-type", ct);
  out.headers.set("cache-control", "no-store");
  out.headers.set("x-floptools-proxied", "1");
  return out;
}