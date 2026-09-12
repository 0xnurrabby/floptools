"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { CopyButton, Note, Spinner, StatusChip } from "@/components/ui";
import { LocalTime } from "@/components/local-time";

interface RegEvent {
  seq: number;
  ts: string;
  role: string;
  requestId: string;
  receipt: "accepted" | "rejected" | "pending";
  reason: string | null;
}

interface BallotEvent {
  entryId: string;
  seq: number;
  ts: string;
  requestId: string;
  status: "accepted" | "rejected" | "pending";
  reason: string | null;
}

interface Voter {
  did: string;
  ballotSeq: number;
  ballotTs: string;
  ballotRequestId: string;
  voteAt: string | null;
  intakeSeq: number | null;
  regSeq: number | null;
  regTs: string | null;
  regRequestId: string | null;
  regRole: string | null;
  regReceipt: "accepted" | "rejected" | "pending" | null;
  regReceiptAt: string | null;
  regToVoteMs: number | null;
  tag: string;
  flags: string[];
  registrations: RegEvent[];
  ballots: BallotEvent[];
}

interface Signal {
  kind: string;
  severity: "high" | "medium" | "info";
  label: string;
  detail: string;
  dids: string[];
}

interface Report {
  ok?: boolean;
  entryId: string;
  gameId: string | null;
  poemRoom: string | null;
  votes: number;
  voters: Voter[];
  words: { word: string; by: string; version: number; ts?: string }[];
  signals: Signal[];
  risk: { score: number; level: "low" | "notable" | "high"; summary: string };
  span: { startMs: number; endMs: number };
  suspect?: { did: string; flags: string[]; hits: number } | null;
  evidence?: {
    clusterVotes: number;
    clusterSecs: number;
    sameTagBallots: number;
    sameTag: string | null;
    regBurstDids: number;
    freshDids: number;
  };
  mentions?: { handle: string; words: number }[];
  generatedAt: string;
}

function msGap(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const m = Math.round(ms / 60_000);
  if (m < 120) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/** Chronological ledger activity for one voter DID. */
function ActivityTimeline({ voter, entryId }: { voter: Voter; entryId: string }) {
  const events = [
    ...voter.registrations.map((r) => ({ kind: "register" as const, seq: r.seq, ts: r.ts, reg: r })),
    ...voter.ballots.map((b) => ({ kind: "ballot" as const, seq: b.seq, ts: b.ts, ballot: b })),
  ].sort((a, b) => a.seq - b.seq);
  if (events.length === 0) {
    return (
      <p className="caption-sm text-mute">
        No registration or ballot events retained for this DID in the current rooms.
      </p>
    );
  }
  return (
    <ol className="space-y-1.5">
      {events.map((e, i) => (
        <li key={i} className="flex flex-wrap items-center gap-2">
          <span className="caption-sm w-[128px] shrink-0 font-mono text-mute">
            <LocalTime value={e.ts} timeStyle="medium" />
          </span>
          {e.kind === "register" ? (
            <>
              <StatusChip
                tone={e.reg.receipt === "accepted" ? "ok" : e.reg.receipt === "rejected" ? "error" : "empty"}
              >
                registration
              </StatusChip>
              <span className="caption-sm text-body">
                role <span className="font-mono">{e.reg.role}</span> · receipt {e.reg.receipt}
                {e.reg.reason ? <span className="text-rose-600"> · {e.reg.reason}</span> : null}
              </span>
            </>
          ) : (
            <>
              <StatusChip
                tone={e.ballot.status === "accepted" ? "ok" : e.ballot.status === "rejected" ? "error" : "empty"}
              >
                ballot
              </StatusChip>
              <span className={`caption-sm ${e.ballot.entryId === entryId ? "font-semibold text-ink" : "text-body"}`}>
                entry <span className="font-mono">{e.ballot.entryId}</span>
                {e.ballot.entryId === entryId ? " · this entry" : ""}
              </span>
              <span className="caption-sm text-mute">
                {e.ballot.status}
                {e.ballot.reason ? ` · ${e.ballot.reason}` : ""}
              </span>
            </>
          )}
          <span className="caption-sm ml-auto font-mono text-mute">seq {e.seq}</span>
        </li>
      ))}
    </ol>
  );
}

const FLAG_LABEL: Record<string, string> = {
  "vote-cluster": "vote burst",
  "same-tag": "shared tag",
  "reg-burst": "batch registration",
  "fresh-did": "rushed DID",
};

/** Pick a readable bucket size for the histogram. */
function niceBucketMs(raw: number): number {
  const steps = [
    1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000,
    3_600_000, 7_200_000, 21_600_000,
  ];
  for (const s of steps) if (raw <= s) return s;
  return 86_400_000;
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

interface Tip {
  pct: number;
  idx: number;
  head: string;
  sub: string;
  flagged: boolean;
}

/**
 * Vote arrivals — fully interactive on mouse and touch. Small sets render one
 * dot per voter; large sets render a time histogram (bucketed) so 700+ votes
 * stay a small, readable chart. Hover/scrub anywhere for exact counts.
 */
function Timeline({ voters, span, signals }: { voters: Voter[]; span: Report["span"]; signals: Signal[] }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const W = 820;
  const H = 230;
  const padTop = 16;
  const padBottom = 30;
  const padX = 10;
  const plotW = W - padX * 2;
  const plotH = H - padTop - padBottom;

  const points = voters
    .map((v) => ({ v, ms: Date.parse(v.voteAt ?? v.ballotTs) }))
    .filter((p) => Number.isFinite(p.ms))
    .sort((a, b) => a.ms - b.ms);
  if (points.length === 0) return null;

  const start = span.startMs - 30_000;
  const end = span.endMs + 30_000;
  const spanMs = Math.max(1, end - start);
  const x = (ms: number) => padX + ((ms - start) / spanMs) * plotW;
  const pctOf = (svgX: number) => Math.min(95, Math.max(5, (svgX / W) * 100));

  const bands: { x1: number; x2: number; high: boolean }[] = [];
  for (const s of signals.filter((s) => s.kind === "vote-cluster")) {
    const ts = points.filter((p) => s.dids.includes(p.v.did)).map((p) => p.ms);
    if (ts.length === 0) continue;
    bands.push({
      x1: x(Math.min(...ts)) - 8,
      x2: x(Math.max(...ts)) + 8,
      high: s.severity === "high",
    });
  }
  const inBand = (ms: number) => bands.some((b) => x(ms) >= b.x1 - 1 && x(ms) <= b.x2 + 1);
  const svgXFromEvent = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * W;
  };

  const ticks = 5;
  const axis = Array.from({ length: ticks }, (_, i) => start + (spanMs * i) / (ticks - 1));

  // Small sets: one dot per voter.
  if (voters.length <= 24) {
    const rowH = 8;
    const dotsH = Math.max(60, voters.length * rowH);
    const y = (i: number) => padTop + (dotsH * (i + 1)) / (voters.length + 1);
    const move = (e: React.PointerEvent<HTMLDivElement>) => {
      const sx = svgXFromEvent(e);
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      points.forEach((p, i) => {
        const d = Math.abs(x(p.ms) - sx);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      const p = points[best]!;
      setTip({
        pct: pctOf(x(p.ms)),
        idx: best,
        head: `identity_${p.v.did.slice(-4)}`,
        sub: new Date(p.ms).toLocaleString(),
        flagged: p.v.flags.includes("vote-cluster") || p.v.flags.includes("same-tag"),
      });
    };
    return (
      <div className="relative touch-pan-y" onPointerMove={move} onPointerDown={move} onPointerLeave={() => setTip(null)}>
        <svg viewBox={`0 0 ${W} ${padTop + dotsH + padBottom}`} className="h-auto w-full text-ink" role="img" aria-label="Vote timeline">
          {axis.map((t, i) => (
            <line key={i} x1={x(t)} y1={padTop} x2={x(t)} y2={padTop + dotsH} stroke="currentColor" strokeOpacity="0.08" />
          ))}
          {bands.map((b, i) => (
            <rect key={i} x={b.x1} y={padTop} width={Math.max(3, b.x2 - b.x1)} height={dotsH} rx="4" fill={b.high ? "#e11d48" : "#f59e0b"} fillOpacity="0.08" />
          ))}
          {tip ? (
            <line x1={x(points[tip.idx]!.ms)} y1={padTop - 4} x2={x(points[tip.idx]!.ms)} y2={padTop + dotsH} stroke="#0b0b0f" strokeOpacity="0.25" strokeDasharray="3 3" />
          ) : null}
          {points.map((p, i) => {
            const flagged = p.v.flags.includes("vote-cluster") || p.v.flags.includes("same-tag");
            const active = tip?.idx === i;
            return (
              <circle
                key={p.v.did}
                cx={x(p.ms)}
                cy={y(i)}
                r={active ? 6 : flagged ? 4.5 : 3.5}
                fill={flagged ? "#e11d48" : "#4f46e5"}
                fillOpacity={tip && !active ? 0.45 : 0.9}
                stroke={active ? "#0b0b0f" : "none"}
                strokeOpacity="0.5"
                strokeWidth="1.5"
              />
            );
          })}
          {axis.map((t, i) => (
            <text key={i} x={x(t)} y={padTop + dotsH + 16} textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity="0.55">
              {fmtClock(t)}
            </text>
          ))}
        </svg>
        {tip ? <ChartTip tip={tip} /> : null}
        <ChartLegend
          items={[
            { color: "#4f46e5", label: "voter" },
            { color: "#e11d48", label: "flagged voter" },
          ]}
          right={`${voters.length} votes · ${fmtClock(span.startMs)} → ${fmtClock(span.endMs)}`}
        />
      </div>
    );
  }

  // Large sets: histogram.
  const bucketMs = niceBucketMs(spanMs / 64);
  const bucketCount = Math.max(1, Math.ceil(spanMs / bucketMs));
  const counts = new Array<number>(bucketCount).fill(0);
  const flaggedBuckets = new Array<boolean>(bucketCount).fill(false);
  for (const p of points) {
    const idx = Math.min(bucketCount - 1, Math.floor((p.ms - start) / bucketMs));
    counts[idx] += 1;
    if (inBand(p.ms)) flaggedBuckets[idx] = true;
  }
  const maxCount = Math.max(1, ...counts);
  const peakIdx = counts.indexOf(maxCount);
  const peakMs = start + peakIdx * bucketMs;
  const barGap = bucketCount > 48 ? 1 : 2;
  const barW = Math.max(1.5, plotW / bucketCount - barGap);
  const h = (n: number) => (Math.sqrt(n / maxCount) * plotH);
  const bucketLabel = bucketMs >= 60_000 ? `${Math.round(bucketMs / 60_000)} min` : `${Math.round(bucketMs / 1000)}s`;

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const sx = svgXFromEvent(e);
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((sx - padX) / (plotW / bucketCount))));
    const a = start + idx * bucketMs;
    const b = Math.min(end, a + bucketMs);
    setTip({
      pct: pctOf(sx),
      idx,
      head: `${counts[idx]} vote${counts[idx] === 1 ? "" : "s"}`,
      sub: `${fmtClock(a)} – ${fmtClock(b)}`,
      flagged: flaggedBuckets[idx],
    });
  };

  return (
    <div className="relative touch-pan-y" onPointerMove={move} onPointerDown={move} onPointerLeave={() => setTip(null)}>
      <svg viewBox={`0 0 ${W} ${padTop + plotH + padBottom}`} className="h-auto w-full text-ink" role="img" aria-label="Vote timeline">
        <defs>
          <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#a78bfa" />
          </linearGradient>
          <linearGradient id="barGradFlag" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e11d48" />
            <stop offset="100%" stopColor="#fb7185" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={padX}
            x2={padX + plotW}
            y1={padTop + plotH * (1 - f)}
            y2={padTop + plotH * (1 - f)}
            stroke="currentColor"
            strokeOpacity="0.07"
          />
        ))}
        {bands.map((b, i) => (
          <rect key={i} x={b.x1} y={padTop - 4} width={Math.max(3, b.x2 - b.x1)} height={plotH + 4} rx="4" fill={b.high ? "#e11d48" : "#f59e0b"} fillOpacity="0.07" />
        ))}
        {tip ? (
          <line
            x1={padX + (tip.idx * plotW) / bucketCount}
            y1={padTop - 6}
            x2={padX + (tip.idx * plotW) / bucketCount}
            y2={padTop + plotH}
            stroke="#0b0b0f"
            strokeOpacity="0.28"
            strokeDasharray="3 3"
          />
        ) : null}
        {counts.map((n, i) => {
          if (n === 0) return null;
          const bx = padX + i * (plotW / bucketCount) + barGap / 2;
          const bh = Math.max(2, h(n));
          const active = tip?.idx === i;
          return (
            <rect
              key={i}
              x={bx}
              y={padTop + plotH - bh}
              width={barW}
              height={bh}
              rx={Math.min(3, barW / 2)}
              fill={flaggedBuckets[i] ? "url(#barGradFlag)" : "url(#barGrad)"}
              fillOpacity={tip && !active ? 0.45 : 0.9}
              stroke={active ? "#0b0b0f" : "none"}
              strokeOpacity="0.4"
              strokeWidth="1"
            />
          );
        })}
        <line x1={padX} x2={padX + plotW} y1={padTop + plotH} y2={padTop + plotH} stroke="currentColor" strokeOpacity="0.18" />
        {axis.map((t, i) => (
          <text key={i} x={x(t)} y={H - 8} textAnchor={i === 0 ? "start" : i === ticks - 1 ? "end" : "middle"} fontSize="10" fill="currentColor" fillOpacity="0.55">
            {fmtClock(t)}
          </text>
        ))}
      </svg>
      {tip ? <ChartTip tip={tip} /> : null}
      <ChartLegend
        items={[
          { color: "#6366f1", label: `votes per ${bucketLabel}` },
          { color: "#e11d48", label: "flagged burst" },
        ]}
        right={`${voters.length} votes · peak ${maxCount} at ${fmtClock(peakMs)}`}
      />
    </div>
  );
}

function ChartTip({ tip }: { tip: Tip }) {
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-[10px] border border-hairline-strong bg-canvas px-3 py-1.5 shadow-lg"
      style={{ left: `${tip.pct}%` }}
    >
      <p className="caption-sm font-semibold text-ink">
        {tip.head}
        {tip.flagged ? <span className="ml-1.5 text-rose-600">flagged</span> : null}
      </p>
      <p className="caption-sm font-mono text-mute">{tip.sub}</p>
    </div>
  );
}

function ChartLegend({ items, right }: { items: { color: string; label: string }[]; right: string }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((it) => (
        <span key={it.label} className="caption-sm flex items-center gap-1.5 text-body">
          <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
      <span className="caption-sm text-mute sm:ml-auto">{right}</span>
    </div>
  );
}

/**
 * The X post. High/notable risk entries get a real expose: the hook, the
 * ledger numbers, the wallet flagged hardest, a fair-play message and the
 * contest writers tagged at the bottom. Clean entries get a short, honest
 * share. No em dashes, no filler.
 */
function buildShareText(report: Report, label: string): string {
  const e = report.evidence;
  const score = report.risk.score;
  const level = report.risk.level;
  const blocks: string[] = [];
  const mentions = (report.mentions ?? []).map((m) => m.handle);
  const mentionBlock = mentions.length
    ? `Writers who put in the work, this concerns you:\n${mentions.join(" ")}`
    : null;

  if (level === "low" || !e || report.votes === 0) {
    blocks.push(
      `Sonnet-2 "${label}" closed with ${report.votes} ballot${report.votes === 1 ? "" : "s"} and coordination risk ${score}/100 (${level}).`,
      "No vote bursts, no shared request tags, no batch registrations. Just writers and readers showing up. This is what a clean, checkable result looks like.",
      "I built floptools.nurlab.xyz solo. Create a DID, register, write, vote. Every ballot lands in public and every entry gets a fairness report like this one.",
    );
  } else {
    const flagWords = report.suspect ? report.suspect.flags.map((f) => FLAG_LABEL[f] ?? f).join(", ") : "";
    const lines = [
      e.sameTagBallots > 1
        ? `- ${e.sameTagBallots} of ${report.votes} counted ballots carried the same request tag`
        : null,
      e.clusterVotes > 1 ? `- ${e.clusterVotes} votes landed inside ${e.clusterSecs} seconds` : null,
      e.regBurstDids > 1 ? `- ${e.regBurstDids} voter DIDs registered back to back before the flood` : null,
      `- coordination risk ${score}/100, level ${level}`,
    ]
      .filter(Boolean)
      .join("\n");
    blocks.push(
      `🚨 ${report.votes} ballots. One script behind ${e.sameTagBallots || e.clusterVotes} of them.`,
      `Sonnet-2 entry "${label}" did not win a fanbase. It got a script.`,
      `Public ledger, right now:\n${lines}`,
      report.suspect
        ? `The wallet this analysis flags hardest: identity_${report.suspect.did.slice(-4)} (${flagWords}). Fresh identity, nothing written, hundreds of "supporters" arriving in lockstep.`
        : `The pattern: fresh identities, nothing written, hundreds of "supporters" arriving in lockstep.`,
      "To every writer who minted a DID, wrote real words and voted with their own hands: you did the work, and farming should not outrank it. Organizers, the receipts are public and they are not subtle. Rule on it.",
      "I built floptools.nurlab.xyz solo. Create a DID, register, write, vote. Every ballot lands in public and every entry gets a fairness report like this one.",
    );
  }
  if (mentionBlock) blocks.push(mentionBlock);
  return blocks.join("\n\n");
}

export function SonnetVoterReport({
  entryId,
  gameId,
  votes,
  onClose,
}: {
  entryId: string;
  gameId: string | null;
  votes: number;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-[18px] border border-hairline bg-canvas p-5 shadow-lg sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <SonnetReportBody entryId={entryId} gameId={gameId} votes={votes} onClose={onClose} />
      </div>
    </div>
  );
}

/** The report itself — used by the dialog and the standalone /sonnet/report page. */
export function SonnetReportBody({
  entryId,
  gameId,
  votes,
  initial = null,
  shareUrl,
  onClose,
}: {
  entryId: string;
  gameId: string | null;
  votes: number;
  initial?: Report | null;
  shareUrl?: string;
  onClose?: () => void;
}) {
  const [report, setReport] = useState<Report | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [url, setUrl] = useState(shareUrl ?? "");

  const toggle = (did: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(did)) next.delete(did);
      else next.add(did);
      return next;
    });

  useEffect(() => {
    if (shareUrl) return;
    void Promise.resolve().then(() => {
      setUrl(`${window.location.origin}/sonnet/report/${encodeURIComponent(entryId)}`);
    });
  }, [entryId, shareUrl]);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    void fetch(`/api/sonnet/entry-votes?entryId=${encodeURIComponent(entryId)}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<Report>)
      .then((d) => {
        if (cancelled) return;
        if (d.ok) setReport(d);
        else setError("Could not build the voter report.");
      })
      .catch(() => {
        if (!cancelled) setError("Could not build the voter report.");
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, initial]);

  const risk = report?.risk;
  const riskTone = risk?.level === "high" ? "error" : risk?.level === "notable" ? "warn" : "ok";
  const shareText = report ? buildShareText(report, gameId ?? entryId) : `Sonnet-2 voters & rug report for ${gameId ?? entryId}`;

  return (
    <>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="caption-sm text-mute">voters & rug report</p>
            <h2 className="heading-md mt-0.5">
              <span className="font-mono">{gameId ?? entryId}</span>{" "}
              <span className="text-mute">· entry {entryId}</span>
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone="ok">{votes} vote{votes === 1 ? "" : "s"}</StatusChip>
            {url ? <CopyButton value={url} label="Copy report link" /> : null}
            {url ? (
              <a
                href={url}
                className="body-sm rounded-full border border-hairline bg-canvas px-3.5 py-2 text-ink transition-colors hover:bg-surface-soft"
              >
                Open page ↗
              </a>
            ) : null}
            {url && report ? (
              <a
                href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(url)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="body-sm rounded-full border border-hairline-strong bg-canvas px-4 py-2 text-ink transition-colors hover:bg-surface-soft"
              >
                Share on X ↗
              </a>
            ) : null}
            {onClose ? (
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-hairline bg-canvas px-3 py-1 text-[12px] text-body hover:bg-surface-soft"
              >
                Close
              </button>
            ) : null}
          </div>
        </div>

        {error ? <div className="mt-4"><Note tone="error">{error}</Note></div> : null}
        {!report && !error ? (
          <div className="mt-8 flex justify-center"><Spinner label="Reading every ballot and registration…" /></div>
        ) : null}

        {report ? (
          <div className="mt-4 space-y-4">
            {/* risk */}
            <div
              className={`rounded-[14px] border p-4 ${
                risk?.level === "high"
                  ? "border-rose-600/25 bg-tint-rose"
                  : risk?.level === "notable"
                    ? "border-amber-600/25 bg-tint-amber"
                    : "border-leaf-600/25 bg-tint-leaf"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="body-sm-strong text-ink">Coordination signals</p>
                <StatusChip tone={riskTone}>
                  {risk?.level === "high" ? "high" : risk?.level === "notable" ? "notable" : "low"} · {risk?.score}/100
                </StatusChip>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/60">
                <div
                  className={`h-full rounded-full ${risk?.level === "high" ? "bg-rose-600" : risk?.level === "notable" ? "bg-amber-600" : "bg-leaf-600"}`}
                  style={{ width: `${Math.max(4, risk?.score ?? 0)}%` }}
                />
              </div>
              <p className="caption-sm mt-2 text-body">{risk?.summary}</p>
            </div>

            {/* timeline */}
            {report.voters.length > 0 ? (
              <div className="rounded-[14px] border border-hairline bg-surface-card p-4 text-ink">
                <p className="body-sm-strong">When the votes landed</p>
                <p className="caption-sm mt-0.5 text-body">
                  Vote arrivals over time; shaded bands are the bursts this report flags. Small sets show one
                  dot per voter, larger sets are bucketed by time.
                </p>
                <div className="mt-2">
                  <Timeline voters={report.voters} span={report.span} signals={report.signals} />
                </div>
              </div>
            ) : null}

            {/* signals */}
            {report.signals.length === 0 ? (
              <Note tone="ok">No coordination signals detected in registration or vote timing.</Note>
            ) : (
              <div className="space-y-2">
                {report.signals.map((s, i) => (
                  <div key={i} className="rounded-[12px] border border-hairline bg-surface-card p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="body-sm-strong text-ink">{s.label}</p>
                      <StatusChip tone={s.severity === "high" ? "error" : s.severity === "medium" ? "warn" : "empty"}>
                        {s.severity}
                      </StatusChip>
                    </div>
                    <p className="caption-sm mt-1 text-body">{s.detail}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {s.dids.map((d) => (
                        <Link
                          key={d}
                          href={`/trustcore/${encodeURIComponent(d)}`}
                          className="rounded-full border border-hairline bg-canvas px-2.5 py-0.5 font-mono text-[11px] text-body hover:border-brand-500/40 hover:text-brand-700"
                          title={d}
                        >
                          …{d.slice(-6)}
                        </Link>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* poem activity */}
            {report.words.length > 0 ? (
              <div className="rounded-[14px] border border-hairline bg-surface-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="body-sm-strong text-ink">Poem activity — who wrote what, when</p>
                  <span className="caption-sm text-mute">
                    {report.words.length} accepted words · {report.poemRoom}
                  </span>
                </div>
                <div className="mt-2 max-h-64 space-y-1 overflow-y-auto pr-1">
                  {report.words.map((w, i) => (
                    <div
                      key={`${w.version}-${i}`}
                      className="flex flex-wrap items-center gap-2 rounded-[8px] border border-hairline bg-canvas px-2.5 py-1 text-[12px]"
                    >
                      <span className="w-8 shrink-0 font-mono text-[11px] text-mute">v{w.version}</span>
                      <Link
                        href={`/trustcore/${encodeURIComponent(w.by)}`}
                        className="w-[86px] shrink-0 font-mono text-[11px] text-body hover:text-brand-700"
                        title={w.by}
                      >
                        …{w.by.slice(-6)}
                      </Link>
                      <span className="font-mono font-medium text-ink">{w.word}</span>
                      {w.ts ? (
                        <span className="caption-sm ml-auto text-mute">
                          <LocalTime value={w.ts} timeStyle="medium" />
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {/* voters table */}
            <div className="rounded-[14px] border border-hairline">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-[12px]">
                  <thead>
                    <tr className="border-b border-hairline bg-surface-soft">
                      <th className="px-3 py-2 font-medium text-mute">Voter DID</th>
                      <th className="px-3 py-2 font-medium text-mute">Registered</th>
                      <th className="px-3 py-2 font-medium text-mute">Receipt</th>
                      <th className="px-3 py-2 font-medium text-mute">Voted</th>
                      <th className="px-3 py-2 font-medium text-mute">Gap</th>
                      <th className="px-3 py-2 font-medium text-mute">Request tag</th>
                      <th className="px-3 py-2 font-medium text-mute">Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.voters.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-3 py-6 text-center text-mute">No counted voters yet.</td>
                      </tr>
                    ) : (
                      report.voters.map((v) => (
                        <Fragment key={v.did}>
                        <tr className="border-b border-hairline last:border-0">
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() => toggle(v.did)}
                              className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-hairline bg-canvas text-[10px] text-body hover:bg-surface-soft"
                              aria-label={expanded.has(v.did) ? "Hide activity" : "Show full activity"}
                            >
                              {expanded.has(v.did) ? "−" : "+"}
                            </button>
                            <Link
                              href={`/trustcore/${encodeURIComponent(v.did)}`}
                              className="font-mono text-ink underline decoration-hairline-strong underline-offset-2 hover:text-brand-700"
                              title={v.did}
                            >
                              identity_{v.did.slice(-4)}
                            </Link>
                          </td>
                          <td className="px-3 py-2 text-body">
                            {v.regTs ? (
                              <>
                                <LocalTime value={v.regTs} timeStyle="medium" />
                                {v.regSeq !== null ? <span className="text-mute"> · seq {v.regSeq}</span> : null}
                              </>
                            ) : (
                              <span className="text-mute">not in retained registrations</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {v.regReceipt ? (
                              <StatusChip tone={v.regReceipt === "accepted" ? "ok" : v.regReceipt === "rejected" ? "error" : "empty"}>
                                {v.regReceipt}
                              </StatusChip>
                            ) : (
                              <span className="text-mute">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-body">
                            <LocalTime value={v.voteAt ?? v.ballotTs} timeStyle="medium" />
                          </td>
                          <td className="px-3 py-2 text-body">{msGap(v.regToVoteMs)}</td>
                          <td className="px-3 py-2">
                            <span className="font-mono text-[11px] text-body">{v.tag || "—"}</span>
                          </td>
                          <td className="px-3 py-2">
                            <span className="flex flex-wrap gap-1">
                              {v.flags.length === 0 ? (
                                <span className="text-mute">none</span>
                              ) : (
                                v.flags.map((f) => (
                                  <span key={f} className="rounded-full bg-tint-amber px-2 py-0.5 text-[10px] font-medium text-amber-600">
                                    {FLAG_LABEL[f] ?? f}
                                  </span>
                                ))
                              )}
                            </span>
                          </td>
                        </tr>
                        {expanded.has(v.did) ? (
                          <tr className="border-b border-hairline bg-canvas/70">
                            <td colSpan={7} className="px-3 py-3">
                              <p className="caption-sm font-medium text-ink">Full activity · identity_{v.did.slice(-4)}</p>
                              <div className="mt-2">
                                <ActivityTimeline voter={v} entryId={entryId} />
                              </div>
                            </td>
                          </tr>
                        ) : null}
                        </Fragment>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <Note tone="info">
              Signals come from public data only: each DID&apos;s registration slot and time, the ballot
              arrival order and the request-id tag the voter&apos;s tool chose. Tight timing can also
              happen in an honest campaign, and one operator may legitimately run several agents — these
              are markers to inspect, not proof. The referee judges conduct cases. Report generated{" "}
              <LocalTime value={report.generatedAt} timeStyle="medium" />.
            </Note>
          </div>
        ) : null}
    </>
  );
}
