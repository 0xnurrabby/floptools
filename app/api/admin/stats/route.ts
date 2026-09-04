import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/admin-auth";
import { safeQuery, dbHealthy, lastDbError, type Row } from "@/lib/db";
import { TechnocoreClient } from "@/lib/technocore";
import { didNotePaths } from "@/lib/didkey";

/**
 * GET /api/admin/stats — authenticated dashboard data.
 * Counts live DB numbers plus active/dead DID state from the public ledger
 * (DID note presence; bounded to the newest 60 DIDs, cached 10 minutes so
 * dashboard refreshes never hammer the ledger).
 */

const CACHE_TTL = 10 * 60 * 1000;
const MAX_LEDGER_CHECKS = 60;
const ledgerCache = new Map<string, { active: boolean; at: number }>();
let didListCache: { at: number; dids: Row[] } | null = null;

function isAuthed(req: NextRequest): boolean {
  return verifySessionToken(req.cookies.get(ADMIN_COOKIE)?.value);
}

async function counts(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await safeQuery(sql, params);
  const first = rows?.[0];
  const raw = first?.["n"] ?? first?.["count"] ?? first?.["total"];
  // pg returns COUNT/SUM (int8) as strings — coerce defensively.
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

async function recentDids(): Promise<Row[]> {
  const now = Date.now();
  if (didListCache && now - didListCache.at < CACHE_TTL) return didListCache.dids;
  const rows = (await safeQuery(
    `SELECT d.did, d.ip, d.created_at,
            (SELECT MAX(a.created_at) FROM ai_generations a WHERE a.did = d.did) AS last_generation,
            (SELECT MAX(t.created_at) FROM task_events t WHERE t.did = d.did) AS last_task,
            (SELECT COUNT(*) FROM ai_generations a WHERE a.did = d.did) AS generations,
            (SELECT COALESCE(SUM(a.total_tokens), 0) FROM ai_generations a WHERE a.did = d.did) AS tokens
     FROM dids d ORDER BY d.created_at DESC LIMIT 120`,
  )) ?? [];
  didListCache = { at: now, dids: rows };
  return rows;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthed(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const dbUp = await dbHealthy();
  if (!dbUp) {
    return NextResponse.json({
      ok: true,
      dbError: lastDbError ?? "database unreachable",
      overview: null,
      dids: [],
      topIps: [],
      recent: [],
    });
  }

  const [usersAll, users24, pvAll, pv24, didsAll, dids24, genAll, gen24, tokAll, tok24, genAllRows, didRows, recent, ipRows] =
    await Promise.all([
      counts("SELECT COUNT(DISTINCT ip) AS n FROM pageviews"),
      counts("SELECT COUNT(DISTINCT ip) AS n FROM pageviews WHERE created_at > now() - interval '24 hours'"),
      counts("SELECT COUNT(*) AS n FROM pageviews"),
      counts("SELECT COUNT(*) AS n FROM pageviews WHERE created_at > now() - interval '24 hours'"),
      counts("SELECT COUNT(*) AS n FROM dids"),
      counts("SELECT COUNT(*) AS n FROM dids WHERE created_at > now() - interval '24 hours'"),
      counts("SELECT COUNT(*) AS n FROM ai_generations"),
      counts("SELECT COUNT(*) AS n FROM ai_generations WHERE created_at > now() - interval '24 hours'"),
      counts("SELECT COALESCE(SUM(total_tokens),0) AS n FROM ai_generations"),
      counts("SELECT COALESCE(SUM(total_tokens),0) AS n FROM ai_generations WHERE created_at > now() - interval '24 hours'"),
      safeQuery(
        "SELECT COALESCE(SUM(prompt_tokens),0) AS prompt, COALESCE(SUM(completion_tokens),0) AS completion, COUNT(*) AS n, COALESCE(SUM(total_tokens),0) AS total FROM ai_generations",
      ),
      safeQuery("SELECT ip, COUNT(*) AS n FROM dids GROUP BY ip ORDER BY n DESC LIMIT 12"),
      safeQuery("SELECT ip, path, created_at FROM pageviews ORDER BY id DESC LIMIT 60"),
      safeQuery(
        `SELECT p.ip,
                MAX(p.created_at) AS last_active,
                COUNT(DISTINCT p.id) AS pageviews,
                (SELECT COUNT(*) FROM dids d WHERE d.ip = p.ip) AS dids,
                (SELECT COUNT(*) FROM ai_generations a WHERE a.ip = p.ip) AS ai_gens
         FROM pageviews p GROUP BY p.ip ORDER BY last_active DESC LIMIT 60`,
      ),
    ]);

  const gen = genAllRows?.[0] ?? {};
  const topIps = (didRows ?? []).map((r) => ({
    ip: String(r["ip"] ?? "?"),
    dids: Number(r["n"] ?? 0),
  }));

  // Ledger freshness for the newest DIDs (note presence = durable).
  const dids = (await recentDids()).slice(0, MAX_LEDGER_CHECKS);
  const client = new TechnocoreClient({
    baseUrl: process.env.NEXT_PUBLIC_TECHNOCORE_BASE_URL ?? "https://technocore.chat",
    mode: "direct",
  });
  const now = Date.now();
  const checked: typeof dids = [];
  for (const d of dids) {
    const did = String(d["did"]);
    const cached = ledgerCache.get(did);
    let active = cached && now - cached.at <= CACHE_TTL ? cached.active : null;
    if (active === null) {
      try {
        const paths = await didNotePaths(did);
        const note = await client.readNote(paths.sharded.ns, paths.sharded.key);
        active = note.found;
        if (!active) {
          const legacy = await client.readNote(paths.legacy.ns, paths.legacy.key);
          active = legacy.found;
        }
        // Cache only definitive answers. A transient failure stays "unknown"
        // and is retried on the next refresh, never stored as dead.
        ledgerCache.set(did, { active, at: now });
      } catch {
        active = null; // rate limited / network — unknown, retried later
      }
    }
    checked.push({ ...d, active: active === true });
  }

  const activeCount = checked.filter((d) => d.active === true).length;

  return NextResponse.json({
    ok: true,
    overview: {
      usersAllTime: usersAll,
      users24h: users24,
      pageviewsAllTime: pvAll,
      pageviews24h: pv24,
      didsAllTime: didsAll,
      dids24h: dids24,
      generationsAllTime: genAll,
      generations24h: gen24,
      tokensAllTime: tokAll,
      tokens24h: tok24,
      promptTokens: Number(gen["prompt"] ?? 0),
      completionTokens: Number(gen["completion"] ?? 0),
      generationCalls: Number(gen["n"] ?? 0),
      activeDids: activeCount,
      trackedDids: checked.length,
    },
    dids: checked.map((d) => ({
      did: String(d["did"]),
      ip: String(d["ip"] ?? "?"),
      createdAt: String(d["created_at"] ?? ""),
      lastActive: String(
        d["last_task"] ?? d["last_generation"] ?? d["created_at"] ?? "",
      ),
      generations: Number(d["generations"] ?? 0),
      tokens: Number(d["tokens"] ?? 0),
      active: d.active === true,
    })),
    topIps: (topIps ?? []).map((t) => ({
      ip: t.ip,
      dids: Number(t.dids ?? 0),
    })),
    ipRows: (ipRows ?? []).map((r) => ({
      ip: String(r["ip"] ?? "?"),
      lastActive: String(r["last_active"] ?? ""),
      pageviews: Number(r["pageviews"] ?? 0),
      dids: Number(r["dids"] ?? 0),
      aiGens: Number(r["ai_gens"] ?? 0),
    })),
    recent: (recent ?? []).map((r) => ({
      ip: String(r["ip"] ?? "?"),
      path: String(r["path"] ?? "/"),
      createdAt: String(r["created_at"] ?? ""),
    })),
  });
}