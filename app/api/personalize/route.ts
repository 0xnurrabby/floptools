import { NextRequest, NextResponse } from "next/server";
import {
  buildPrompt,
  parseTemplatesResponse,
  PERSONAS,
  type Persona,
} from "@/lib/personalize";
import { safeExec } from "@/lib/db";
import { clientIp } from "@/lib/server-ip";

/**
 * POST /api/personalize
 *
 * Generates five unique check-in messages with a user-specific persona through
 * the Vercel AI Gateway (DeepSeek v4 Flash). Server-side only: the gateway key
 * never appears in the client bundle. Nothing here touches Technocore keys.
 *
 * Input:  { name?: string, persona?: "developer"|"creator"|"tester"|"surprise" }
 * Output: { personaTitle, persona, name? } + templates per slot, or an error
 *         JSON with a stable `code`.
 *
 * Abuse control: small per-IP limiter (each call has a cost) and a response
 * size cap. The client caches the last result locally, so a user rarely calls
 * this twice.
 */

const GATEWAY_BASE = (
  process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1"
).replace(/\/+$/, "");
const MODEL = process.env.AI_GATEWAY_MODEL ?? "deepseek/deepseek-v4-flash";

// Read per-request: process.env reflects the shell environment and hot
// reloads, so a key added without restarting still works once the route
// recompiles. Accept the documented name plus common aliases.
function gatewayKey(): string {
  return (
    process.env.AI_GATEWAY_API_KEY ??
    process.env.VERCEL_AI_GATEWAY_API_KEY ??
    process.env.AI_GATEWAY_KEY ??
    process.env.VERCEL_API_KEY ??
    ""
  );
}

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_IP = 6;
const hits = new Map<string, number[]>();

function limited(ip: string): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_PER_IP) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  return false;
}

function ipOf(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  return (xff ?? "local").split(",")[0]!.trim();
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const KEY = gatewayKey();
  if (!KEY) {
    return NextResponse.json(
      {
        error:
          "AI Gateway key missing on the server. Add AI_GATEWAY_API_KEY=key_... to .env.local, then restart npm run dev.",
        code: "not_configured",
      },
      { status: 503 },
    );
  }
  const ip = ipOf(req);
  if (limited(ip)) {
    return NextResponse.json(
      { error: "Too many generations, try again in a few minutes.", code: "rate_limited" },
      { status: 429 },
    );
  }

  let body: { name?: string; persona?: string };
  try {
    body = (await req.json()) as { name?: string; persona?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body.", code: "bad_request" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.slice(0, 48) : undefined;
  const rawPersona = body.persona ?? "surprise";
  const persona: Persona =
    rawPersona === "surprise" || (PERSONAS as readonly string[]).includes(rawPersona)
      ? (rawPersona as Persona)
      : "surprise";

  const variation = Math.floor(Math.random() * 1_000_000);
  const { system, user } = buildPrompt({ name, persona, variation });

  const callGateway = async (varOffset: number) => {
    const res = await fetch(`${GATEWAY_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${user} Variation counter: ${variation + varOffset}.` },
        ],
        temperature: 1.1,
        max_tokens: 1600,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(45_000),
      cache: "no-store",
    });
    const text = await res.text();
    return { res, text };
  };

  let upstream: Response;
  let text: string;
  try {
    const first = await callGateway(0);
    upstream = first.res;
    text = first.text;
  } catch {
    return NextResponse.json(
      { error: "AI Gateway request failed (network). Try again.", code: "gateway_unreachable" },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    const hint =
      upstream.status === 401 || upstream.status === 403
        ? " The AI Gateway API key was rejected: use a key created under Vercel AI Gateway > API Keys (not a Vercel platform token)."
        : "";
    return NextResponse.json(
      { error: `AI Gateway answered HTTP ${upstream.status}.${hint}`, code: "gateway_error" },
      { status: 502 },
    );
  }

  let content = "";
  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  try {
    const payload = JSON.parse(text) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    content = payload.choices?.[0]?.message?.content ?? "";
    usage = payload.usage;
  } catch {
    /* fall through */
  }

  // Record usage for the admin dashboard (best effort, never blocks).
  await safeExec(
    "INSERT INTO ai_generations (ip, model, prompt_tokens, completion_tokens, total_tokens) VALUES ($1, $2, $3, $4, $5)",
    [
      clientIp(req.headers),
      MODEL,
      Number(usage?.prompt_tokens ?? 0),
      Number(usage?.completion_tokens ?? 0),
      Number(usage?.total_tokens ?? 0),
    ],
  );

  if (!content) {
    // One automatic retry: an empty completion is usually a transient model
    // hiccup, not a configuration problem.
    try {
      const retry = await callGateway(1_000_000);
      if (retry.res.ok) {
        const payload = JSON.parse(retry.text) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        const retryContent = payload.choices?.[0]?.message?.content ?? "";
        if (retryContent) {
          content = retryContent;
          usage = payload.usage;
        }
      }
    } catch {
      /* give up quietly below */
    }
  }
  if (!content) {
    return NextResponse.json(
      { error: "DeepSeek returned nothing usable this time (empty completion). Press Regenerate in a moment.", code: "empty_completion" },
      { status: 502 },
    );
  }

  const parsed = parseTemplatesResponse(content, persona);
  if (!parsed) {
    // Excerpt of the model output helps diagnose shape/truncation issues.
    return NextResponse.json(
      {
        error: "The model output did not match the required structure.",
        code: "unparsable",
        excerpt: content.replace(/\s+/g, " ").slice(0, 240),
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    personaTitle: parsed.personaTitle,
    persona,
    name,
    templates: parsed.templates,
    generatedAt: new Date().toISOString(),
  });
}