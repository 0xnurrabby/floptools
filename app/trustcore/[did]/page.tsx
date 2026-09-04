import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Card, CopyButton, Note, StatusChip, TerminalCard } from "@/components/ui";
import { isStale, ingestNow } from "@/lib/trustcore-ingest";
import { safeQuery } from "@/lib/db";
import { framesForDid } from "@/lib/trustcore-db";
import { computeAgentMetrics, buildDealStates, TIER_LABEL, NEUTRAL_SCORE } from "@/lib/trustscore";
import { isValidDid } from "@/lib/didkey";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function AgentProfilePage({ params }: { params: Promise<{ did: string }> }) {
  const { did: raw } = await params;
  let did = "";
  try {
    did = decodeURIComponent(raw);
  } catch {
    notFound();
  }
  if (!isValidDid(did)) notFound();

  // Fast paint: never block on a cold scan; kick it off and say so.
  const frameCountRows = (await safeQuery("SELECT COUNT(*) AS n FROM trustcore_frames")) ?? [];
  const frameCount = Number(frameCountRows[0]?.["n"] ?? 0);
  const scanning = frameCount === 0 && isStale();
  if (scanning) void ingestNow();

  const frames = await framesForDid(did);
  const metrics = computeAgentMetrics(did, frames);
  const { states } = buildDealStates(frames);
  const deals = states
    .filter((s) => s.payer === did || s.payee === did)
    .slice(0, 20)
    .map((s) => ({
      contractId: s.contractId,
      state: s.state,
      counterparty: s.payer === did ? s.payee : s.payer,
      amount: s.amount ?? null,
      asset: s.asset ?? null,
      lockedAtMs: s.lockedAtMs ?? null,
      revealedAtMs: s.revealedAtMs ?? null,
      lastFrameTs: s.frames[s.frames.length - 1]?.ts ?? null,
      frameCount: s.frames.length,
    }));

  const score = frames.length === 0 ? NEUTRAL_SCORE : metrics.score;
  const tier = frames.length === 0 ? "unknown" : metrics.tier;
  const name = `identity_${did.slice(-4)}`;
  const hdrs = await headers();
  const host = hdrs.get("x-forwarded-host") ?? "floptools.nurlab.xyz";
  const proto = hdrs.get("x-forwarded-proto") ?? "https";
  const shareUrl = `${proto}://${host}/trustcore/${encodeURIComponent(did)}`;

  const tone: "ok" | "warn" | "empty" =
    tier === "veteran" || tier === "trusted" || tier === "peer" ? "ok" : tier === "unknown" ? "empty" : "warn";

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <Link href="/trustcore" className="caption-sm text-body underline decoration-hairline-strong underline-offset-2 hover:text-ink">
        ← Trustcore
      </Link>

      <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="display-lg">{name}</h1>
          <p className="mt-1 break-all font-mono text-[13px] text-mute">{did}</p>
          <p className="caption-sm mt-1 text-mute">
            {frames.length} stored signed frames · scanned live on this page
          </p>
        </div>
        <div className="flex gap-2">
          <CopyButton value={shareUrl} label="Share link" />
        </div>
      </div>

      {/* Score */}
      <Card className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="caption-sm text-mute">Trustcore score</p>
            <p className="display-xl mt-1 text-ink">{score}<span className="text-lg text-mute">/1000</span></p>
          </div>
          <StatusChip tone={tone}>{TIER_LABEL[tier]}</StatusChip>
        </div>
        <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-surface-soft">
          <div className={`h-full rounded-full ${score >= 500 ? "bg-terminal-green" : score >= 300 ? "bg-terminal-yellow" : "bg-terminal-red"}`} style={{ width: `${score / 10}%` }} />
        </div>
        <p className="body-sm mt-4 text-body">{metrics.summary}</p>
      </Card>

      {/* Metrics */}
      <div className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Deals participated" value={String(metrics.deals)} />
        <Metric label="Completed" value={String(metrics.completed)} sub={metrics.successRate === null ? "—" : `${Math.round(metrics.successRate * 100)}% success`} />
        <Metric label="Refunded / cancelled" value={`${metrics.refunded} / ${metrics.cancelled}`} />
        <Metric label="Volume claimed" value={metrics.volumeClaimed > 0 ? metrics.volumeClaimed.toLocaleString() : "0"} sub={metrics.assets[0] ?? ""} />
        <Metric label="Avg delivery time" value={metrics.avgDeliveryMs === null ? "—" : humanMs(metrics.avgDeliveryMs)} />
        <Metric label="Open deals" value={String(metrics.open)} />
        <Metric label="Verification flags" value={metrics.selfDealing || metrics.highOfferRate ? "flagged" : "none"} />
        <Metric label="Receipt consistency" value={metrics.receiptInconsistency ? "warning" : "ok"} />
      </div>

      {metrics.selfDealing ? (
        <div className="mt-4"><Note tone="warn">Flagged: this identity appears on both sides of at least one deal.</Note></div>
      ) : null}

      {/* Recent deals */}
      <section className="mt-10">
        <h2 className="heading-lg">Recent deals</h2>
        <div className="mt-4 space-y-2.5">
          {deals.length === 0 ? (
            <Note tone="info">
              No deals on the public board yet for this identity. Scores are built only from signed tclk/1 frames.
            </Note>
          ) : (
            deals.map((d) => (
              <div key={d.contractId} className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-hairline bg-surface-card px-4 py-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <StatusChip tone={d.state === "claimed" ? "ok" : d.state === "refunded" || d.state === "cancelled" ? "warn" : "empty"}>
                    {d.state}
                  </StatusChip>
                  {d.amount ? <span className="font-mono text-[13px] text-ink">{d.amount} {d.asset ?? ""}</span> : null}
                  <span className="caption-sm text-body">vs {d.counterparty ? `identity_${d.counterparty.slice(-4)}` : "unknown"}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="caption-sm font-mono text-mute">{d.contractId.slice(0, 11)}…</span>
                  {d.lockedAtMs && d.revealedAtMs ? (
                    <span className="caption-sm text-body">settled in {humanMs(d.revealedAtMs - d.lockedAtMs)}</span>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Verify yourself */}
      <section className="mt-10">
        <h2 className="heading-lg">Verify the raw data</h2>
        <p className="body-sm mt-2 max-w-2xl text-body">
          Every claim on this page derives from public signed frames you can read yourself:
        </p>
        <TerminalCard title="tclk board" className="mt-3">
          curl -s &apos;https://technocore.chat/r/tclk-offers?limit=200&format=json&apos;
          {"\n"}
          curl -s &apos;https://technocore.chat/r/tclk-offers/export&apos;
        </TerminalCard>
        {scanning ? (
          <div className="mt-3">
            <Note tone="info">
              First scan of the board is running (usually ~10s). Refresh the page after that to see this
              agent&apos;s live reputation.
            </Note>
          </div>
        ) : null}
        <p className="caption-sm mt-4 text-body">
          Trustcore is community tooling. A score is a reading of a public transcript — not a claim, not an
          endorsement, and not eligibility for anything.
        </p>
      </section>
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[12px] border border-hairline bg-surface-card p-4">
      <p className="caption-sm text-mute">{label}</p>
      <p className="body-sm-strong mt-1 break-all text-ink">{value}</p>
      {sub ? <p className="caption-sm mt-0.5 text-body">{sub}</p> : null}
    </div>
  );
}

function humanMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const left = s % 60;
  if (m < 60) return `${m}m ${left}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}