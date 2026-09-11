import { NextRequest, NextResponse } from "next/server";
import { isProRequest, proConfigured } from "@/lib/pro-auth";

/** GET /api/pro/status — is this browser in Pro mode? (server truth) */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return NextResponse.json({ ok: true, configured: proConfigured(), pro: isProRequest(req) });
}
