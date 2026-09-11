import Link from "next/link";
import { LinkButton } from "@/components/ui";

const NOTS = [
  {
    title: "Not an airdrop claimer",
    body: "Posting alone creates no eligibility.",
    icon: "airdrop",
  },
  {
    title: "Not official software",
    body: "Community-made. Only @flop_labs is official.",
    icon: "shield",
  },
  {
    title: "Not a wallet",
    body: "A did:key is not a wallet key.",
    icon: "wallet",
  },
  {
    title: "No faucet, no token",
    body: "The faucet is closed, $FLOP not live.",
    icon: "x",
  },
] as const;

const LINKS = [
  ["API manual (llms.txt)", "https://technocore.chat/llms.txt"],
  ["auth.md", "https://technocore.chat/auth.md"],
  ["patterns.md", "https://technocore.chat/patterns.md"],
  ["Source repo", "https://github.com/flop-labs/technocore-chat"],
  ["flop.finance", "https://flop.finance"],
  ["@flop_labs", "https://x.com/flop_labs"],
] as const;

const STEPS = [
  {
    n: "1",
    title: "Create",
    href: "/create",
    tone: "leaf" as const,
    body: "One keypair, made in this tab.",
    tag: "2 min",
  },
  {
    n: "2",
    title: "Activity",
    href: "/activity",
    tone: "sky" as const,
    body: "Sign check-ins, publish your DID note.",
    tag: "1–3 days",
  },
  {
    n: "3",
    title: "Deal",
    href: "/deal",
    tone: "violet" as const,
    body: "Post a job, accept one — the paper rail.",
    tag: "tclk/1",
  },
  {
    n: "4",
    title: "Check",
    href: "/check",
    tone: "amber" as const,
    body: "See green or red on the ledger.",
    tag: "anytime",
  },
];

const STEP_ICONS = {
  leaf: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 8a9 9 0 1 0-9 9c-3 1-5 1-8 1 3 3 8 4 13 2 3-1.5 4.5-5 4-9.5" />
      <path d="M21 8c-2 4-6 6-10 6" />
    </svg>
  ),
  sky: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  ),
  violet: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 17l-4-4a3 3 0 0 1 0-4l2-2a3 3 0 0 1 4 0l1 1a3 3 0 0 1 0 4l-2 2a3 3 0 0 1-4 0" />
      <path d="M13 7l4 4a3 3 0 0 1 0 4l-2 2a3 3 0 0 1-4 0l-1-1a3 3 0 0 1 0-4l2-2a3 3 0 0 1 4 0" />
    </svg>
  ),
  amber: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
};

const NOT_ICONS = {
  airdrop: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  shield: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z" />
    </svg>
  ),
  wallet: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M16 12h5" />
    </svg>
  ),
  x: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
};

const TILE = {
  leaf: "bg-tint-leaf text-leaf-600 border-leaf-600/25",
  sky: "bg-tint-sky text-sky-600 border-sky-600/25",
  violet: "bg-tint-violet text-violet-600 border-violet-600/25",
  amber: "bg-tint-amber text-amber-600 border-amber-600/25",
};

export default function Home() {
  return (
    <div>
      {/* Hero — the glow runs edge to edge, the copy stays in the page column */}
      <section className="relative overflow-hidden pt-16 pb-12 sm:pt-20">
        <div className="hero-glow left-1/2 top-[-140px] h-80 w-[95vw] max-w-[1100px] -translate-x-1/2 bg-brand-500/25" aria-hidden />
        <div className="hero-glow left-[3vw] top-20 h-64 w-64 bg-rose-500/15" aria-hidden />
        <div className="hero-glow right-[3vw] top-28 h-60 w-60 bg-violet-600/15" aria-hidden />
        <div className="relative mx-auto max-w-4xl px-4 text-center">
          <h1 className="display-xl mx-auto max-w-xl">
            One DID. <span className="text-grad">Kept alive.</span>
          </h1>
          <p className="body-md mx-auto mt-4 max-w-lg text-body">
            Create an encrypted did:key in this tab, sign on Technocore,
            stay active until the Flop testnet.
          </p>

          <div className="mx-auto mt-7 flex w-full max-w-md flex-col items-center gap-3 sm:max-w-none sm:w-auto sm:flex-row sm:justify-center">
            <LinkButton href="/create" variant="primary" className="w-full sm:w-auto">
              Create your DID
            </LinkButton>
            <LinkButton href="/docs" className="w-full sm:w-auto">How it works</LinkButton>
          </div>

          <p className="caption-sm mt-5 text-mute">
            Unofficial · not affiliated · keys never leave your device
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-4xl px-4">
      {/* The 1-2-3 keep-alive flow */}
      <section aria-label="Keep your identity alive" className="mt-2">
        <div className="flex flex-col items-stretch gap-3 lg:flex-row">
          {STEPS.map((s, i) => (
            <span key={s.n} className="contents">
              <Link
                href={s.href}
                className={`group flex flex-1 flex-col rounded-[16px] border p-5 transition-all hover:-translate-y-1 hover:shadow-soft ${TILE[s.tone]}`}
              >
                <span className="flex items-center justify-between">
                  <span className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-white/70 shadow-soft">
                    {STEP_ICONS[s.tone]}
                  </span>
                  <span className="rounded-full border border-ink/10 bg-white/60 px-2.5 py-0.5 font-mono text-[11px] opacity-70">
                    {s.tag}
                  </span>
                </span>
                <h3 className="heading-sm mt-4 text-ink">{s.title}</h3>
                <p className="caption-sm mt-1 text-charcoal">{s.body}</p>
                <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-semibold text-ink opacity-60 transition-opacity group-hover:opacity-100">
                  Open
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </span>
              </Link>
              {i < STEPS.length - 1 ? (
                <span className="self-center px-1 font-mono text-2xl text-brand-500/60" aria-hidden>
                  →
                </span>
              ) : null}
            </span>
          ))}
        </div>

        <p className="mt-4 text-center caption-sm text-body">
          Keep <span className="font-mono font-medium text-ink">one</span> identity
          consistent and honest — that is what a community remembers.
        </p>
      </section>

      {/* Terminal — the design's single "product preview" */}
      <section aria-label="The loop" className="mt-14">
        <div className="overflow-hidden rounded-[16px] border border-hairline bg-canvas">
          <div className="flex items-center gap-2 border-b border-hairline bg-surface-soft px-4 py-2.5">
            <span className="traffic-light traffic-red" aria-hidden />
            <span className="traffic-light traffic-yellow" aria-hidden />
            <span className="traffic-light traffic-green" aria-hidden />
            <span className="caption-sm ml-1 font-mono text-mute">floptools — the loop</span>
          </div>
          <div className="code-sm overflow-x-auto whitespace-pre-wrap break-all p-6 text-ink">
            <span className="text-mute"># 1 create</span>
            {"\n"}
            did:key:z6Mk…  <span className="text-mute">← Ed25519, in-browser, passphrase-encrypted</span>
            {"\n\n"}
            <span className="text-mute"># 2 publish</span>
            {"\n"}
            sign <span className="text-brand-600">room|nonce|swept-text</span> → say-signed → seq
            {"\n\n"}
            <span className="text-mute"># 3 stay active</span>
            {"\n"}
            same key · signed updates · DID note · /check verifies
          </div>
        </div>
      </section>

      {/* What it is not */}
      <section className="pt-14">
        <h2 className="heading-lg">What this is not</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {NOTS.map((n) => (
            <div key={n.title} className="rounded-[16px] border border-hairline bg-surface-card p-4">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-[12px] bg-surface-soft text-body">
                {NOT_ICONS[n.icon]}
              </span>
              <p className="body-sm-strong mt-3 text-ink">{n.title}</p>
              <p className="caption-sm mt-1 text-body">{n.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Official sources */}
      <section className="pt-14">
        <h2 className="heading-lg">Official sources</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          {LINKS.map(([label, href]) => (
            <a
              key={href}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="body-sm rounded-full border border-hairline bg-canvas px-4 py-2 text-ink transition-colors hover:border-brand-500/40 hover:bg-tint-brand hover:text-brand-700"
            >
              {label}
            </a>
          ))}
        </div>
      </section>

      {/* Dark strip — the single inverted moment */}
      <section className="pt-14">
        <div className="grad-brand flex flex-wrap items-center justify-between gap-4 rounded-[16px] px-6 py-6 text-white shadow-soft">
          <div>
            <p className="heading-md">One identity. Forever.</p>
            <p className="body-sm mt-1 text-white/80">
              Don&apos;t farm a dozen DIDs. Pick one key and keep it.
            </p>
          </div>
          <LinkButton href="/create" variant="on-dark">
            Start
          </LinkButton>
        </div>
      </section>
      </div>
    </div>
  );
}
