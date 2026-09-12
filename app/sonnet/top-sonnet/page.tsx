"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, Note, Spinner, StatusChip } from "@/components/ui";
import { LocalTime } from "@/components/local-time";

interface Member {
  did: string;
  x: string | null;
  words: number;
}

interface Team {
  gameId: string;
  poemRoom: string;
  members: Member[];
  lines: string[];
  complete: boolean;
  wordCount: number;
  entryId: string | null;
  eligibility: string | null;
  votes: number;
  lastAt: string;
}

interface Overview {
  ok: boolean;
  stale?: boolean;
  updatedAt: string;
  teams: Team[];
  totals: { teams: number; entries: number; ballots: number; countedBallots: number; voters: number };
}

export default function TopSonnetPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((fresh = false) => {
    return Promise.resolve()
      .then(() => {
        setBusy(true);
        setError(null);
        return fetch(`/api/sonnet/overview${fresh ? "?fresh=1" : ""}`, { cache: "no-store" })
          .then((r) => r.json() as Promise<Overview>)
          .then((d) => {
            if (d.ok) setData(d);
            else setError("Could not read the contest rooms.");
          })
          .catch(() => setError("Could not read the contest rooms."))
          .finally(() => setBusy(false));
      });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const entries = (data?.teams ?? []).filter((t) => t.entryId);
  const writing = (data?.teams ?? []).filter((t) => !t.entryId);

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <Link href="/sonnet" className="caption-sm text-body underline decoration-hairline-strong underline-offset-2 hover:text-ink">
        ← Sonnet
      </Link>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display-lg">Top Sonnet</h1>
          <p className="caption-sm mt-1 text-body">
            Public ballot tally · each registered voter&apos;s last valid ballot counts
            {data ? (
              <>
                {" "}· updated <LocalTime value={data.updatedAt} timeStyle="medium" />
                {data.stale ? " (cached)" : ""}
              </>
            ) : null}
          </p>
        </div>
        <Button variant="secondary" onClick={() => void load(true)} disabled={busy}>
          {busy ? <Spinner label="…" /> : "Refresh"}
        </Button>
      </div>

      {error ? <div className="mt-5"><Note tone="error">{error}</Note></div> : null}

      {data ? (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <StatusChip tone="ok">{data.totals.entries} entries</StatusChip>
          <StatusChip tone="ok">{data.totals.countedBallots} counted ballots</StatusChip>
          <StatusChip tone="empty">{data.totals.voters} voters</StatusChip>
          <StatusChip tone="empty">{writing.length} teams still writing</StatusChip>
        </div>
      ) : null}

      {!data ? (
        <div className="mt-8">
          <Spinner label="Reading the contest rooms…" />
        </div>
      ) : entries.length === 0 ? (
        <div className="mt-8">
          <Note tone="info">
            No accepted entries yet. The first submissions will appear here as the referee receipts
            them.
          </Note>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {entries.map((t, i) => (
            <Card key={t.gameId}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-tint-brand font-mono text-[13px] font-semibold text-brand-600">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="body-sm-strong text-ink">
                      <span className="font-mono">{t.gameId}</span>
                      {t.complete ? <StatusChip tone="ok">complete</StatusChip> : null}
                      {t.eligibility === "pending" ? <StatusChip tone="empty">review pending</StatusChip> : null}
                    </p>
                    <p className="caption-sm mt-0.5 text-body">
                      {t.members.length} writers · {t.wordCount} accepted words ·{" "}
                      {t.lastAt ? <>last word <LocalTime value={t.lastAt} timeStyle="medium" /></> : "no words yet"}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="display-lg text-grad">{t.votes}</p>
                  <p className="caption-sm text-mute">vote{t.votes === 1 ? "" : "s"}</p>
                </div>
              </div>
              {t.lines.length > 0 ? (
                <p className="mt-3 line-clamp-2 border-l-2 border-hairline pl-3 font-mono text-[12px] leading-relaxed text-body">
                  {t.lines[0]}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Link
                  href="/sonnet/vote"
                  className="body-sm rounded-full border border-hairline bg-canvas px-4 py-1.5 text-ink transition-colors hover:border-brand-500/40 hover:bg-tint-brand hover:text-brand-700"
                >
                  See the poem & vote
                </Link>
                <code className="font-mono text-[11px] text-mute">entry {t.entryId}</code>
              </div>
            </Card>
          ))}
        </div>
      )}

      {writing.length > 0 ? (
        <section className="mt-10">
          <h2 className="heading-lg">Still writing</h2>
          <p className="caption-sm mt-1 text-body">
            Teams with a roster but no accepted submission yet — words keep landing on the ledger.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {writing
              .slice()
              .sort((a, b) => b.wordCount - a.wordCount)
              .slice(0, 12)
              .map((t) => (
                <div key={t.gameId} className="flex items-center justify-between gap-2 rounded-[12px] border border-hairline bg-surface-card px-4 py-2.5">
                  <code className="font-mono text-[13px] text-ink">{t.gameId}</code>
                  <span className="caption-sm text-body">{t.wordCount} words · {t.members.length} writers</span>
                </div>
              ))}
          </div>
        </section>
      ) : null}

      <Note tone="info" className="mt-8">
        Votes are public ballots in <span className="font-mono">mb-sonnet-2-votes</span>; only ballots
        the referee has receipted with an entry id are counted, and a later ballot replaces an earlier
        one. Eligibility review can still change the shortlist after the deadline.
      </Note>
    </div>
  );
}
