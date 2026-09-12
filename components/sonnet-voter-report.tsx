"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { Note, Spinner, StatusChip } from "@/components/ui";
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
  ok: boolean;
  entryId: string;
  gameId: string | null;
  poemRoom: string | null;
  votes: number;
  voters: Voter[];
  words: { word: string; by: string; version: number; ts?: string }[];
  signals: Signal[];
  risk: { score: number; level: "low" | "notable" | "high"; summary: string };
  span: { startMs: number; endMs: number };
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

/** Time-vs-voter scatter: tight runs show up as vertical stacks. */
function Timeline({ voters, span, signals }: { voters: Voter[]; span: Report["span"]; signals: Signal[] }) {
  const W = 780;
  const rowH = 15;
  const padTop = 22;
  const H = padTop + Math.max(1, voters.length) * rowH + 6;
  const start = span.startMs - 60_000;
  const end = span.endMs + 60_000;
  const spanMs = Math.max(1, end - start);
  const x = (ms: number) => ((ms - start) / spanMs) * W;
  const y = (i: number) => padTop + i * rowH + rowH / 2;

  const clusterRanges: { x1: number; x2: number; high: boolean }[] = [];
  for (const s of signals.filter((s) => s.kind === "vote-cluster")) {
    const times = voters
      .filter((v) => s.dids.includes(v.did) && v.voteAt)
      .map((v) => Date.parse(v.voteAt!))
      .filter((n) => Number.isFinite(n));
    if (times.length === 0) continue;
    clusterRanges.push({
      x1: x(Math.min(...times)) - 6,
      x2: x(Math.max(...times)) + 6,
      high: s.severity === "high",
    });
  }

  const ticks = 5;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Vote timeline">
      {Array.from({ length: ticks }, (_, i) => {
        const t = start + (spanMs * i) / (ticks - 1);
        const gx = x(t);
        return (
          <g key={i}>
            <line x1={gx} y1={padTop - 6} x2={gx} y2={H - 2} stroke="currentColor" strokeOpacity="0.12" strokeWidth="1" />
            <text x={gx} y={12} textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity="0.5">
              {new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </text>
          </g>
        );
      })}
      {clusterRanges.map((c, i) => (
        <rect
          key={i}
          x={c.x1}
          y={padTop - 6}
          width={Math.max(2, c.x2 - c.x1)}
          height={H - padTop}
          fill={c.high ? "#e11d48" : "#f59e0b"}
          fillOpacity="0.10"
          rx="3"
        />
      ))}
      {voters.map((v, i) => {
        const ms = Date.parse(v.voteAt ?? v.ballotTs);
        if (!Number.isFinite(ms)) return null;
        const flagged = v.flags.includes("vote-cluster") || v.flags.includes("same-tag");
        return (
          <g key={v.did}>
            <circle cx={x(ms)} cy={y(i)} r={flagged ? 4 : 3} fill={flagged ? "#e11d48" : "#4f46e5"} fillOpacity="0.85" />
            <title>
              {`identity_${v.did.slice(-4)} · ${new Date(ms).toLocaleString()}${
                v.flags.length ? ` · ${v.flags.map((f) => FLAG_LABEL[f] ?? f).join(", ")}` : ""
              }`}
            </title>
          </g>
        );
      })}
    </svg>
  );
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
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (did: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(did)) next.delete(did);
      else next.add(did);
      return next;
    });

  useEffect(() => {
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
  }, [entryId]);

  const risk = report?.risk;
  const riskTone = risk?.level === "high" ? "error" : risk?.level === "notable" ? "warn" : "ok";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-3xl overflow-y-auto rounded-[18px] border border-hairline bg-canvas p-5 shadow-lg sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="caption-sm text-mute">voters & rug report</p>
            <h2 className="heading-md mt-0.5">
              <span className="font-mono">{gameId ?? entryId}</span>{" "}
              <span className="text-mute">· entry {entryId}</span>
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <StatusChip tone="ok">{votes} vote{votes === 1 ? "" : "s"}</StatusChip>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-hairline bg-canvas px-3 py-1 text-[12px] text-body hover:bg-surface-soft"
            >
              Close
            </button>
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
                  One dot per voter (arrival order). Shaded bands are bursts the report flags.
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
      </div>
    </div>
  );
}
