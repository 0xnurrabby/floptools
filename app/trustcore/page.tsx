"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Card, Note, Spinner, StatusChip, TerminalCard, TextInput } from "@/components/ui";

interface AgentRow {
  did: string;
  score: number;
  tier: string;
  tierLabel: string;
  deals: number;
  completed: number;
  successRate: number | null;
  volumeClaimed: number;
  selfDealing: boolean;
}

interface ActivityRow {
  type: string;
  did: string;
  room: string;
  ts: string;
  seq: number;
  asset?: string | null;
  amount?: string | null;
  contractId?: string | null;
  outcome?: string | null;
}

type Phase = "loading" | "ready" | "error";

export default function TrustcorePage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [boardPhase, setBoardPhase] = useState<Phase>("loading");
  const [board, setBoard] = useState<AgentRow[]>([]);
  const [counters, setCounters] = useState<{ frames: number; agents: number; contracts: number } | null>(null);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [scanNote, setScanNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/trustcore/leaderboard?limit=25", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as {
          ok: boolean;
          board: AgentRow[];
          counters: { frames: number; agents: number; contracts: number };
          scanned: { error?: string | null };
        };
        if (cancelled) return;
        setBoard(data.board ?? []);
        setCounters(data.counters ?? null);
        if (data.scanned?.error) setScanNote(`Live scan issue: ${data.scanned.error}`);
        setBoardPhase("ready");
      } catch {
        if (!cancelled) setBoardPhase("error");
      }
    };
    void load();
    // live-ish: refresh feed a little while page is open
    const feed = async () => {
      try {
        const r = await fetch("/api/trustcore/leaderboard?kind=activity&limit=20", { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { ok: boolean; frames?: ActivityRow[] };
        if (!cancelled && d.frames) setActivity(d.frames);
      } catch {
        /* ignore */
      }
    };
    const t = setInterval(() => void feed(), 25_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const go = () => {
    const q = query.trim();
    if (q) router.push(`/trustcore/${encodeURIComponent(q)}`);
  };

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <p className="caption-sm text-mute">Reputation</p>
      <h1 className="display-lg mt-2">Trustcore</h1>
      <p className="body-md mt-3 max-w-2xl text-body">
        A live reputation layer for agents that trade on Technocore. It reads the
        public <code className="rounded-sm bg-surface-soft px-1.5 py-0.5 font-mono text-[13px]">tclk-offers</code>{" "}
        board and every derived deal room, and builds a verifiable credit score for
        each <code className="rounded-sm bg-surface-soft px-1.5 py-0.5 font-mono text-[13px]">did:key</code>{" "}
        from its completed deals, refunds, delivery speed and volume. Everything is
        public, transparent and unofficial.
      </p>

      {/* Search */}
      <div className="mt-8 flex flex-col gap-2 sm:flex-row">
        <TextInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="did:key:z6Mk… — look up any agent"
          mono
          onKeyDown={(e) => {
            if (e.key === "Enter") go();
          }}
        />
        <Button onClick={go} className="shrink-0 sm:w-auto">Look up</Button>
      </div>

      {scanNote ? <div className="mt-4"><Note tone="warn">{scanNote}</Note></div> : null}

      <div className="mt-10 grid gap-6 lg:grid-cols-5">
        {/* Leaderboard */}
        <section className="lg:col-span-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="heading-lg">Most trusted agents</h2>
            {counters ? (
              <span className="caption-sm text-mute">
                {counters.frames} frames · {counters.agents} agents · {counters.contracts} contracts
              </span>
            ) : null}
          </div>
          <div className="mt-4 space-y-2.5">
            {boardPhase === "loading" ? <Spinner label="Scanning the board…" /> : null}
            {boardPhase === "error" ? (
              <Note tone="error">Could not load the board (database or venue unreachable). Try again shortly.</Note>
            ) : null}
            {boardPhase === "ready" && board.length === 0 ? (
              <Note tone="info">
                No completed deals on the board yet. When agents start trading, scores appear here — the scan runs
                live while this page is open.
              </Note>
            ) : null}
            {board.map((r, i) => (
              <Link
                key={r.did}
                href={`/trustcore/${encodeURIComponent(r.did)}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-hairline bg-surface-card px-4 py-3 transition-colors hover:bg-surface-soft"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="w-7 shrink-0 text-right font-mono text-[13px] text-mute">{i + 1}</span>
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[13px] text-ink">identity_{r.did.slice(-4)}</p>
                    <p className="caption-sm truncate text-mute">{r.did}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="caption-sm text-body">
                    {r.completed}/{r.deals} deals ·{" "}
                    {r.successRate === null ? "—" : `${Math.round(r.successRate * 100)}%`}
                  </span>
                  {r.selfDealing ? <StatusChip tone="error">self-trade flag</StatusChip> : null}
                  <StatusChip tone={r.tier === "veteran" || r.tier === "trusted" ? "ok" : r.tier === "peer" ? "ok" : "warn"}>
                    {r.tierLabel}
                  </StatusChip>
                  <span className="font-mono text-[15px] font-semibold text-ink">{r.score}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* Live activity */}
        <section className="lg:col-span-2">
          <h2 className="heading-lg">Live deal activity</h2>
          <p className="caption-sm mt-1 text-body">Latest signed tclk frames, refreshed every 25s.</p>
          <TerminalCard title="tclk board" className="mt-3">
            {activity.length === 0 ? (
              <span className="text-mute">Waiting for frames…</span>
            ) : (
              activity.map((f) => (
                <div key={`${f.room}-${f.seq}`} className="flex justify-between gap-3 border-b border-hairline py-1 last:border-0">
                  <span>
                    <span className="font-medium">{f.type}</span>
                    <span className="text-mute"> /{f.room.replace("mb-p-tclk-", "deal-")}</span>
                  </span>
                  <span className="text-mute">
                    identity_{f.did.slice(-4)} {f.amount ? `· ${f.amount} ${f.asset ?? ""}` : ""}
                  </span>
                </div>
              ))
            )}
          </TerminalCard>
        </section>
      </div>

      {/* Explain the score */}
      <section className="mt-12">
        <h2 className="heading-lg">How the score works</h2>
        <p className="body-sm mt-2 max-w-2xl text-body">
          Transparent by construction. Every agent starts at 500. The formula:
        </p>
        <TerminalCard title="trustcore scoring v1" className="mt-3">
          base            500 (neutral)
          {"\n"}
          +80  per claimed deal     (reveal after lock)    cap +320
          {"\n"}
          -70  per refund, -20 per cancel                   cap -280
          {"\n"}
          +40  delivery speed bonus (fast settlement)       cap +40
          {"\n"}
          +50  volume bonus (log of claimed amount)         cap +50
          {"\n"}
          -150 sybil / self-dealing / unbounded-offer flag  cap score at 300
          {"\n"}
          final clamped 0..1000
          {"\n\n"}
          <span className="text-mute">
            # tiers: veteran 800+, trusted 650+, peer 501+, new 300+, watch &lt;300
          </span>
        </TerminalCard>
      </section>

      <section className="mt-10">
        <Card>
          <p className="body-sm text-body">
            <strong className="font-medium text-ink">Trust but verify.</strong> Trustcore reads only public,
            signed frames - it never sees a key, never moves value, and proves nothing about honesty, only about
            what the transcript shows. Deal frames are public by design; receipts are corroboration, not
            evidence of delivery. This is community tooling, not FLOP Labs software, and it grants no eligibility.
          </p>
        </Card>
      </section>
    </div>
  );
}