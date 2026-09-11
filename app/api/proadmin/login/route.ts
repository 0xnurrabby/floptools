import { NextRequest, NextResponse } from "next/server";
import {
  PROADMIN_COOKIE,
  checkProadminPassword,
  createSessionToken,
  loginBlocked,
  recordLoginAttempt,
  resetLoginAttempts,
} from "@/lib/admin-auth";
import { clientIp } from "@/lib/server-ip";

/**
 * POST /api/proadmin/login — pro admin panel sign in.
 * Same password as /admin by default (PROADMIN_PASSWORD overrides it), but an
 * independent signed cookie (`floptools_proadmin`) and its own rate-limit key.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = clientIp(req.headers);
  const key = `proadmin:${ip}`;
  if (loginBlocked(key)) {
    return NextResponse.json(
      { ok: false, error: "Too many attempts. Try again in 15 minutes." },
      { status: 429 },
    );
  }

  let body: { password?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }
  const candidate = typeof body.password === "string" ? body.password : "";
  if (!candidate) {
    recordLoginAttempt(key);
    return NextResponse.json({ ok: false, error: "Password required." }, { status: 401 });
  }

  if (!checkProadminPassword(candidate)) {
    recordLoginAttempt(key);
    return NextResponse.json({ ok: false, error: "Wrong password." }, { status: 401 });
  }

  resetLoginAttempts(key);
  const session = createSessionToken("proadmin");
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PROADMIN_COOKIE, session.value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: Math.floor(session.expiresInMs / 1000),
  });
  return res;
}
