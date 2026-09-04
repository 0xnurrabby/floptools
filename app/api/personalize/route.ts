import { NextRequest, NextResponse } from "next/server";
import {
  buildPrompt,
  parseTemplatesResponse,
  PERSONAS,
  type Persona,
} from "@/lib/personalize";

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

  let upstream: Response;
  try {
    upstream = await fetch(`${GATEWAY_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 1.1,
        max_tokens: 1400,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(45_000),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: "AI Gateway request failed (network). Try again.", code: "gateway_unreachable" },
      { status: 502 },
    );
  }

  const text = await upstream.text();
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
  try {
    const payload = JSON.parse(text) as {
      choices?: { message?: { content?: string } }[];
    };
    content = payload.choices?.[0]?.message?.content ?? "";
  } catch {
    /* fall through */
  }
  if (!content) {
    return NextResponse.json(
      { error: "AI Gateway returned an empty completion.", code: "empty_completion" },
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