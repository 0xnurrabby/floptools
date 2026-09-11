import { NextRequest, NextResponse } from "next/server";
import { PRO_COOKIE } from "@/lib/pro-auth";
import { clientIp } from "@/lib/server-ip";
import { recordProEvent } from "@/lib/pro-events";

/** POST /api/pro/lock — closes Pro mode for this browser. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  await recordProEvent(clientIp(req.headers), "lock");
  const res = NextResponse.json({ ok: true, pro: false });
  res.cookies.set(PRO_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return res;
}
