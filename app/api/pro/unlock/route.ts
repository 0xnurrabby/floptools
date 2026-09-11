import { NextRequest, NextResponse } from "next/server";
import {
  PRO_COOKIE,
  checkProPasscode,
  createProToken,
  proConfigured,
  recordUnlockAttempt,
  resetUnlockAttempts,
  unlockBlocked,
} from "@/lib/pro-auth";
import { clientIp } from "@/lib/server-ip";

/**
 * POST /api/pro/unlock  {"passcode":"..."}
 *
 * Opens Pro mode for this browser: the passcode is checked server-side against
 * PRO_PASSCODE (env only), and success sets a signed HttpOnly cookie every
 * limit gate reads. Wrong passcode = 401; too many tries = 429.
 */

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!proConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Pro mode is not configured on the server." },
      { status: 503 },
    );
  }

  const ip = clientIp(req.headers);
  if (unlockBlocked(ip)) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Try again in 15 minutes." },
      { status: 429 },
    );
  }

  let passcode = "";
  try {
    const body = (await req.json()) as { passcode?: unknown };
    passcode = typeof body?.passcode === "string" ? body.passcode : "";
  } catch {
    passcode = "";
  }

  recordUnlockAttempt(ip);
  if (!checkProPasscode(passcode)) {
    return NextResponse.json({ ok: false, error: "Wrong passcode." }, { status: 401 });
  }
  resetUnlockAttempts(ip);

  const { value, expiresInMs } = createProToken();
  const res = NextResponse.json({ ok: true, pro: true });
  res.cookies.set(PRO_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(expiresInMs / 1000),
  });
  return res;
}
