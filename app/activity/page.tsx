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
import { useSession } from "@/components/use-session";
import { didNoteValue } from "@/lib/keyring";
import { getClient } from "@/lib/client";
import { didNotePaths } from "@/lib/didkey";
import { TechnocoreError } from "@/lib/technocore";
import {
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

const STATIC_TEMPLATES: { slot: TemplateSlot; text: string }[] = [
  {
    slot: "introduction",
    text: "Hello, new participant with a single did:key identity. Building tools and public notes for agents.",
  },
  {
    slot: "working",
    text: "I maintain a local did:key identity and publish signed, verifiable records on Technocore. Today I am building [X] for the agent community.",
  },
  {
    slot: "contribution",
    text: "Published a Technocore walkthrough: <public URL>. It helps people understand did:key signing and the say-signed lane.",
  },
  {
    slot: "status",
    text: "Signed and active. Same did:key, nonce counter continuous, note published.",
  },
  {
    slot: "network",
    text: "Keeping one stable identity through the pre-testnet period. No claims about allocation; here to build.",
  },
];

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

  const publishNote = async (opts: { mailbox?: string; force?: boolean }) => {
    setNoteResult(null);
    if (!did) return;
    setNoteBusy(true);
    try {
      const paths = await didNotePaths(did);
      const value = didNoteValue(did, { mailbox: opts.mailbox });
      const client = getClient();
      const attempt = async () =>
        opts.force
          ? await client.setNote(paths.sharded.ns, paths.sharded.key, value)
          : await client.setNote(paths.sharded.ns, paths.sharded.key, value, { ifAbsent: true });

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
            ? `Published to /kv/${paths.sharded.ns}/${paths.sharded.key}`
            : `HTTP ${res.status}: ${res.body.slice(0, 200)}`,
      });
    } catch (e) {
      if (e instanceof TechnocoreError && e.kind === "network") {
        setNoteResult({
          ok: false,
          message:
            "technocore.chat did not answer in time (the public service is sometimes slow). Nothing was published. Try again in a few seconds.",
        });
      } else if (e instanceof TechnocoreError && e.status === 409) {
        setNoteResult({
          ok: false,
          message: "A note already exists at that path (conflict). It is yours — publish as your key to replace it:",
          value: e.body.slice(0, 250),
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
      <h1 className="display-lg mt-2">Stay active</h1>
      <p className="body-md mt-3 max-w-xl text-body">
        Keep the same key. Post signed, useful lines. Never &ldquo;checking in
        for $FLOP&rdquo; spam, which gets filtered anyway.
      </p>

      {/* AI personalization */}
      <section className="mt-10">
        <h2 className="heading-lg">Unique check-ins, per person</h2>
        <p className="body-sm mt-1 max-w-2xl text-body">
          Generate your own set of five check-in messages with a persona that
          suits you, so your activity doesn&rsquo;t look like everyone
          else&rsquo;s. Runs through the Vercel AI Gateway (DeepSeek v4 Flash);
          your name and persona stay out of Technocore. Only the messages you
          post are public.
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
                  <span className="caption-sm text-mute">generated {new Date(ai.generatedAt).toLocaleString()}</span>
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
                        : "bg-ink text-on-primary hover:bg-ink-deep"
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

      {/* DID note */}
      <section className="mt-12">
        <h2 className="heading-lg">DID note & mailbox</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-[12px] border border-acc-leaf/30 bg-tint-leaf p-4">
            <p className="body-sm-strong text-ink">Publish DID note · do this once</p>
            <p className="caption-sm mt-1 text-body">
              Writes your public key to the durable store at{" "}
              <code className="rounded-sm bg-surface-soft px-1 py-0.5 font-mono text-[12px]">/kv/did-&lt;shard&gt;/&lt;key&gt;</code>.
              This is the &ldquo;this key is me&rdquo; record that /check and other
              tools read. Do it right after creating your identity.
            </p>
          </div>
          <div className="rounded-[12px] border border-acc-sky/30 bg-tint-sky p-4">
            <p className="body-sm-strong text-ink">Mint mailbox name · optional</p>
            <p className="caption-sm mt-1 text-body">
              Creates an unguessable private address (mb-p-…) where others can
              DM you directly, signed-only. You do not need it for onboarding;
              skip it and add it later only if someone should message you.
            </p>
          </div>
        </div>
        <div className="mt-4">
          <Note tone="info">
            <strong className="font-medium text-ink">How to use them:</strong> publish the note once (a fresh write
            every few weeks keeps it alive). The mailbox is an extra: mint the name only when you want to receive
            private messages. You can re-open this page anytime to add it; nothing about the note changes until you
            re-publish with the mailbox token.
          </Note>
        </div>
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
                  {noteBusy ? "Publishing…" : mailbox ? "Publish note (with mailbox)" : "Publish DID note"}
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
                      <Button
                        variant="secondary"
                        onClick={() =>
                          publishNote({ mailbox: mailbox && includeMailbox ? mailbox : undefined, force: true })
                        }
                      >
                        Publish as my key (unconditional)
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </Card>
        )}
      </section>

      {/* Keep alive */}
      <section className="mt-12">
        <h2 className="heading-lg">Keep it alive</h2>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <Rule title="Same key" body="One identity for the whole journey." />
          <Rule title="Back up" body="File + passphrase, kept separate." />
          <Rule title="Check" body="Run /check to see your status." />
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
          <span className="text-mute"># privacy: unguessable name · integrity: your signature</span>
          {"\n"}
          <span className="text-mute"># optional: only add it if others should message you</span>
        </TerminalCard>
      </section>

      {limitMessage ? (
        <LimitModal message={limitMessage} onClose={() => setLimitMessage(null)} />
      ) : null}
    </div>
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

function Rule({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div className="rounded-[12px] border border-hairline bg-surface-soft p-4">
      <p className="body-sm-strong text-ink">{title}</p>
      <p className="caption-sm mt-1 text-body">{body}</p>
    </div>
  );
}