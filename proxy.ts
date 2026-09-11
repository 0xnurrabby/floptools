import { NextRequest, NextResponse } from "next/server";

/**
 * Pro routes. Two jobs, both URL-shaping only — security is unchanged (every
 * limit gate still verifies the signed Pro cookie server-side):
 *
 *  1. `/pro/<feature>` serves the same feature page as `/<feature>` while the
 *     /pro URL stays in the address bar (rewrite). Covers sub-paths too:
 *     /pro/deal/0x…, /pro/trustcore/<did>, /pro/deal/receipt/0x…
 *  2. A browser holding the Pro cookie stays on /pro/* feature URLs, so using
 *     Pro never silently drops back to the normal pages mid-flow.
 */

const FEATURE_ROOTS = new Set(["create", "sign", "activity", "check", "deal", "trustcore"]);

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // /pro itself is the panel page; /proadmin is a different section entirely.
  if (pathname.startsWith("/pro/")) {
    const rest = pathname.slice("/pro".length);
    const url = req.nextUrl.clone();
    url.pathname = rest;
    const res = NextResponse.rewrite(url);
    res.headers.set("x-robots-tag", "noindex");
    return res;
  }

  // Keep Pro browsers inside /pro/* for the feature pages.
  const first = pathname.split("/")[1] ?? "";
  if (FEATURE_ROOTS.has(first) && req.cookies.has("floptools_pro")) {
    const url = req.nextUrl.clone();
    url.pathname = `/pro${pathname}`;
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/pro/:path*",
    "/create/:path*",
    "/sign/:path*",
    "/activity/:path*",
    "/check/:path*",
    "/deal/:path*",
    "/trustcore/:path*",
  ],
};
