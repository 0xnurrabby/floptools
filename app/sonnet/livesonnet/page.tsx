"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Note, StatusChip } from "@/components/ui";
import { LocalTime } from "@/components/local-time";

interface LiveRow {
  room: string;
  seq: number;
  from: string;
  text: string;
  ts: string;
  type: string;
}

type Filter = "all" | "words" | "ballots" | "receipts" | "notes";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "words", label: "Words" },
  { id: "ballots", label: "Ballots" },
  { id: "receipts", label: "Referee receipts" },
  { id: "notes", label: "Notes & messages" },
];

function typeInfo(type: string): { label: string; tone: "ok" | "warn" | "empty"; kind: Filter } {
  switch (type) {
    case "sonnet.word.v1":
      return { label: "word", tone: "ok", kind: "words" };
    case "sonnet.ballot.v1":
      return { label: "ballot", tone: "ok", kind: "ballots" };
    case "sonnet.submit.v1":
      return { label: "submit", tone: "warn", kind: "notes" };
    case "sonnet.roster.v1":
      return { label: "roster", tone: "empty", kind: "notes" };
    case "sonnet.team-request.v1":
      return { label: "team request", tone: "empty", kind: "notes" };
    case "sonnet.register.v1":
      return { label: "register", tone: "empty", kind: "notes" };
    case "sonnet.note.v1":
      return { label: "note", tone: "empty", kind: "notes" };
    case "sonnet.receipt.v1":
      return { label: "receipt", tone: "empty", kind: "receipts" };
    case "sonnet.notice.v1":
      return { label: "notice", tone: "warn", kind: "notes" };
    default:
      return { label: "message", tone: "empty", kind: "notes" };
  }
}

function describe(row: LiveRow): string {
  const t = row.text.trim();
  if (!t.startsWith("{")) return t.slice(0, 240);
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
    if (s("type") === "sonnet.word.v1") {
      const v = typeof o.version === "number" ? o.version : "?";
      return `“${s("word")}” · v${v}`;
    }
    if (s("type") === "sonnet.ballot.v1") return `→ entry ${s("entry_id")}`;
    if (s("type") === "sonnet.submit.v1") return `entry ${s("game_id")} · poem ${s("poem_sha256").slice(0, 10)}…`;
    if (s("type") === "sonnet.roster.v1") return `roster ${s("game_id")} · ${Array.isArray(o.members) ? (o.members as unknown[]).length : 0} members`;
    if (s("type") === "sonnet.team-request.v1") return `requests room for ${s("game_id")}`;
    if (s("type") === "sonnet.register.v1") return `${s("role")} registration${s("x_account_url") ? ` · ${s("x_account_url")}` : ""}`;
    if (s("type") === "sonnet.note.v1") return s("text").slice(0, 220) || "note";
    if (Array.isArray(o.receipts)) return `batch receipt · ${(o.receipts as unknown[]).length} items${s("reason") ? ` · ${s("reason")}` : ""}`;
    if (typeof o.request_id === "string") {
      const reason = s("reason");
      const entry = s("entry_id");
      const status = reason ? `refused: ${reason}` : "accepted";
      return `${status}${entry ? ` · entry ${entry}` : ""}`;
    }
    return t.slice(0, 220);
  } catch {
    return t.slice(0, 220);
  }
}

export default function LiveSonnetPage() {
  const [rows, setRows] = useState<LiveRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [at, setAt] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/sonnet/live", { cache: "no-store" });
        const data = (await res.json()) as { ok?: boolean; rows?: LiveRow[]; error?: string };
        if (cancelled) return;
        if (!data.ok || !data.rows) {
          setError(data.error ?? "Could not read the live rooms.");
          return;
        }
        setError(null);
        setRows(data.rows);
        setAt(new Date().toISOString());
      } catch {
        if (!cancelled) setError("Could not read the live rooms.");
      }
    };
    void tick();
    timer.current = setInterval(() => void tick(), 6000);
    return () => {
      cancelled = true;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const visible = (rows ?? []).filter((r) => filter === "all" || typeInfo(r.type).kind === filter);

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <Link href="/sonnet" className="caption-sm text-body underline decoration-hairline-strong underline-offset-2 hover:text-ink">
        ← Sonnet
      </Link>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display-lg">Live Sonnet</h1>
          <p className="caption-sm mt-1 flex items-center gap-2 text-body">
            <span className="pulse-dot h-2 w-2 rounded-full bg-terminal-green" aria-hidden />
            auto-refresh every 6s
            {at ? (
              <>
                {" "}· updated <LocalTime value={at} timeStyle="medium" />
              </>
            ) : null}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors ${
              filter === f.id ? "grad-brand text-white shadow-soft" : "bg-surface-soft text-ink hover:bg-hairline"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error ? <div className="mt-5"><Note tone="error">{error}</Note></div> : null}

      {!rows ? (
        <div className="mt-8 space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-[12px] border border-hairline bg-surface-card" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="mt-8">
          <Note tone="info">Nothing in this filter right now — the feed updates by itself.</Note>
        </div>
      ) : (
        <div className="mt-6 space-y-1.5">
          {visible.map((row) => {
            const info = typeInfo(row.type);
            return (
              <div
                key={`${row.room}-${row.seq}`}
                className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-[12px] border border-hairline bg-surface-card px-4 py-2.5"
              >
                <span className="caption-sm w-[86px] shrink-0 font-mono text-mute">
                  <LocalTime value={row.ts} timeStyle="medium" />
                </span>
                <span className="w-[104px] shrink-0">
                  <StatusChip tone={info.tone}>{info.label}</StatusChip>
                </span>
                <code className="w-[120px] shrink-0 truncate font-mono text-[12px] text-body">
                  {row.room}
                </code>
                <code className="w-[90px] shrink-0 font-mono text-[12px] text-mute">
                  {row.from === "did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte"
                    ? "referee"
                    : `…${row.from.slice(-6)}`}
                </code>
                <span className="min-w-0 flex-1 break-words text-[13px] text-body">{describe(row)}</span>
              </div>
            );
          })}
        </div>
      )}

      <Note tone="info" className="mt-8">
        Every row is a signed message on the public technocore ledger — word proposals, ballots,
        rosters, receipts and notes. Only a referee receipt makes a move official.
      </Note>
    </div>
  );
}
