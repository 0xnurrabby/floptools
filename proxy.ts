import { NextRequest, NextResponse } from "next/server";

/**
 * Pro routes: `/pro/<feature>` serves the same page as `/<feature>` while the
 * /pro URL stays in the address bar (rewrite). Sub-paths work too:
 * /pro/deal/0x…, /pro/trustcore/<did>, /pro/auto, /pro/bulk-check.
 *
 * There is deliberately NO cross-redirect: being in Pro never hijacks normal
 * paths, and being normal never leaves the Pro section — the mode you are in
 * is the mode you stay in. Limits are cookie-based server-side, so a Pro
 * browser gets unlimited use on normal pages too.
 */

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // /pro itself is the panel page; everything under /pro/… rewrites.
  if (pathname.startsWith("/pro/")) {
    const rest = pathname.slice("/pro".length);
    const url = req.nextUrl.clone();
    url.pathname = rest;
    const res = NextResponse.rewrite(url);
    res.headers.set("x-robots-tag", "noindex");
    return res;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/pro/:path*"],
};
