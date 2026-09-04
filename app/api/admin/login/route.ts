import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  checkPassword,
  createSessionToken,
  loginBlocked,
  recordLoginAttempt,
  resetLoginAttempts,
} from "@/lib/admin-auth";
import { clientIp } from "@/lib/server-ip";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = clientIp(req.headers);
  if (loginBlocked(ip)) {
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
    recordLoginAttempt(ip);
    return NextResponse.json({ ok: false, error: "Password required." }, { status: 401 });
  }

  if (!checkPassword(candidate)) {
    recordLoginAttempt(ip);
    return NextResponse.json({ ok: false, error: "Wrong password." }, { status: 401 });
  }

  resetLoginAttempts(ip);
  const session = createSessionToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, session.value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: Math.floor(session.expiresInMs / 1000),
  });
  return res;
}