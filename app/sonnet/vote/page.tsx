"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button, Card, Note, Spinner, StatusChip, TextInput } from "@/components/ui";
import { LocalTime } from "@/components/local-time";
import { useSession } from "@/components/use-session";
import { SonnetVoteDialog } from "@/components/sonnet-vote-dialog";
import { signDraft } from "@/lib/keyring";
import { getClient } from "@/lib/client";

const REGISTRATION_ROOM = "mb-sonnet-2-registration";
const CONTEST_ID = "sonnet-2";

interface MyStatus {
  registered: { role: string; x: string | null } | null;
  registrationReceipt: {
    status: "accepted" | "rejected" | "pending";
    reason: string | null;
    at: string | null;
    requestId: string;
  } | null;
  ballot: { entryId: string; status: "accepted" | "rejected" | "pending"; reason: string | null } | null;
  entry: { gameId: string; entryId: string; votes: number; rank: number; entries: number } | null;
}

/** Random opaque request id: varied length and alphabet, no pattern at all. */
function randId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const len = 10 + Math.floor(Math.random() * 19);
  const arr = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of arr) out += alphabet[b % alphabet.length];
  return out;
}

interface Member {
  did: string;
  x: string | null;
  words: number;
}

interface Team {
  gameId: string;
  poemRoom: string;
  members: Member[];
  words: { word: string; by: string; version: number; ts?: string }[];
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
  building?: boolean;
  updatedAt: string;
  cachedAt?: string;
  contest: { deadline: number; referee: string };
  teams: Team[];
  totals: { teams: number; entries: number; countedBallots: number; voters: number };
  writersIndexed: number;
}

/** Relative "updated X ago" that keeps itself fresh. */
function Ago({ value }: { value?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(0, Math.round((now - t) / 60_000));
  const label = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  return <>{label}</>;
}

type Sort = "votes" | "recent" | "alpha";

function stanzaGroups(lines: string[]): string[][] {
  const groups: string[][] = [];
  for (let i = 0; i < lines.length; i += 4) groups.push(lines.slice(i, i + 4));
  return groups;
}

export default function SonnetVotePage() {
  const { did } = useSession();
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("votes");
  const [query, setQuery] = useState("");
  const [voteTarget, setVoteTarget] = useState<Team | null>(null);
  const [handlesLoading, setHandlesLoading] = useState(false);
  const [myStatus, setMyStatus] = useState<MyStatus | null>(null);
  const [regBusy, setRegBusy] = useState(false);
  const [regMsg, setRegMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const lastLoadRef = useRef(0);

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
          .finally(() => {
            lastLoadRef.current = Date.now();
            setBusy(false);
          });
      });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMe = useCallback(
    (refresh = false) => {
      return Promise.resolve().then(() => {
        if (!did) {
          setMyStatus(null);
          return;
        }
        return fetch(`/api/sonnet/me?did=${encodeURIComponent(did)}${refresh ? "&refresh=1" : ""}`, { cache: "no-store" })
          .then((r) => r.json() as Promise<MyStatus & { ok?: boolean }>)
          .then((d) => {
            if (d.ok !== false) setMyStatus(d);
          })
          .catch(() => {});
      });
    },
    [did],
  );

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  /**
   * Smart auto-refresh. The API serves a snapshot and quietly rebuilds it in
   * the background when it goes stale, so simply re-asking brings the page up
   * to date: on tab focus and every 90 seconds while the tab is visible. Never
   * re-requests data younger than a minute, and never polls hidden tabs.
   */
  useEffect(() => {
    const interval = data?.building ? 20_000 : 90_000;
    const minAge = data?.building ? 8_000 : 60_000;
    const check = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (Date.now() - lastLoadRef.current < minAge) return;
      void load();
      void loadMe();
    };
    const id = setInterval(check, interval);
    const onWake = () => check();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [load, loadMe, data?.building]);

  const registerAsVoter = async () => {
    if (!did || regBusy) return;
    setRegBusy(true);
    setRegMsg(null);
    try {
      const requestId = randId();
      const text = JSON.stringify({
        type: "sonnet.register.v1",
        contest_id: CONTEST_ID,
        role: "voter",
        request_id: requestId,
      });
      const draft = signDraft(REGISTRATION_ROOM, text);
      const res = await getClient().writeSigned({
        room: REGISTRATION_ROOM,
        did: draft.did,
        sig: draft.sig,
        nonce: draft.nonce,
        text: draft.sweptText,
      });
      if (res.status < 200 || res.status >= 300) {
        setRegMsg({ ok: false, text: `Refused (HTTP ${res.status}). ${res.body.slice(0, 160)}` });
        return;
      }
      setRegMsg({ ok: true, text: "Registration posted — rebuilding the registry to confirm…" });
      // Force the registry to include the just-posted registration, then show
      // the confirmed role. (The referee receipt may land a moment later.)
      await loadMe(true);
      setRegMsg({ ok: true, text: "Registration is on the ledger. Only verified pre-start identities are counted for voting." });
    } catch (e) {
      setRegMsg({ ok: false, text: (e as Error).message });
    } finally {
      setRegBusy(false);
    }
  };

  const role = myStatus?.registered?.role ?? null;
  const myVote = myStatus?.ballot ?? null;

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

  const filtered = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    // Search every field a visitor could know: name, entry id, member DIDs
    // and handles, and the poem itself. All tokens must match, so results
    // stay exact instead of fuzzy noise.
    const teams = (data?.teams ?? []).filter((t) => {
      if (tokens.length === 0) return true;
      const hay = [
        t.gameId,
        t.entryId ?? "",
        ...t.members.flatMap((m) => [m.did, m.did.slice(-4), m.did.slice(-6), m.x ?? ""]),
        ...t.words.map((w) => w.word),
        ...t.lines,
      ]
        .join(" ")
        .toLowerCase();
      return tokens.every((tok) => hay.includes(tok));
    });
    if (sort === "votes") {
      return teams
        .slice()
        .sort((a, b) => b.votes - a.votes || b.wordCount - a.wordCount || a.gameId.localeCompare(b.gameId));
    }
    if (sort === "recent") return teams.slice().sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    return teams.slice().sort((a, b) => a.gameId.localeCompare(b.gameId));
  }, [data, query, sort]);

  const entries = (data?.teams ?? []).filter((t) => t.entryId);

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
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/sonnet/yourvote"
            className="body-sm rounded-full border border-hairline bg-canvas px-4 py-2 text-ink transition-colors hover:border-brand-500/40 hover:bg-tint-brand hover:text-brand-700"
          >
            Your vote →
          </Link>
          <Button variant="secondary" onClick={() => void load(true)} disabled={busy}>
            {busy ? <Spinner label="…" /> : "Refresh"}
          </Button>
        </div>
      </div>

      {did ? (
        <Card className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="body-sm-strong text-ink">Your voter status · identity_{did.slice(-4)}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {!myStatus ? (
                  <StatusChip tone="empty">checking registration…</StatusChip>
                ) : !role ? (
                  <StatusChip tone="empty">not registered yet</StatusChip>
                ) : myStatus.registrationReceipt?.status === "accepted" && role === "voter" ? (
                  <StatusChip tone="ok">registered voter · ready to vote</StatusChip>
                ) : myStatus.registrationReceipt?.status === "rejected" ? (
                  <StatusChip tone="error">
                    registration refused{myStatus.registrationReceipt.reason ? ` · ${myStatus.registrationReceipt.reason}` : ""}
                  </StatusChip>
                ) : role === "voter" ? (
                  <StatusChip tone="warn">voter registration posted · awaiting referee receipt</StatusChip>
                ) : (
                  <StatusChip tone="warn">registered {role} · cannot vote</StatusChip>
                )}
                {myVote ? (
                  <span className="caption-sm text-body">
                    {myVote.status === "accepted" ? (
                      <>
                        currently voting for <span className="font-mono">{myVote.entryId}</span> ·
                        accepted by the referee
                      </>
                    ) : myVote.status === "rejected" ? (
                      <>
                        last ballot for <span className="font-mono">{myVote.entryId}</span> was refused
                        {myVote.reason ? ` (${myVote.reason})` : ""} · vote again to make it count
                      </>
                    ) : (
                      <>
                        ballot for <span className="font-mono">{myVote.entryId}</span> posted · awaiting
                        the referee receipt
                      </>
                    )}
                  </span>
                ) : (
                  <span className="caption-sm text-mute">no ballot cast yet</span>
                )}
              </div>
            </div>
            {role !== "voter" ? (
              <Button onClick={() => void registerAsVoter()} disabled={regBusy} className="shrink-0">
                {regBusy ? <Spinner label="…" /> : "Register as a voter"}
              </Button>
            ) : null}
          </div>
          {myVote ? (
            <p className="caption-sm mt-2 text-body">
              You can change your vote any time before the deadline — your{" "}
              <strong className="font-medium text-ink">last</strong> valid ballot counts and replaces
              the earlier one.
            </p>
          ) : null}
          {regMsg ? (
            <div className="mt-2">
              <Note tone={regMsg.ok ? "ok" : "error"}>{regMsg.text}</Note>
            </div>
          ) : null}
        </Card>
      ) : (
        <div className="mt-5">
          <Note tone="warn">
            Unlock an identity to vote — your ballot must be signed by your own DID (Create page).
          </Note>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <TextInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search entry, DID suffix, X handle or poem line"
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
          <StatusChip tone="empty">
            {busy ? "updating…" : <>updated <Ago value={data.cachedAt ?? data.updatedAt} /></>}
          </StatusChip>
          {data.building ? <StatusChip tone="warn">refreshing…</StatusChip> : null}
        </div>
      ) : null}

      {!data ? (
        <div className="mt-8">
          <Spinner label="Reading every team and entry…" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="mt-8">
          <Note tone="info">
            Nothing matches this search. Try a single word from the entry name, a member DID suffix,
            an X handle, or a line from the poem.
          </Note>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {filtered.map((t, i) => (
            <Card key={t.gameId}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="body-sm-strong text-ink">
                    {sort === "votes" ? (
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
                  {myVote?.entryId === t.entryId ? <StatusChip tone="ok">your vote</StatusChip> : null}
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
                        <span className="text-mute" title="Not in the currently retained registrations — it may have rotated out of the room ring.">
                          X unknown
                        </span>
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
                  <Button variant="secondary" onClick={() => setVoteTarget(t)} className="ml-auto">
                    Vote for this entry
                  </Button>
                ) : null}
              </div>
            </Card>
          ))}

        </div>
      )}

      <Note tone="info" className="mt-8">
        A ballot is a public signed message in <span className="font-mono">mb-sonnet-2-votes</span>:
        only registered voters with verified pre-start identity evidence are counted, contributors and
        organizers cannot vote, and your <strong className="font-medium text-ink">last</strong> valid
        ballot before the deadline is the one that counts. Polls and likes are not votes. Verify the
        referee DID in the official LAUNCH.md before trusting any receipt.
      </Note>

      {voteTarget && voteTarget.entryId ? (
        <SonnetVoteDialog
          team={{ ...voteTarget, entryId: voteTarget.entryId }}
          rank={entries.findIndex((e) => e.gameId === voteTarget.gameId) + 1 || null}
          totalEntries={entries.length}
          did={did}
          onClose={() => setVoteTarget(null)}
          onVoted={() => {
            void load(true);
            void loadMe();
          }}
        />
      ) : null}
    </div>
  );
}
