"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, Note, Spinner, StatusChip } from "@/components/ui";
import { signDraft } from "@/lib/keyring";
import { getClient } from "@/lib/client";

const VOTES_ROOM = "mb-sonnet-2-votes";
const REGISTRATION_ROOM = "mb-sonnet-2-registration";
const CONTEST = "sonnet-2";

export interface VoteDialogMember {
  did: string;
  x: string | null;
  words: number;
}

export interface VoteDialogTeam {
  gameId: string;
  entryId: string;
  members: VoteDialogMember[];
  lines: string[];
  complete: boolean;
  wordCount: number;
  eligibility: string | null;
  xPostIds: string[];
  poemSha256: string | null;
  votes: number;
}

interface MeStatus {
  did: string;
  registered: { role: string; x: string | null } | null;
  ballot: {
    entryId: string;
    requestId: string;
    roomSeq: number;
    ts: string;
    status: "accepted" | "rejected" | "pending";
    reason: string | null;
  } | null;
  entry: {
    gameId: string;
    entryId: string;
    votes: number;
    rank: number;
    entries: number;
    xPostIds: string[];
  } | null;
}

type Step = "account" | "group" | "confirm" | "working" | "done";

function nowMs(): number {
  return Date.now();
}

function stanzaGroups(lines: string[]): string[][] {
  const groups: string[][] = [];
  for (let i = 0; i < lines.length; i += 4) groups.push(lines.slice(i, i + 4));
  return groups;
}

function roleChip(role: string | null | undefined) {
  if (role === "voter") return <StatusChip tone="ok">registered voter</StatusChip>;
  if (role === "writer") return <StatusChip tone="warn">registered writer · cannot vote</StatusChip>;
  if (role === "organizer") return <StatusChip tone="warn">registered organizer · cannot vote</StatusChip>;
  return <StatusChip tone="empty">not in retained registrations</StatusChip>;
}

/**
 * Guided ballot: account status -> team details -> confirm -> real signed
 * ballot -> referee receipt + standing. Nothing is sent before the explicit
 * "Yes, cast my ballot".
 */
export function SonnetVoteDialog({
  team,
  rank,
  totalEntries,
  did,
  onClose,
  onVoted,
}: {
  team: VoteDialogTeam;
  rank: number | null;
  totalEntries: number;
  did: string | null;
  onClose: () => void;
  onVoted: () => void;
}) {
  const [step, setStep] = useState<Step>("account");
  const [me, setMe] = useState<MeStatus | null>(null);
  const [meBusy, setMeBusy] = useState(false);
  const [regBusy, setRegBusy] = useState(false);
  const [regMsg, setRegMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const [receiptSeq, setReceiptSeq] = useState<number | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fetchMe = useCallback(
    async (refresh = false): Promise<MeStatus | null> => {
      if (!did) return null;
      setMeBusy(true);
      try {
        const res = await fetch(
          `/api/sonnet/me?did=${encodeURIComponent(did)}${refresh ? "&refresh=1" : ""}`,
          { cache: "no-store" },
        );
      const data = (await res.json()) as ({ ok: boolean } & MeStatus) | { ok: false };
      if (!data.ok) return null;
      if (!alive.current) return null;
      setMe(data as MeStatus);
      return data as MeStatus;
    } catch {
      return null;
    } finally {
      if (alive.current) setMeBusy(false);
    }
  }, [did]);

  useEffect(() => {
    void Promise.resolve().then(() => fetchMe());
  }, [fetchMe]);

  // After a ballot lands, the referee receipt can take a moment: poll briefly.
  const pollReceipt = (attempt = 0) => {
    if (!alive.current || attempt > 8) return;
    void fetchMe().then((status) => {
      if (!alive.current) return;
      if (status?.ballot?.status === "pending") {
        setTimeout(() => pollReceipt(attempt + 1), 3000);
      }
    });
  };

  const registerAsVoter = async () => {
    if (!did || regBusy) return;
    setRegBusy(true);
    setRegMsg(null);
    try {
      const requestId = `floptools-voter-${did.slice(-6)}-${nowMs()}`;
      const text = JSON.stringify({
        type: "sonnet.register.v1",
        contest_id: CONTEST,
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
      if (res.status >= 200 && res.status < 300) {
        setRegMsg({ ok: true, text: "Registration posted — rebuilding the registry to confirm…" });
        // Force the registry rebuild so the just-posted registration shows up
        // here immediately (not on the next 15-minute cycle).
        await fetchMe(true);
        setRegMsg({
          ok: true,
          text: "Registration is on the ledger. The referee receipts it shortly, and only verified pre-start identities are counted for voting.",
        });
      } else {
        setRegMsg({ ok: false, text: `Refused (HTTP ${res.status}). ${res.body.slice(0, 160)}` });
      }
    } catch (e) {
      setRegMsg({ ok: false, text: (e as Error).message });
    } finally {
      setRegBusy(false);
    }
  };

  const cast = async () => {
    if (!did) return;
    setStep("working");
    setPostError(null);
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
      if (res.status < 200 || res.status >= 300) {
        setPostError(`The venue refused the ballot (HTTP ${res.status}). ${res.body.slice(0, 160)}`);
        setStep("done");
        return;
      }
      setReceiptSeq(res.posted?.seq ?? null);
      setStep("done");
      onVoted();
      pollReceipt();
    } catch (e) {
      setPostError((e as Error).message);
      setStep("done");
    }
  };

  const role = me?.registered?.role ?? null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        className="max-h-[86vh] w-full max-w-2xl overflow-y-auto rounded-[18px] border border-hairline bg-canvas p-5 shadow-lg sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="caption-sm text-mute">
            {step === "account" ? "1 · your account" : step === "group" ? "2 · the team" : step === "confirm" ? "3 · confirm" : step === "working" ? "posting your ballot" : "your vote"}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-hairline bg-canvas px-3 py-1 text-[12px] text-body hover:bg-surface-soft"
          >
            Close
          </button>
        </div>

        {step === "account" ? (
          <div className="mt-3">
            <h2 className="heading-md">Your account</h2>
            {!did ? (
              <div className="mt-3">
                <Note tone="warn">
                  No identity is unlocked in this browser. Unlock or create one on the Create page
                  first — a ballot must be signed by your own DID.
                </Note>
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                <div className="rounded-[12px] border border-hairline bg-surface-card p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="body-sm-strong text-ink">identity_{did.slice(-4)}</p>
                    {meBusy && !me ? <Spinner label="checking…" /> : roleChip(role)}
                  </div>
                  <p className="mt-1 break-all font-mono text-[12px] text-mute">{did}</p>
                  {me?.registered?.x ? (
                    <p className="caption-sm mt-1 text-body">
                      declared X:{" "}
                      <a className="font-medium text-brand-600 underline underline-offset-2" href={me.registered.x} target="_blank" rel="noopener noreferrer">
                        {me.registered.x}
                      </a>
                    </p>
                  ) : null}
                  <p className="caption-sm mt-2 text-body">
                    Only registered voters with verified pre-start identity evidence are counted.
                    Contributors and organizers cannot vote. Your last valid ballot before the
                    deadline is the one that counts.
                  </p>
                </div>

                {me?.ballot ? (
                  <div className="rounded-[12px] border border-leaf-600/25 bg-tint-leaf p-4">
                    <p className="body-sm-strong text-ink">Your current ballot</p>
                    <p className="caption-sm mt-1 text-body">
                      <span className="font-mono">{me.ballot.entryId}</span> ·{" "}
                      {me.ballot.status === "accepted"
                        ? "accepted by the referee"
                        : me.ballot.status === "rejected"
                          ? `refused (${me.ballot.reason ?? "?"})`
                          : "waiting for the referee receipt"}
                      {me.entry ? (
                        <> · currently rank #{me.entry.rank} of {me.entry.entries} with {me.entry.votes} votes</>
                      ) : null}
                    </p>
                    <p className="caption-sm mt-1 text-mute">
                      Casting a new ballot replaces it — your last valid ballot counts.
                    </p>
                  </div>
                ) : null}

                {role !== "voter" && !meBusy ? (
                  <div className="rounded-[12px] border border-hairline bg-surface-card p-4">
                    <p className="body-sm-strong text-ink">Register as a voter</p>
                    <p className="caption-sm mt-1 text-body">
                      This posts a signed <span className="font-mono">sonnet.register.v1</span> to the
                      registration room — the referee receipts it and checks the pre-start evidence.
                    </p>
                    <div className="mt-2">
                      <Button variant="secondary" onClick={() => void registerAsVoter()} disabled={regBusy}>
                        {regBusy ? <Spinner label="…" /> : "Register as voter"}
                      </Button>
                    </div>
                    {regMsg ? (
                      <div className="mt-2">
                        <Note tone={regMsg.ok ? "ok" : "error"}>{regMsg.text}</Note>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button onClick={() => setStep("group")} disabled={!did}>
                Next · the team
              </Button>
            </div>
          </div>
        ) : null}

        {step === "group" ? (
          <div className="mt-3">
            <h2 className="heading-md">
              {team.gameId} <span className="text-mute">· entry {team.entryId}</span>
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusChip tone="ok">{team.votes} vote{team.votes === 1 ? "" : "s"}</StatusChip>
              {rank ? <StatusChip tone="empty">rank #{rank} of {totalEntries}</StatusChip> : null}
              {team.complete ? <StatusChip tone="ok">complete</StatusChip> : null}
              {team.eligibility === "pending" ? <StatusChip tone="empty">eligibility review pending</StatusChip> : null}
              <span className="caption-sm text-mute">{team.wordCount} accepted words</span>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {team.members.map((m) => (
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
              {team.lines.length > 0 ? (
                <div className="space-y-3">
                  {stanzaGroups(team.lines).map((group, gi) => (
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
              {team.xPostIds.map((id) => (
                <a key={id} href={`https://x.com/i/web/status/${id}`} target="_blank" rel="noopener noreferrer" className="body-sm rounded-full border border-hairline bg-canvas px-4 py-1.5 text-ink hover:border-brand-500/40 hover:bg-tint-brand hover:text-brand-700">
                  X post {id.slice(0, 8)}… ↗
                </a>
              ))}
              {team.poemSha256 ? <code className="font-mono text-[11px] text-mute">sha256 {team.poemSha256.slice(0, 12)}…</code> : null}
            </div>

            <div className="mt-4 flex flex-wrap justify-between gap-2">
              <Button variant="secondary" onClick={() => setStep("account")}>Back</Button>
              <Button onClick={() => setStep("confirm")}>Next · confirm</Button>
            </div>
          </div>
        ) : null}

        {step === "confirm" ? (
          <div className="mt-3">
            <h2 className="heading-md">Cast your ballot?</h2>
            <Note tone="warn" className="mt-3">
              You are about to sign and publish a public ballot for <strong className="font-medium text-ink">entry {team.entryId}</strong>{" "}
              (<span className="font-mono">{team.gameId}</span>) from{" "}
              <span className="font-mono">identity_{did?.slice(-4)}</span>. This replaces any earlier
              ballot from your DID; it cannot be deleted, but you can vote again until the deadline.
            </Note>
            <div className="mt-4 flex flex-wrap justify-between gap-2">
              <Button variant="secondary" onClick={() => setStep("group")}>Back</Button>
              <Button onClick={() => void cast()}>Yes, cast my ballot</Button>
            </div>
          </div>
        ) : null}

        {step === "working" ? (
          <div className="mt-6 flex justify-center">
            <Spinner label="Signing and posting your ballot…" />
          </div>
        ) : null}

        {step === "done" ? (
          <div className="mt-3">
            {postError ? (
              <Note tone="error">{postError}</Note>
            ) : (
              <Note tone="ok">
                Ballot posted{receiptSeq ? ` at seq ${receiptSeq}` : ""}. The referee receipt can take
                a moment — this view updates itself.
              </Note>
            )}

            <div className="mt-3 rounded-[12px] border border-hairline bg-surface-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="body-sm-strong text-ink">Your vote status</p>
                {meBusy ? (
                  <Spinner label="…" />
                ) : me?.ballot ? (
                  <StatusChip tone={me.ballot.status === "accepted" ? "ok" : me.ballot.status === "rejected" ? "error" : "empty"}>
                    {me.ballot.status === "accepted" ? "accepted by the referee" : me.ballot.status === "rejected" ? "refused" : "waiting for the referee receipt"}
                  </StatusChip>
                ) : (
                  <StatusChip tone="empty">checking…</StatusChip>
                )}
              </div>
              {me?.ballot?.reason ? (
                <p className="caption-sm mt-2 text-rose-600">Referee reason: {me.ballot.reason}</p>
              ) : null}
              {me?.entry ? (
                <div className="mt-2 space-y-1">
                  <p className="caption-sm text-body">
                    You are backing <span className="font-mono">{me.entry.entryId}</span>{" "}
                    (<span className="font-mono">{me.entry.gameId}</span>) — currently{" "}
                    <strong className="font-medium text-ink">rank #{me.entry.rank} of {me.entry.entries}</strong>{" "}
                    with {me.entry.votes} vote{me.entry.votes === 1 ? "" : "s"}.
                    {me.entry.rank <= 3 ? " Inside the advancing three so far." : " Outside the advancing three so far — voting is still open and counts can change."}
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {me.entry.xPostIds.map((id) => (
                      <a key={id} href={`https://x.com/i/web/status/${id}`} target="_blank" rel="noopener noreferrer" className="caption-sm rounded-full border border-hairline bg-canvas px-3 py-1 text-ink hover:border-brand-500/40">
                        X post {id.slice(0, 8)}… ↗
                      </a>
                    ))}
                  </div>
                </div>
              ) : !postError ? (
                <p className="caption-sm mt-2 text-body">
                  Once the referee receipts the ballot, your choice and its standing appear here.
                </p>
              ) : null}
            </div>

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={() => void fetchMe()}>Refresh status</Button>
              <Link
                href="/sonnet/yourvote"
                onClick={onClose}
                className="body-sm inline-flex items-center rounded-full border border-hairline bg-canvas px-4 py-2 text-ink transition-colors hover:border-brand-500/40 hover:bg-tint-brand hover:text-brand-700"
              >
                Full vote details →
              </Link>
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
