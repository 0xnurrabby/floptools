"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button, Card, Note, Spinner, StatusChip, TextInput } from "@/components/ui";
import { LocalTime } from "@/components/local-time";
import { useSession } from "@/components/use-session";
import { signDraft } from "@/lib/keyring";
import { getClient } from "@/lib/client";

const VOTES_ROOM = "mb-sonnet-2-votes";
const CONTEST = "sonnet-2";

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
  xPostIds: string[];
  poemSha256: string | null;
  votes: number;
  lastAt: string;
}

interface Overview {
  ok: boolean;
  stale?: boolean;
  updatedAt: string;
  contest: { deadline: number; referee: string };
  teams: Team[];
  totals: { teams: number; entries: number; countedBallots: number; voters: number };
  writersIndexed: number;
}

type Sort = "votes" | "recent" | "alpha";

function stanzaGroups(lines: string[]): string[][] {
  const groups: string[][] = [];
  for (let i = 0; i < lines.length; i += 4) groups.push(lines.slice(i, i + 4));
  return groups;
}

function nowMs(): number {
  return Date.now();
}

export default function SonnetVotePage() {
  const { did } = useSession();
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("votes");
  const [query, setQuery] = useState("");
  const [voteBusy, setVoteBusy] = useState<string | null>(null);
  const [voteMsg, setVoteMsg] = useState<{ gameId: string; ok: boolean; text: string } | null>(null);
  const [handlesLoading, setHandlesLoading] = useState(false);

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

  // If the local writer index is empty (fresh deployment / DB), ask the server
  // to build it in the background and merge the declared X accounts when done.
  useEffect(() => {
    if (!data || data.writersIndexed > 0) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => {
        setHandlesLoading(true);
        return fetch("/api/sonnet/overview?writers=1", { cache: "no-store" })
          .then((r) => r.json() as Promise<Overview>)
          .then((d) => {
            if (!cancelled && d.ok) setData(d);
          })
          .catch(() => {})
          .finally(() => {
            if (!cancelled) setHandlesLoading(false);
          });
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  const castVote = async (team: Team) => {
    if (!team.entryId) return;
    if (!did) {
      setVoteMsg({ gameId: team.gameId, ok: false, text: "Unlock an identity first (Create page) — the ballot must be signed by your DID." });
      return;
    }
    setVoteBusy(team.gameId);
    setVoteMsg(null);
    try {
      const requestId = `floptools-${did.slice(-6)}-${nowMs()}`;
      const text = JSON.stringify({
        type: "sonnet.ballot.v1",
        contest_id: CONTEST,
        voter_did: did,
        entry_id: team.entryId,
        request_id: requestId,
      });
      const draft = signDraft(VOTES_ROOM, text);
      const res = await getClient().writeSigned({
        room: VOTES_ROOM,
        did: draft.did,
        sig: draft.sig,
        nonce: draft.nonce,
        text: draft.sweptText,
      });
      if (res.status >= 200 && res.status < 300) {
        setVoteMsg({
          gameId: team.gameId,
          ok: true,
          text: `Ballot posted for ${team.entryId}. The referee receipt lands in the votes room shortly — your last valid ballot counts, and only registered pre-start voters are counted.`,
        });
      } else {
        setVoteMsg({ gameId: team.gameId, ok: false, text: `Refused (HTTP ${res.status}). ${res.body.slice(0, 160)}` });
      }
    } catch (e) {
      setVoteMsg({ gameId: team.gameId, ok: false, text: (e as Error).message });
    } finally {
      setVoteBusy(null);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (data?.teams ?? []).filter((t) => {
      if (!q) return true;
      if (t.gameId.toLowerCase().includes(q)) return true;
      if (t.entryId && t.entryId.toLowerCase().includes(q)) return true;
      return t.members.some(
        (m) => m.did.slice(-6).toLowerCase().includes(q) || (m.x ?? "").toLowerCase().includes(q),
      );
    });
    if (sort === "votes") return list.filter((t) => t.entryId).sort((a, b) => b.votes - a.votes || b.wordCount - a.wordCount);
    if (sort === "recent") return list.slice().sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    return list.slice().sort((a, b) => a.gameId.localeCompare(b.gameId));
  }, [data, query, sort]);

  const entries = (data?.teams ?? []).filter((t) => t.entryId);
  const explicit = sort === "votes" ? filtered : filtered.filter((t) => t.entryId);
  const writing = sort === "votes" ? filtered.filter((t) => !t.entryId) : [];

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <Link href="/sonnet" className="caption-sm text-body underline decoration-hairline-strong underline-offset-2 hover:text-ink">
        ← Sonnet
      </Link>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display-lg">Vote</h1>
          <p className="caption-sm mt-1 max-w-2xl text-body">
            Every entry, ranked by counted public ballots — members, the poem, publication links and
            the referee&apos;s status, so you can decide who deserves FLOP&apos;s human judges.
            {data ? (
              <>
                {" "}Ballots close{" "}
                <LocalTime value={new Date(data.contest.deadline).toISOString()} timeStyle="medium" />.
              </>
            ) : null}
          </p>
        </div>
        <Button variant="secondary" onClick={() => void load(true)} disabled={busy}>
          {busy ? <Spinner label="…" /> : "Refresh"}
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <TextInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search game, entry, DID suffix or X handle"
          className="sm:w-80"
        />
        <div className="flex gap-2">
          {(["votes", "recent", "alpha"] as Sort[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSort(s)}
              className={`rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors ${
                sort === s ? "grad-brand text-white shadow-soft" : "bg-surface-soft text-ink hover:bg-hairline"
              }`}
            >
              {s === "votes" ? "Top votes" : s === "recent" ? "Recent" : "A–Z"}
            </button>
          ))}
        </div>
      </div>

      {error ? <div className="mt-5"><Note tone="error">{error}</Note></div> : null}
      {data ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusChip tone="ok">{entries.length} entries</StatusChip>
          <StatusChip tone="ok">{data.totals.countedBallots} counted ballots</StatusChip>
          <StatusChip tone="empty">{data.totals.voters} voters</StatusChip>
          {did ? <StatusChip tone="ok">signed in · able to ballot</StatusChip> : <StatusChip tone="warn">unlock an identity to ballot</StatusChip>}
          {handlesLoading ? <StatusChip tone="empty">loading X handles…</StatusChip> : null}
        </div>
      ) : null}

      {!data ? (
        <div className="mt-8">
          <Spinner label="Reading every team and entry…" />
        </div>
      ) : explicit.length === 0 && writing.length === 0 ? (
        <div className="mt-8">
          <Note tone="info">Nothing matches this search.</Note>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {explicit.map((t, i) => (
            <Card key={t.gameId}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="body-sm-strong text-ink">
                    {sort === "votes" && t.entryId ? (
                      <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-tint-brand font-mono text-[12px] font-semibold text-brand-600">
                        {i + 1}
                      </span>
                    ) : null}
                    <span className="font-mono text-[15px]">{t.gameId}</span>
                  </p>
                  <p className="caption-sm mt-0.5 text-body">
                    {t.entryId ? <>entry <span className="font-mono">{t.entryId}</span> · </> : null}
                    {t.members.length} writers · {t.wordCount} accepted words
                    {t.complete ? " · complete" : ""}
                    {t.lastAt ? (
                      <>
                        {" "}· last word <LocalTime value={t.lastAt} timeStyle="medium" />
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {t.eligibility === "pending" ? <StatusChip tone="empty">review pending</StatusChip> : null}
                  {t.entryId ? (
                    <span className="text-right">
                      <span className="display-lg block text-grad">{t.votes}</span>
                      <span className="caption-sm text-mute">vote{t.votes === 1 ? "" : "s"}</span>
                    </span>
                  ) : (
                    <StatusChip tone="warn">writing</StatusChip>
                  )}
                </div>
              </div>

              {/* members */}
              {t.members.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {t.members.map((m) => (
                    <span
                      key={m.did}
                      className="inline-flex items-center gap-2 rounded-full border border-hairline bg-canvas px-3 py-1 text-[12px]"
                      title={m.did}
                    >
                      <code className="font-mono text-body">…{m.did.slice(-6)}</code>
                      {m.x ? (
                        <a
                          href={m.x}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-brand-600 underline underline-offset-2"
                        >
                          {m.x.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//, "@")}
                        </a>
                      ) : (
                        <span className="text-mute">no X declared</span>
                      )}
                      <span className="text-mute">{m.words} word{m.words === 1 ? "" : "s"}</span>
                    </span>
                  ))}
                </div>
              ) : null}

              {/* poem */}
              <div className="mt-4 rounded-[12px] border border-hairline bg-canvas p-4">
                {t.lines.length > 0 ? (
                  <div className="space-y-3">
                    {stanzaGroups(t.lines).map((group, gi) => (
                      <div key={gi} className="space-y-0.5">
                        {group.map((line, li) => (
                          <p key={li} className="font-mono text-[13px] leading-relaxed text-ink">
                            {line}
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="caption-sm text-mute">
                    Writing in progress — {t.wordCount} accepted word{t.wordCount === 1 ? "" : "s"} so far.
                  </p>
                )}
              </div>

              {/* publication + action */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {t.xPostIds.map((id) => (
                  <a
                    key={id}
                    href={`https://x.com/i/web/status/${id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="body-sm rounded-full border border-hairline bg-canvas px-4 py-1.5 text-ink transition-colors hover:border-brand-500/40 hover:bg-tint-brand hover:text-brand-700"
                  >
                    X post {id.slice(0, 8)}… ↗
                  </a>
                ))}
                {t.poemSha256 ? (
                  <code className="font-mono text-[11px] text-mute" title={t.poemSha256}>
                    sha256 {t.poemSha256.slice(0, 12)}…
                  </code>
                ) : null}
                {t.entryId ? (
                  <Button
                    variant="secondary"
                    onClick={() => void castVote(t)}
                    disabled={voteBusy !== null}
                    className="ml-auto"
                  >
                    {voteBusy === t.gameId ? <Spinner label="…" /> : "Vote for this entry"}
                  </Button>
                ) : null}
              </div>

              {voteMsg?.gameId === t.gameId ? (
                <div className="mt-3">
                  <Note tone={voteMsg.ok ? "ok" : "error"}>{voteMsg.text}</Note>
                </div>
              ) : null}
            </Card>
          ))}

          {writing.length > 0 ? (
            <section className="pt-4">
              <h2 className="heading-lg">Still writing</h2>
              <p className="caption-sm mt-1 text-body">
                These teams have not submitted an entry yet — no ballot can count for them.
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {writing.map((t) => (
                  <div key={t.gameId} className="flex items-center justify-between gap-2 rounded-[12px] border border-hairline bg-surface-card px-4 py-2.5">
                    <code className="font-mono text-[13px] text-ink">{t.gameId}</code>
                    <span className="caption-sm text-body">{t.wordCount} words · {t.members.length} writers</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}

      <Note tone="info" className="mt-8">
        A ballot is a public signed message in <span className="font-mono">mb-sonnet-2-votes</span>:
        only registered voters with verified pre-start identity evidence are counted, contributors and
        organizers cannot vote, and your <strong className="font-medium text-ink">last</strong> valid
        ballot before the deadline is the one that counts. Polls and likes are not votes. Verify the
        referee DID in the official LAUNCH.md before trusting any receipt.
      </Note>
    </div>
  );
}
