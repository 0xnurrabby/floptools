import Link from "next/link";
import { LinkButton } from "@/components/ui";

const NOTS = [
  ["Not an airdrop claimer", "Posting here creates no eligibility by itself."],
  ["Not official software", "Community-made. Only @flop_labs / flop.finance are official."],
  ["Not a wallet", "A did:key is not a wallet key. Never paste a seed anywhere."],
  ["No faucet, no token", "The faucet is closed and $FLOP is not live."],
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
    tint: "border-acc-leaf/30 bg-tint-leaf",
    num: "bg-acc-leaf text-white",
    arrow: "text-acc-leaf",
    lines: [
      "Create DID",
      "or import DID",
    ],
    body: "Your identity is one Ed25519 keypair, made in this tab in seconds. Already have one (identity.pem, any backup)? Import it — same result.",
  },
  {
    n: "2",
    title: "Activity",
    href: "/activity",
    tint: "border-acc-sky/30 bg-tint-sky",
    num: "bg-acc-sky text-white",
    arrow: "text-acc-sky",
    lines: ["Templates", "→ Scroll / pick one", "→ Sign & publish", "DID note too"],
    body: "Pick a check-in template, sign & publish it, then publish your DID note. That is what keeps your identity visible on the network.",
  },
  {
    n: "3",
    title: "Check",
    href: "/check",
    tint: "border-acc-amber/30 bg-tint-amber",
    num: "bg-acc-amber text-white",
    arrow: "text-acc-amber",
    lines: ["Check your DID", "for setup status"],
    body: "Paste your did:key. See green or red: note on ledger? key ever signed? If something is red, the card tells you exactly what to fix.",
  },
] as const;

export default function Home() {
  return (
    <div className="mx-auto max-w-4xl px-4">
      {/* Hero */}
      <section className="flex flex-col items-center pt-20 pb-14 text-center">
        <h1 className="display-xl max-w-xl">
          One DID. Kept alive.
        </h1>
        <p className="body-md mt-4 max-w-lg text-body">
          Create one encrypted did:key in this tab, sign messages to
          Technocore, stay active until the Flop testnet.
        </p>

        <div className="mt-7 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
          <LinkButton href="/create" variant="primary" className="w-full sm:w-auto">
            Create your DID
          </LinkButton>
          <LinkButton href="/docs" className="w-full sm:w-auto">How it works</LinkButton>
        </div>

        <p className="caption-sm mt-5 text-mute">
          Unofficial · not affiliated · keys never leave your device
        </p>
      </section>

      {/* The 1-2-3 keep-alive flow */}
      <section aria-label="Keep your identity alive" className="mt-4">
        <div className="rounded-[12px] border border-acc-leaf/30 bg-tint-leaf px-5 py-4 text-center">
          <p className="heading-sm text-ink">
            Just do these <span className="font-semibold text-acc-leaf">3 steps</span> every{" "}
            <span className="font-semibold text-acc-leaf">1–3 days</span> to stay active
            before testnet and airdrop tasks.
          </p>
        </div>

        <div className="mt-5 flex flex-col items-stretch gap-3 lg:flex-row lg:items-center">
          {STEPS.map((s, i) => (
            <span key={s.n} className="contents">
              <Link
                href={s.href}
                className={`flex flex-1 flex-col rounded-[12px] border p-5 transition-transform hover:-translate-y-0.5 ${s.tint}`}
              >
                <span className={`flex h-7 w-7 items-center justify-center rounded-full font-mono text-[13px] ${s.num}`}>
                  {s.n}
                </span>
                <h3 className="heading-sm mt-3 text-ink">{s.title}</h3>
                <div className="mt-2 space-y-0.5 font-mono text-[13px] text-ink">
                  {s.lines.map((l) => (
                    <p key={l}>{l}</p>
                  ))}
                </div>
                <p className="caption-sm mt-3 text-charcoal">{s.body}</p>
              </Link>
              {i < STEPS.length - 1 ? (
                <span
                  className={`self-center px-1 font-mono text-2xl ${s.arrow} rotate-90 lg:rotate-0`}
                  aria-hidden
                >
                  →
                </span>
              ) : null}
            </span>
          ))}
        </div>

        <p className="mt-4 text-center caption-sm text-body">
          No promises, no guarantees — the ask is simple: keep{" "}
          <span className="font-mono font-medium text-ink">one</span> identity
          consistent and honest. That is what a community remembers.
        </p>
      </section>

      {/* Terminal — the design's single "product preview" */}
      <section aria-label="The loop" className="mt-14">
        <div className="overflow-hidden rounded-[12px] border border-hairline bg-canvas">
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
            sign <span className="text-ink">room|nonce|swept-text</span> → say-signed → seq
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
        <div className="mt-4 grid gap-2 sm:grid-cols-4">
          {NOTS.map(([title, body]) => (
            <div key={title} className="rounded-[12px] border border-hairline bg-surface-soft p-4">
              <p className="body-sm-strong text-ink">{title}</p>
              <p className="caption-sm mt-1 text-body">{body}</p>
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
              className="body-sm rounded-full border border-hairline bg-canvas px-4 py-2 text-ink transition-colors hover:bg-surface-soft"
            >
              {label}
            </a>
          ))}
        </div>
      </section>

      {/* Dark strip — the single inverted moment */}
      <section className="pt-14">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-[12px] bg-surface-dark px-6 py-6 text-on-dark">
          <div>
            <p className="heading-md">One identity. Forever.</p>
            <p className="body-sm mt-1 text-on-dark-mute">
              Don&apos;t farm a dozen DIDs. Pick one key and keep it.
            </p>
          </div>
          <LinkButton href="/create" variant="on-dark">
            Start
          </LinkButton>
        </div>
      </section>
    </div>
  );
}