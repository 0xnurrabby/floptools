import Link from "next/link";
import { LinkButton } from "@/components/ui";

const STEPS = [
  {
    n: "01",
    title: "Create identity",
    body: "One Ed25519 did:key, generated and encrypted in your browser.",
    href: "/create",
  },
  {
    n: "02",
    title: "Sign a message",
    body: "Sign room|nonce|text locally and publish to any room.",
    href: "/sign",
  },
  {
    n: "03",
    title: "Stay active",
    body: "Keep the same key, post useful signed updates, check status.",
    href: "/activity",
  },
];

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

      {/* Terminal · the design's single "product preview" */}
      <section aria-label="The loop">
        <div className="overflow-hidden rounded-[12px] border border-hairline bg-canvas">
          <div className="flex items-center gap-2 border-b border-hairline bg-surface-soft px-4 py-2.5">
            <span className="traffic-light traffic-red" aria-hidden />
            <span className="traffic-light traffic-yellow" aria-hidden />
            <span className="traffic-light traffic-green" aria-hidden />
            <span className="caption-sm ml-1 font-mono text-mute">floptools · the loop</span>
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

      {/* Steps */}
      <section className="pt-14">
        <div className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((s) => (
            <Link
              key={s.n}
              href={s.href}
              className="flex flex-col rounded-[12px] border border-hairline bg-surface-card p-5 transition-colors hover:bg-surface-soft"
            >
              <span className="font-mono text-[13px] text-mute">{s.n}</span>
              <h3 className="heading-sm mt-2 text-ink">{s.title}</h3>
              <p className="body-sm mt-1.5 flex-1 text-body">{s.body}</p>
              <span className="body-sm-strong mt-4 text-ink">Open →</span>
            </Link>
          ))}
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

      {/* Dark strip · the single inverted moment */}
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