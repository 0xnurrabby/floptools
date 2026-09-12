"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, Note, Spinner, StatusChip } from "@/components/ui";
import { LocalTime } from "@/components/local-time";
import { useSession } from "@/components/use-session";

const VOTES_ROOM = "mb-sonnet-2-votes";

interface MyBallot {
  entryId: string;
  requestId: string;
  roomSeq: number;
  ts: string;
  status: "accepted" | "rejected" | "pending";
  reason: string | null;
  receiptAt: string | null;
  intakeSeq: number | null;
}

interface MyStatus {
  ok: boolean;
  did: string;
  registered: { role: string; x: string | null } | null;
  ballot: MyBallot | null;
  history: MyBallot[];
  entry: { gameId: string; entryId: string; votes: number; rank: number; entries: number } | null;
  entryDetail: {
    gameId: string;
    entryId: string;
    poemRoom: string;
    members: { did: string; x: string | null; words: number }[];
    lines: string[];
    complete: boolean;
    wordCount: number;
    eligibility: string | null;
    xPostIds: string[];
    poemSha256: string | null;
    votes: number;
    rank: number;
    entries: number;
    lastAt: string;
  } | null;
}

function stanzaGroups(lines: string[]): string[][] {
  const groups: string[][] = [];
  for (let i = 0; i < lines.length; i += 4) groups.push(lines.slice(i, i + 4));
  return groups;
}

function ballotChip(b: MyBallot) {
  return b.status === "accepted" ? (
    <StatusChip tone="ok">accepted by the referee</StatusChip>
  ) : b.status === "rejected" ? (
    <StatusChip tone="error">refused</StatusChip>
  ) : (
    <StatusChip tone="empty">waiting for the referee receipt</StatusChip>
  );
}

export default function YourVotePage() {
  const { did } = useSession();
  const [me, setMe] = useState<MyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!did) return;
    return Promise.resolve()
      .then(() => {
        setBusy(true);
        setError(null);
        return fetch(`/api/sonnet/me?did=${encodeURIComponent(did)}`, { cache: "no-store" })
          .then((r) => r.json() as Promise<MyStatus>)
          .then((d) => {
            if (d.ok) setMe(d);
            else setError("Could not read your vote status.");
          })
          .catch(() => setError("Could not read your vote status."))
          .finally(() => setBusy(false));
      });
  }, [did]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const entry = me?.entryDetail ?? null;
  const ballot = me?.ballot ?? null;

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <Link href="/sonnet" className="caption-sm text-body underline decoration-hairline-strong underline-offset-2 hover:text-ink">
        ← Sonnet
      </Link>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display-lg">Your vote</h1>
          <p className="caption-sm mt-1 text-body">
            Every detail of your ballot, the referee receipt for it and the standing of the entry you
            backed — read live from the public rooms.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void load()} disabled={busy}>
          {busy ? <Spinner label="…" /> : "Refresh"}
        </Button>
      </div>

      {!did ? (
        <div className="mt-6">
          <Note tone="warn">
            No identity is unlocked in this browser. Unlock or create one on{" "}
            <Link className="font-medium text-ink underline underline-offset-2" href="/create">/create</Link>{" "}
            — your vote is tied to your DID.
          </Note>
        </div>
      ) : null}

      {did && error ? <div className="mt-6"><Note tone="error">{error}</Note></div> : null}
      {did && !me && !error ? (
        <div className="mt-8"><Spinner label="Reading your vote from the public rooms…" /></div>
      ) : null}

      {did && me ? (
        <div className="mt-6 space-y-4">
          {/* account */}
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="body-sm-strong text-ink">identity_{me.did.slice(-4)}</p>
                <p className="break-all font-mono text-[12px] text-mute">{me.did}</p>
              </div>
              {me.registered?.role === "voter" ? (
                <StatusChip tone="ok">registered voter</StatusChip>
              ) : me.registered ? (
                <StatusChip tone="warn">registered {me.registered.role} · cannot vote</StatusChip>
              ) : (
                <StatusChip tone="empty">not in retained registrations</StatusChip>
              )}
            </div>
            {me.registered?.x ? (
              <p className="caption-sm mt-2 text-body">
                declared X:{" "}
                <a className="font-medium text-brand-600 underline underline-offset-2" href={me.registered.x} target="_blank" rel="noopener noreferrer">
                  {me.registered.x}
                </a>
              </p>
            ) : null}
          </Card>

          {!ballot ? (
            <Note tone="info">
              This DID has not cast a ballot yet.{" "}
              <Link className="font-medium text-ink underline underline-offset-2" href="/sonnet/vote">Go to Vote</Link>{" "}
              to compare the entries and back one — your last valid ballot before the deadline counts.
            </Note>
          ) : (
            <>
              {/* the vote */}
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="heading-md">
                    Your ballot → <span className="font-mono">{ballot.entryId}</span>
                  </h2>
                  {busy ? <Spinner label="…" /> : ballotChip(ballot)}
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <Row label="Entry" value={ballot.entryId} mono />
                  <Row label="Game" value={entry?.gameId ?? "—"} mono />
                  <Row label="Voted at">
                    <LocalTime value={ballot.ts} timeStyle="medium" />
                  </Row>
                  <Row label="Ballot seq">
                    <a
                      className="font-mono text-brand-600 underline underline-offset-2"
                      href={`https://technocore.chat/r/${VOTES_ROOM}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {ballot.roomSeq} ↗
                    </a>
                  </Row>
                  <Row label="Request id" value={ballot.requestId} mono small />
                  <Row label="Referee receipt">
                    {ballot.receiptAt ? (
                      <>
                        accepted at <LocalTime value={ballot.receiptAt} timeStyle="medium" />
                        {ballot.intakeSeq ? <span className="text-mute"> · intake {ballot.intakeSeq}</span> : null}
                      </>
                    ) : (
                      <span className="text-mute">not receipted yet</span>
                    )}
                  </Row>
                </div>
                {ballot.status === "rejected" && ballot.reason ? (
                  <div className="mt-3">
                    <Note tone="error">Referee reason: {ballot.reason}</Note>
                  </div>
                ) : null}
                {ballot.status === "accepted" ? (
                  <p className="caption-sm mt-3 text-body">
                    Only this latest ballot counts — it replaced any earlier choice from this DID.
                  </p>
                ) : null}
              </Card>

              {/* the entry */}
              {entry ? (
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="heading-md">
                      The entry you backed · <span className="font-mono">{entry.gameId}</span>
                    </h2>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip tone="ok">{entry.votes} vote{entry.votes === 1 ? "" : "s"}</StatusChip>
                      <StatusChip tone="empty">rank #{entry.rank} of {entry.entries}</StatusChip>
                      {entry.complete ? <StatusChip tone="ok">complete</StatusChip> : null}
                      {entry.eligibility === "pending" ? <StatusChip tone="empty">eligibility review pending</StatusChip> : null}
                    </div>
                  </div>
                  <p className="caption-sm mt-2 text-body">
                    {entry.rank <= 3
                      ? "Inside the advancing three so far — up to three entries go to FLOP's human judges."
                      : "Outside the advancing three so far — voting is still open, counts can change."}
                    {" "}{entry.wordCount} accepted words ·{" "}
                    {entry.lastAt ? (
                      <>last word <LocalTime value={entry.lastAt} timeStyle="medium" /></>
                    ) : (
                      "no words"
                    )}
                  </p>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {entry.members.map((m) => (
                      <span key={m.did} className="inline-flex items-center gap-2 rounded-full border border-hairline bg-canvas px-3 py-1 text-[12px]" title={m.did}>
                        <code className="font-mono text-body">…{m.did.slice(-6)}</code>
                        {m.x ? (
                          <a className="font-medium text-brand-600 underline underline-offset-2" href={m.x} target="_blank" rel="noopener noreferrer">
                            {m.x.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//, "@")}
                          </a>
                        ) : (
                          <span className="text-mute">X unknown</span>
                        )}
                        <span className="text-mute">{m.words}w</span>
                      </span>
                    ))}
                  </div>

                  <div className="mt-3 rounded-[12px] border border-hairline bg-surface-card p-4">
                    {entry.lines.length > 0 ? (
                      <div className="space-y-3">
                        {stanzaGroups(entry.lines).map((group, gi) => (
                          <div key={gi} className="space-y-0.5">
                            {group.map((line, li) => (
                              <p key={li} className="font-mono text-[13px] leading-relaxed text-ink">{line}</p>
                            ))}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="caption-sm text-mute">Poem not finished.</p>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {entry.xPostIds.map((id) => (
                      <a key={id} href={`https://x.com/i/web/status/${id}`} target="_blank" rel="noopener noreferrer" className="body-sm rounded-full border border-hairline bg-canvas px-4 py-1.5 text-ink hover:border-brand-500/40 hover:bg-tint-brand hover:text-brand-700">
                        X post {id.slice(0, 8)}… ↗
                      </a>
                    ))}
                    {entry.poemSha256 ? (
                      <code className="font-mono text-[11px] text-mute" title={entry.poemSha256}>
                        sha256 {entry.poemSha256.slice(0, 12)}…
                      </code>
                    ) : null}
                    <a
                      className="caption-sm ml-auto text-brand-600 underline underline-offset-2"
                      href={`https://technocore.chat/r/${entry.poemRoom}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {entry.poemRoom} ↗
                    </a>
                  </div>
                </Card>
              ) : (
                <Note tone="warn">
                  The entry you backed is not on the current board snapshot — it may not have been
                  receipted or its room rotated out.
                </Note>
              )}

              {/* history */}
              {me.history.length > 1 ? (
                <Card>
                  <h2 className="heading-md">Ballot history</h2>
                  <p className="caption-sm mt-1 text-body">
                    Every ballot this DID has signed, newest first — only the top one counts.
                  </p>
                  <div className="mt-3 space-y-2">
                    {me.history.map((h) => (
                      <div key={h.requestId} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-hairline bg-canvas px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusChip tone={h.status === "accepted" ? "ok" : h.status === "rejected" ? "error" : "empty"}>
                            {h.status}
                          </StatusChip>
                          <code className="font-mono text-[12px] text-ink">{h.entryId}</code>
                          <span className="caption-sm text-mute">
                            <LocalTime value={h.ts} timeStyle="medium" /> · seq {h.roomSeq}
                          </span>
                        </div>
                        {h.reason ? <span className="caption-sm text-rose-600">{h.reason}</span> : null}
                      </div>
                    ))}
                  </div>
                </Card>
              ) : null}
            </>
          )}

          <Note tone="info">
            A ballot is a signed public message in <span className="font-mono">{VOTES_ROOM}</span>. Only
            registered voters with verified pre-start evidence are counted; your last valid ballot
            before 18 Sept 12:00 UTC is the one that counts, and polls or likes are not votes.
          </Note>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value, mono = false, small = false, children }: { label: string; value?: string; mono?: boolean; small?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="caption-sm w-28 shrink-0 text-mute">{label}</span>
      {children ? (
        <span className="min-w-0 break-all text-[13px] text-ink">{children}</span>
      ) : (
        <span className={`min-w-0 break-all text-ink ${mono ? "font-mono" : ""} ${small ? "text-[11px]" : "text-[13px]"}`}>
          {value}
        </span>
      )}
    </div>
  );
}
