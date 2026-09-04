import { NextRequest, NextResponse } from "next/server";
import { checkLimit, registerTask, type LimitKind } from "@/lib/limits";
import { safeExec } from "@/lib/db";
import { clientIp } from "@/lib/server-ip";
import { isValidDid } from "@/lib/didkey";

/**
 * POST /api/limits — fair-use gates used by the client before/at each action.
 *
 *   { kind: "did_create", commit?: boolean }            — IP capped at 5 (30 days)
 *   { kind: "task", did, category, commit?: boolean }   — 2 per identity per day
 *
 * "ai_generate" is enforced inside /api/personalize (it is the only place a
 * generation happens). Import is never limited.
 */

const KINDS = new Set<LimitKind>(["did_create", "task"]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { kind?: string; did?: string; category?: string; commit?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const kind = body.kind as LimitKind;
  if (!KINDS.has(kind)) return NextResponse.json({ ok: false }, { status: 400 });

  const ip = clientIp(req.headers);
  const did = typeof body.did === "string" && isValidDid(body.did) ? body.did : undefined;
  const category =
    typeof body.category === "string" ? body.category.toLowerCase().slice(0, 48) : undefined;

  const commit = body.commit !== false;
  const result = await checkLimit(kind, ip, did, category);

  if (!result.allowed) {
    return NextResponse.json(
      { ok: false, code: result.code, message: result.message },
      { status: 429 },
    );
  }

  if (commit) {
    if (kind === "did_create") {
      // Double-checked against the cap, then record (imports are free and
      // recorded through a different path with no cap).
      const after = await checkLimit("did_create", ip, undefined, undefined);
      if (!after.allowed) {
        return NextResponse.json(
          { ok: false, code: "did_limit", message: after.message },
          { status: 429 },
        );
      }
      if (did) {
        await safeExec(
          "INSERT INTO dids (did, ip) VALUES ($1, $2) ON CONFLICT (did) DO UPDATE SET ip = EXCLUDED.ip WHERE dids.ip IS NULL",
          [did, ip],
        );
        await safeExec("INSERT INTO pageviews (ip, path) VALUES ($1, $2)", [ip, `did:create`]);
      }
    } else if (kind === "task" && did && category) {
      await registerTask(did, category);
    }
  }

  return NextResponse.json({ ok: true, remaining: result.remaining });
}