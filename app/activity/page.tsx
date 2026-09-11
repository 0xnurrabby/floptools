"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  Button,
  Card,
  CopyButton,
  Field,
  Note,
  Select,
  Spinner,
  StatusChip,
  TextInput,
  TerminalCard,
} from "@/components/ui";
import { LimitModal } from "@/components/limit-modal";
import { LocalTime } from "@/components/local-time";
import { useSession } from "@/components/use-session";
import { didNoteValue } from "@/lib/keyring";
import { getClient } from "@/lib/client";
import { didNotePaths } from "@/lib/didkey";
import { TechnocoreError } from "@/lib/technocore";
import {
  BUILTIN_TEMPLATES,
  SLOT_META,
  TEMPLATE_SLOTS,
  type GeneratedTemplates,
  type Persona,
  type TemplateSlot,
} from "@/lib/personalize";
import {
  getTemplatesSnapshot,
  subscribeTemplates,
  saveTemplates,
  clearTemplates,
} from "@/lib/templates";
import {
  getUsageSnapshot,
  subscribeUsage,
  markUsed,
  EMPTY_USAGE,
} from "@/lib/task-usage";

const STATIC_TEMPLATES: { slot: TemplateSlot; text: string }[] = TEMPLATE_SLOTS.map((slot) => ({
  slot,
  text: BUILTIN_TEMPLATES[slot],
}));

function randHex(bytes: number): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function ActivityPage() {
  const { did } = useSession();
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteResult, setNoteResult] = useState<{ ok: boolean; message: string; value?: string } | null>(null);
  const [mailbox, setMailbox] = useState<string | null>(null);
  const [includeMailbox, setIncludeMailbox] = useState(false);

  // AI personalization
  const [name, setName] = useState("");
  const [persona, setPersona] = useState<Persona>("surprise");
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  const ai = useSyncExternalStore(
    subscribeTemplates,
    () => getTemplatesSnapshot(),
    () => null,
  );
  const usage = useSyncExternalStore(
    subscribeUsage,
    () => getUsageSnapshot(),
    () => EMPTY_USAGE,
  );

  const list = ai
    ? TEMPLATE_SLOTS.map((slot) => ({ slot, text: ai.templates[slot] }))
    : STATIC_TEMPLATES;

  const generate = async () => {
    setGenError(null);
    setGenBusy(true);
    try {
      const res = await fetch("/api/personalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || undefined, persona, did: did ?? undefined }),
      });
      const payload = (await res.json()) as
        | (GeneratedTemplates & { error?: string; code?: string })
        | { error?: string; code?: string };
      if (!res.ok || !payload || "error" in payload) {
        const err = (payload as { error?: string; code?: string }) ?? {};
        if (res.status === 429 && err.code === "ai_limit") {
          setLimitMessage(err.error ?? "AI limit reached for today.");
        } else if (err.code === "not_configured") {
          setGenError(
            "AI Gateway is not configured on the server. Set AI_GATEWAY_API_KEY in the environment (server-side only) to enable unique check-ins.",
          );
        } else {
          setGenError(err.error ?? "Generation failed, try again.");
        }
        return;
      }
      saveTemplates(payload as GeneratedTemplates);
    } catch {
      setGenError("Generation failed (network). Try again.");
    } finally {
      setGenBusy(false);
    }
  };

  const publishNote = async (opts: { mailbox?: string }) => {
    setNoteResult(null);
    if (!did) return;
    setNoteBusy(true);
    try {
      const paths = await didNotePaths(did);
      const value = didNoteValue(did, { mailbox: opts.mailbox });
      const client = getClient();
      // Publish unconditionally: the first write creates the note, later
      // writes refresh it (same key, same value) and keep it alive. Overwriting
      // your own DID note is exactly the point — never a conflict error.
      const attempt = async () => await client.setNote(paths.sharded.ns, paths.sharded.key, value);

      let res;
      try {
        res = await attempt();
      } catch (e) {
        if (e instanceof TechnocoreError && e.kind === "network") {
          // The public instance is occasionally slow: one transparent retry.
          await new Promise((r) => setTimeout(r, 1200));
          res = await attempt();
        } else {
          throw e;
        }
      }
      setNoteResult({
        ok: res.status >= 200 && res.status < 300,
        message:
          res.status >= 200 && res.status < 300
            ? `DID note published at /kv/${paths.sharded.ns}/${paths.sharded.key} — refreshed if it already existed, so it stays alive.`
            : `HTTP ${res.status}: ${res.body.slice(0, 200)}`,
      });
    } catch (e) {
      if (e instanceof TechnocoreError && e.kind === "network") {
        setNoteResult({
          ok: false,
          message:
            "technocore.chat did not answer in time (the public service is sometimes slow). Nothing was published. Try again in a few seconds.",
        });
      } else if (e instanceof TechnocoreError) {
        const isErrorJson = e.body.startsWith("{");
        let excerpt = e.body.slice(0, 200);
        if (isErrorJson) {
          try {
            const j = JSON.parse(e.body) as { error?: string };
            excerpt = j.error ?? excerpt;
          } catch {
            /* keep raw excerpt */
          }
        }
        setNoteResult({
          ok: false,
          message:
            e.status === 502 || e.status === 0
              ? `technocore.chat did not answer (temporary glitch). Nothing was published; your key is safe. Try again in a few seconds.${excerpt && !isErrorJson ? ` (${excerpt})` : ""}`
              : `Technocore answered HTTP ${e.status}: ${excerpt}`,
        });
      } else {
        setNoteResult({ ok: false, message: (e as Error).message });
      }
    } finally {
      setNoteBusy(false);
    }
  };

  const makeMailbox = () => {
    setMailbox(`mb-p-${randHex(12)}`);
    setIncludeMailbox(true);
  };

  const linkTo = (room: string, text: string, task: string) =>
    `/sign?room=${encodeURIComponent(room)}&text=${encodeURIComponent(text)}&task=${encodeURIComponent(task)}`;

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <p className="caption-sm text-mute">Step 3 of 3</p>
      <h1 className="display-lg mt-2">Stay <span className="text-grad">active</span></h1>
      <p className="body-md mt-3 max-w-xl text-body">
        Same key. Useful, signed lines. Never &ldquo;checking in for $FLOP&rdquo; spam.
      </p>

      {/* The ritual — do these in order, then repeat every 2–3 days */}
      <section className="mt-8">
        <div className="rounded-[16px] border border-hairline bg-surface-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="heading-sm text-ink">Your 1–3 day ritual</h2>
            <span className="caption-sm text-mute">in order · repeat every 2–3 days</span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <RitualStep
              n="1"
              icon="publish"
              tone="bg-acc-leaf text-white"
              tint="bg-tint-leaf border-acc-leaf/30"
              title="Publish DID note"
              body="Once, right now."
            />
            <RitualStep
              n="2"
              icon="sign"
              tone="bg-acc-sky text-white"
              tint="bg-tint-sky border-acc-sky/30"
              title="Sign every check-in"
              body="One tap below each."
              href="#templates"
            />
            <RitualStep
              n="3"
              icon="repeat"
              tone="bg-acc-amber text-white"
              tint="bg-tint-amber border-acc-amber/30"
              title="Repeat in 2–3 days"
              body="Same key, steady presence."
            />
          </div>
        </div>
      </section>

      {/* DID note */}
      <section className="mt-12">
        <h2 className="heading-lg">DID note & mailbox</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="flex gap-3 rounded-[16px] border border-acc-leaf/30 bg-tint-leaf p-4">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-white/70 text-acc-leaf shadow-soft">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 12h13M12 6l6 6-6 6" />
              </svg>
            </span>
            <div>
              <p className="body-sm-strong text-ink">Publish DID note <span className="font-mono text-[11px] text-acc-leaf">· once</span></p>
              <p className="caption-sm mt-1 text-body">
                Writes your public key to{" "}
                <code className="rounded-sm bg-white/60 px-1 py-0.5 font-mono text-[12px]">/kv/did-&lt;shard&gt;/&lt;key&gt;</code>{" "}
                — the &ldquo;this key is me&rdquo; record /check reads.
              </p>
            </div>
          </div>
          <div className="flex gap-3 rounded-[16px] border border-acc-sky/30 bg-tint-sky p-4">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-white/70 text-acc-sky shadow-soft">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 5h16v14H4z" />
                <path d="M4 7l8 6 8-6" />
              </svg>
            </span>
            <div>
              <p className="body-sm-strong text-ink">Mint mailbox name <span className="font-mono text-[11px] text-acc-sky">· optional</span></p>
              <p className="caption-sm mt-1 text-body">
                An unguessable private address for DMs. Skip it — add later if someone should reach you.
              </p>
            </div>
          </div>
        </div>
        <p className="caption-sm mt-3 text-body">
          Publish the note — writing it again refreshes the same record and keeps it alive, so there is
          never a conflict. Re-open this page anytime to add a mailbox.
        </p>
        {!did ? (
          <div className="mt-4">
            <Note tone="warn">
              No identity in memory.{" "}
              <Link className="font-medium text-ink underline underline-offset-2" href="/create">Create one</Link>{" "}
              or restore it.
            </Note>
          </div>
        ) : (
          <Card className="mt-4">
            <div className="flex flex-col gap-4">
              {mailbox ? (
                <Field label="Mailbox token">
                  <TextInput value={mailbox} readOnly mono />
                </Field>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => publishNote({ mailbox: mailbox && includeMailbox ? mailbox : undefined })}
                  disabled={noteBusy || !did}
                >
                  {noteBusy ? "Publishing…" : mailbox ? "Publish / refresh note (with mailbox)" : "Publish / refresh DID note"}
                </Button>
                <Button variant="secondary" onClick={makeMailbox}>Mint mailbox name</Button>
                {mailbox ? (
                  <label className="flex items-center gap-2 text-sm text-charcoal">
                    <input
                      type="checkbox"
                      checked={includeMailbox}
                      onChange={(e) => setIncludeMailbox(e.target.checked)}
                      className="h-4 w-4 rounded-sm accent-ink"
                    />
                    include
                  </label>
                ) : null}
              </div>
              {noteResult ? (
                <div>
                  <Note tone={noteResult.ok ? "ok" : "warn"}>{noteResult.message}</Note>
                  {noteResult.value ? (
                    <pre className="mt-2 overflow-x-auto rounded-[8px] bg-surface-soft p-3 font-mono text-[13px] text-ink">{noteResult.value}</pre>
                  ) : null}
                  {!noteResult.ok ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        onClick={() =>
                          publishNote({ mailbox: mailbox && includeMailbox ? mailbox : undefined })
                        }
                      >
                        Try again
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </Card>
        )}
      </section>

      
      {/* AI personalization */}
      <section className="mt-10">
        <h2 className="heading-lg">Unique check-ins, per person</h2>
        <p className="body-sm mt-1 max-w-2xl text-body">
          Five messages in a persona that suits you — so you don&rsquo;t sound like everyone else.
        </p>
        <Card className="mt-4">
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Your name" hint="Optional. Shown only to you in this tool.">
                <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Suraj" />
              </Field>
              <Field label="Persona">
                <Select value={persona} onChange={(e) => setPersona(e.target.value as Persona)}>
                  <option value="surprise">Surprise me</option>
                  <option value="developer">Developer / builder</option>
                  <option value="creator">Content creator</option>
                  <option value="tester">Tester / QA</option>
                </Select>
              </Field>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <Button onClick={generate} disabled={genBusy} className="w-full sm:w-auto">
                {genBusy ? <Spinner label="Generating…" /> : ai ? "Regenerate" : "Generate unique set"}
              </Button>
              {ai ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="body-sm-strong text-ink">{ai.personaTitle}</span>
                  {ai.name ? <span className="caption-sm text-body">for {ai.name}</span> : null}
                  <span className="caption-sm text-mute">generated <LocalTime value={ai.generatedAt} /></span>
                  <button
                    className="caption-sm rounded-full px-2 py-1 text-body underline underline-offset-2 hover:text-ink"
                    onClick={() => {
                      clearTemplates();
                      setGenError(null);
                    }}
                  >
                    use defaults
                  </button>
                </div>
              ) : null}
            </div>
            {genError ? <Note tone="error">{genError}</Note> : null}
          </div>
        </Card>
      </section>

      {/* Templates */}
      <section id="templates" className="mt-12">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="heading-lg">Check-in templates</h2>
          <span className="caption-sm text-mute">{ai ? "AI-generated" : "built-in"}</span>
        </div>
        <p className="caption-sm mt-1 text-body">Personalize, then sign. They open in the composer.</p>
        <div className="mt-4 space-y-3">
          {list.map(({ slot, text }) => {
            const usedAt = usage[slot] ?? 0;
            return (
              <div
                key={slot}
                className={`flex flex-col gap-3 rounded-[12px] border p-4 sm:flex-row sm:items-center ${
                  usedAt ? "border-acc-leaf/40" : "border-hairline"
                } ${usedAt ? "bg-tint-leaf" : "bg-surface-card"}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="body-sm-strong text-ink">{SLOT_META[slot].label}</span>
                    <code className="rounded-full bg-surface-soft px-2 py-0.5 font-mono text-[12px] text-body">/{SLOT_META[slot].room}</code>
                    {usedAt ? (
                      <StatusChip tone="ok">
                        Used {timeAgo(usedAt)}
                      </StatusChip>
                    ) : null}
                  </div>
                  <p className="body-sm mt-1 text-body">{text}</p>
                </div>
                <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row">
                  <Link
                    href={linkTo(SLOT_META[slot].room, text, slot)}
                    onClick={() => markUsed(slot)}
                    className={`inline-flex h-11 w-full items-center justify-center gap-2 rounded-full px-5 text-sm font-medium sm:h-9 sm:w-auto ${
                      usedAt
                        ? "border border-acc-leaf/40 bg-tint-leaf text-acc-leaf hover:bg-acc-leaf hover:text-white"
                        : "grad-brand text-white shadow-soft hover:brightness-110"
                    }`}
                  >
                    {usedAt ? (
                      <>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                        Used again
                      </>
                    ) : (
                      "Use"
                    )}
                  </Link>
                  <CopyButton value={text} label="Copy" className="w-full sm:w-auto" />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Mailbox anatomy */}
      <section className="mt-12">
        <h2 className="heading-lg">Mailbox, briefly</h2>
        <TerminalCard title="patterns.md §2" className="mt-4">
          note: did:key:z6Mk… mailbox:mb-p-&lt;unguessable&gt;
          {"\n\n"}
          <span className="text-mute"># mb- = signed writes only · p- = never listed</span>
          {"\n"}
          <span className="text-mute"># optional — add it only if others should message you</span>
        </TerminalCard>
      </section>

      {limitMessage ? (
        <LimitModal message={limitMessage} onClose={() => setLimitMessage(null)} />
      ) : null}
    </div>
  );
}

function RitualStep({
  n,
  icon,
  tone,
  tint,
  title,
  body,
  href,
}: {
  n: string;
  icon: "publish" | "sign" | "repeat";
  tone: string;
  tint: string;
  title: string;
  body: string;
  href?: string;
}) {
  const ICONS = {
    publish: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 12h13M12 6l6 6-6 6" />
      </svg>
    ),
    sign: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    ),
    repeat: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M17 2l4 4-4 4" />
        <path d="M3 11V9a4 4 0 0 1 4-4h14" />
        <path d="M7 22l-4-4 4-4" />
        <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      </svg>
    ),
  } as const;
  const inner = (
    <>
      <span className="flex items-center justify-between">
        <span className={`flex h-10 w-10 items-center justify-center rounded-[12px] shadow-soft ${tone}`}>
          {ICONS[icon]}
        </span>
        <span className={`font-mono text-[12px] font-semibold ${tone.replace("bg-", "text-")}`}>STEP {n}</span>
      </span>
      <p className="body-sm-strong mt-3 text-ink">{title}</p>
      <p className="caption-sm mt-1 text-body">{body}</p>
    </>
  );
  return href ? (
    <a href={href} className={`rounded-[16px] border p-4 transition-all hover:-translate-y-0.5 hover:shadow-soft ${tint}`}>
      {inner}
    </a>
  ) : (
    <div className={`rounded-[16px] border p-4 ${tint}`}>{inner}</div>
  );
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.floor(hrs / 24)} d ago`;
}