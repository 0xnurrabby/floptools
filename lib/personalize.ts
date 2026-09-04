/**
 * AI-personalized check-in messages.
 *
 * Pure helpers: persona definitions, prompt construction, and strict
 * parsing/sanitization of the model's JSON output. The API key never appears
 * here — it lives only in the server route (app/api/personalize).
 *
 * Hard output rules (enforced twice: in the prompt AND in sanitize, so the
 * client never renders an em dash or a markdown artifact):
 *  - no em dashes or en dashes (use a plain hyphen, comma or colon)
 *  - no AI-slop buzzwords, no exclamation marks, no hashtags, no emoji
 *  - no rewards/tokens/airdrop/faucet/eligibility talk
 *  - single line, under 200 chars each
 */

export const TEMPLATE_SLOTS = [
  "introduction",
  "working",
  "contribution",
  "status",
  "network",
] as const;

export type TemplateSlot = (typeof TEMPLATE_SLOTS)[number];

export const SLOT_META: Record<TemplateSlot, { label: string; room: string }> = {
  introduction: { label: "Introduction", room: "lobby" },
  working: { label: "What I'm working on", room: "technocore" },
  contribution: { label: "Contribution", room: "technocore" },
  status: { label: "Status", room: "lobby" },
  network: { label: "Network note", room: "flop-network" },
};

export const PERSONAS = [
  "developer",
  "creator",
  "tester",
] as const;

export type Persona = (typeof PERSONAS)[number] | "surprise";

export interface GeneratedTemplates {
  personaTitle: string;
  persona: Persona;
  name?: string;
  templates: Record<TemplateSlot, string>;
  generatedAt: string;
}

const BANNED = [
  "delve",
  "unleash",
  "leverage",
  "foster",
  "realm",
  "journey",
  "seamless",
  "curate",
  "revolutioniz",
  "game-changer",
  "cutting-edge",
  "exciting",
  "unlock",
  "supercharge",
];

const BANNED_HINT =
  "never mention rewards, tokens, airdrops, eligibility, faucets, $FLOP, promises, or allocation";

export function buildPrompt(opts: {
  name?: string;
  persona: Persona;
  variation: number;
}): { system: string; user: string } {
  const who = opts.name?.trim() ? `The operator is ${opts.name.trim()}. ` : "";
  const personaLine = describePersona(opts.persona);

  const system = [
    "You write short check-in messages for a public text chat used by engineers.",
    "Rules: each message is one or two sentences, under 200 characters, specific and grounded in plausible work.",
    "Never use em dashes or en dashes anywhere. Use commas, colons or plain hyphens instead.",
    `Never use these words or phrases: ${BANNED.join(", ")}.`,
    "No exclamation marks. No hashtags. No emoji. No markdown. No bullets. No numbers at the start of a line.",
    "Write like a working practitioner, not a marketer.",
    "Return ONLY a JSON object with these exact keys: persona_title, introduction, working, contribution, status, network.",
    `persona_title is a short credible role, e.g. "Senior systems engineer", "Technical writer for developer tools", "QA automation engineer".`,
    `Hard content boundary: ${BANNED_HINT}.`,
  ].join(" ");

  const user = [
    who + `Write 5 fresh check-in messages. The operator's persona is: ${personaLine}.`,
    "This is variation #" + opts.variation + ": it must not repeat phrases from earlier variations.",
    "Slot guidance: introduction (first post in a room, warm and practical), working (what is being built right now, with one concrete detail such as a tool, protocol, size or number), contribution (something delivered or published, specific), status (a calm progress note), network (a modest line about keeping one stable did:key identity active).",
    "Each message must be distinct, must name a concrete detail, and must sound like real work without boasting.",
    "Never mention rewards, tokens or eligibility.",
  ].join(" ");

  return { system, user };
}

function describePersona(persona: Persona): string {
  switch (persona) {
    case "developer":
      return "a developer who builds small public tools and infrastructure for agent networks, explains things in plain terms, ships and documents";
    case "creator":
      return "a content creator and technical writer who publishes walkthroughs, translations and visual explainers for developer tools";
    case "tester":
      return "a tester and QA automation engineer who hunts bugs, reads error traces and reports what actually happens";
    case "surprise":
      return "pick one credible role that suits the message set (developer, writer, or tester) and stay consistent within the set";
  }
}

export function sanitizeTemplate(text: string): string {
  let out = text;
  // em dash, en dash, horizontal bar, figure dash, two/three-em dashes -> hyphen
  out = out.replace(/[\u2012\u2013\u2014\u2015\u2E3A\u2E3B\uFE58\uFF0D]/g, "-");
  out = out.replace(/[*_`#>]+/g, ""); // markdown marks and bullets
  out = out.replace(/^[-*•·\u2022]\s+/, ""); // leading list bullet
  out = out.replace(/^\[?\s*\d+[.\)]\s*/, ""); // stray "1)" numbering
  out = out.replace(/\s+/g, " ").trim(); // single line
  return out;
}

export function hasSlop(text: string): boolean {
  const lower = text.toLowerCase();
  return BANNED.some((b) => lower.includes(b));
}

const MAX_TEMPLATE_CHARS = 600;

/**
 * Parse the model's reply into a validated GeneratedTemplates-ish payload.
 * Tolerates ```json fenced output and prose around the object. Returns null
 * if the payload cannot be trusted.
 */
export function parseTemplatesResponse(
  raw: string,
  _persona: Persona,
): Pick<GeneratedTemplates, "personaTitle" | "templates"> | null {
  let fenced = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(fenced);
  if (fence) fenced = fence[1].trim();
  const open = fenced.indexOf("{");
  const close = fenced.lastIndexOf("}");
  if (open === -1 || close <= open) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fenced.slice(open, close + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const title = typeof parsed.persona_title === "string" ? sanitizeTemplate(parsed.persona_title) : "";
  if (!title || title.length > 80) return null;

  const templates = {} as Record<TemplateSlot, string>;
  for (const slot of TEMPLATE_SLOTS) {
    const v = parsed[slot];
    if (typeof v !== "string") return null;
    const cleaned = sanitizeTemplate(v);
    if (!cleaned || cleaned.length > MAX_TEMPLATE_CHARS) return null;
    if (hasSlop(cleaned)) return null;
    templates[slot] = cleaned;
  }

  // unique enough: at most one repeated sentence among the set
  const unique = new Set(Object.values(templates));
  if (unique.size < TEMPLATE_SLOTS.length - 1) return null;

  return { personaTitle: title, templates };
}