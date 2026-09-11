"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, Card, Field, Note, Spinner, StatusChip, TextArea } from "@/components/ui";
import { LocalTime } from "@/components/local-time";
import { isIdentityFile } from "@/lib/identity";
import { isValidDid } from "@/lib/didkey";
import { readZip } from "@/lib/zip";

/**
 * /pro/bulk-check — Pro bulk ledger checker.
 *
 * Upload the wallets ZIP (or paste DIDs) and see each wallet's REAL state on
 * the public ledger: DID note present, which rooms still retain signed
 * activity, latest seq + time + text. Everything comes from the venue's
 * retained rings and notes — no simulation, no local records.
 */

const MAX_DIDS = 100;

interface RoomScan {
  count: number;
  latestSeq: number;
  latestTs?: string;
  latestText?: string;
  recent: { seq: number; ts: string; text: string }[];
}

interface DidScan {
  did: string;
  short: string;
  note: { found: boolean; path: string; value?: string };
  rooms: Record<string, RoomScan>;
  total: number;
  error?: string;
}

const SCAN_ROOMS = ["lobby", "technocore", "flop-network", "tclk-offers"];

export default function BulkCheckPage() {
  const [preset, setPreset] = useState<"checking" | "pro" | "not-pro">("checking");
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [deep, setDeep] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scans, setScans] = useState<DidScan[] | null>(null);
  const runTokenRef = useRef(0);

  useEffect(() => {
    void fetch("/api/pro/status", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ pro?: boolean }>)
      .then((d) => setPreset(d.pro ? "pro" : "not-pro"))
      .catch(() => setPreset("not-pro"));
  }, []);

  const extractDidsFromZip = async (file: File): Promise<string[]> => {
    const entries = readZip(await file.arrayBuffer());
    const dec = new TextDecoder();
    const dids: string[] = [];
    for (const e of entries) {
      if (!/\.json$/i.test(e.name)) continue;
      try {
        const parsed = JSON.parse(dec.decode(e.data)) as unknown;
        if (isIdentityFile(parsed) && isValidDid(parsed.public.did)) dids.push(parsed.public.did);
      } catch {
        /* skip non-identity entries */
      }
    }
    if (dids.length === 0) throw new Error("No identity_*.json files found in this ZIP.");
    return dids;
  };

  const parsePasted = (text: string): string[] =>
    text
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter((s) => isValidDid(s));

  const run = async (dids: string[]) => {
    const unique = [...new Set(dids)];
    if (unique.length === 0) {
      setError("No valid did:key found. Upload a wallets ZIP or paste DIDs.");
      return;
    }
    if (unique.length > MAX_DIDS) {
      setError(`At most ${MAX_DIDS} wallets per check — this set has ${unique.length}.`);
      return;
    }
    const token = ++runTokenRef.current;
    setBusy(true);
    setError(null);
    setScans(null);
    setDeep(false);

    const results = new Map<string, DidScan>();
    for (const d of unique) {
      results.set(d, {
        did: d,
        short: `identity_${d.slice(-4)}`,
        note: { found: false, path: "" },
        rooms: {},
        total: 0,
      });
    }
    type ScanPayload = {
      ok?: boolean;
      error?: string;
      rooms?: Record<string, { error?: string }>;
      dids?: Record<string, Record<string, RoomScan>>;
      notes?: Record<string, { found: boolean; path: string; value?: string }>;
    };
    const apply = (data: ScanPayload) => {
      const roomErrors = Object.values(data.rooms ?? {})
        .map((r) => r.error)
        .filter(Boolean);
      for (const d of unique) {
        const entry = results.get(d)!;
        const rooms = data.dids?.[d] ?? {};
        entry.rooms = rooms;
        entry.note = data.notes?.[d] ?? { found: false, path: "" };
        entry.total = SCAN_ROOMS.reduce((n, room) => n + (rooms[room]?.count ?? 0), 0);
        if (roomErrors.length > 0 && entry.total === 0) entry.error = roomErrors[0];
      }
      if (token === runTokenRef.current) setScans([...results.values()]);
    };

    try {
      // 1. FAST: newest tails + notes — results on screen in a second or two.
      const fastRes = await fetch(
        `/api/tc/room-scan?mode=fast&dids=${encodeURIComponent(unique.join(","))}`,
        { cache: "no-store" },
      );
      const fastData = (await fastRes.json()) as ScanPayload;
      if (!fastRes.ok || !fastData.ok) throw new Error(fastData.error ?? `scan failed (HTTP ${fastRes.status})`);
      apply(fastData);
      setBusy(false);
    } catch (e) {
      if (token === runTokenRef.current) {
        setError((e as Error).message);
        setBusy(false);
      }
      return;
    }

    // 2. DEEP: full retained rings in the background, merged when it lands.
    // A deep failure never removes the fast results.
    if (token !== runTokenRef.current) return;
    setDeep(true);
    try {
      const deepRes = await fetch(`/api/tc/room-scan?dids=${encodeURIComponent(unique.join(","))}`, {
        cache: "no-store",
      });
      const deepData = (await deepRes.json()) as ScanPayload;
      if (deepRes.ok && deepData.ok) apply(deepData);
    } catch {
      /* keep the fast results */
    } finally {
      if (token === runTokenRef.current) setDeep(false);
    }
  };

  const withNote = scans?.filter((s) => s.note.found).length ?? 0;
  const withActivity = scans?.filter((s) => s.total > 0).length ?? 0;

  return (
    <div className="mx-auto max-w-4xl px-4 pb-10 pt-12">
      <p className="caption-sm text-mute">floptools · pro · bulk check</p>
      <h1 className="display-lg mt-2">Bulk ledger check</h1>
      <p className="body-md mt-3 max-w-2xl text-body">
        See every wallet&apos;s real state on the public ledger: the DID note and the signed activity
        still retained in each public room — read live from the venue, nothing simulated.
      </p>

      {preset === "not-pro" ? (
        <div className="mt-6">
          <Note tone="warn">
            This is a Pro feature.{" "}
            <Link className="font-medium text-ink underline underline-offset-2" href="/">Unlock Pro first</Link>.
          </Note>
        </div>
      ) : null}

      {preset !== "not-pro" ? (
        <Card className="mt-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="body-sm-strong text-ink">Wallets ZIP</p>
              <p className="caption-sm mt-1 text-body">
                The ZIP from /pro/auto. The DID is public inside each identity file — no passphrase needed.
              </p>
              <input
                type="file"
                accept=".zip,application/zip"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    void extractDidsFromZip(f)
                      .then((dids) => run(dids))
                      .catch((err: unknown) => setError((err as Error).message));
                  }
                  e.target.value = "";
                }}
                className="mt-3 block w-full cursor-pointer rounded-[10px] border border-hairline bg-surface-card px-3 py-2 text-[13px] text-ink file:mr-3 file:cursor-pointer file:rounded-full file:border-0 file:bg-tint-brand file:px-4 file:py-1.5 file:text-[13px] file:font-medium file:text-brand-700"
              />
            </div>
            <div>
              <Field label="…or paste DIDs" hint="One per line, comma or space separated.">
                <TextArea rows={3} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="did:key:z6Mk…" mono />
              </Field>
              <div className="mt-2">
                <Button variant="secondary" onClick={() => void run(parsePasted(pasted))} disabled={busy || !pasted.trim()}>
                  Check pasted DIDs
                </Button>
              </div>
            </div>
          </div>
          {error ? <div className="mt-3"><Note tone="error">{error}</Note></div> : null}
          {busy ? <div className="mt-3"><Spinner label="Scanning the public rings…" /></div> : null}
        </Card>
      ) : null}

      {scans ? (
        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="heading-lg">Results</h2>
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone="ok">{withNote} note{withNote === 1 ? "" : "s"}</StatusChip>
              <StatusChip tone="ok">{withActivity} with activity</StatusChip>
              {deep ? <StatusChip tone="empty">deep scan of retained rings…</StatusChip> : null}
              <Button variant="secondary" onClick={() => void run(scans.map((s) => s.did))} disabled={busy}>
                Refresh
              </Button>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {scans.map((s) => {
              const tone = s.note.found && s.total > 0 ? "ok" : s.note.found || s.total > 0 ? "warn" : "empty";
              const label =
                tone === "ok" ? "on ledger" : tone === "warn" ? "partial" : "nothing retained";
              return (
                <Card key={s.did}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="body-sm-strong text-ink">{s.short}</p>
                      <p className="break-all font-mono text-[12px] text-mute">{s.did}</p>
                    </div>
                    <StatusChip tone={tone}>{label}</StatusChip>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[10px] border border-hairline bg-canvas px-3 py-2">
                    <span className="caption-sm text-body">DID note</span>
                    <StatusChip tone={s.note.found ? "ok" : "empty"}>
                      {s.note.found ? "on ledger" : "missing"}
                    </StatusChip>
                    {s.note.path ? <code className="font-mono text-[12px] text-mute">/kv/{s.note.path}</code> : null}
                  </div>

                  <div className="mt-2 space-y-1.5">
                    {SCAN_ROOMS.map((room) => {
                      const r = s.rooms[room];
                      const count = r?.count ?? 0;
                      return (
                        <div key={room} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-hairline bg-canvas px-3 py-2">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <code className="font-mono text-[12px] text-ink">/{room}</code>
                            <StatusChip tone={count > 0 ? "ok" : "empty"}>
                              {count > 0 ? `${count} on ledger` : "none retained"}
                            </StatusChip>
                            {r?.latestSeq ? (
                              <span className="caption-sm text-mute">
                                seq {r.latestSeq} · <LocalTime value={r.latestTs ?? ""} />
                              </span>
                            ) : null}
                          </div>
                          {r?.latestText ? (
                            <span
                              className="min-w-0 flex-1 break-words text-[12px] text-body sm:ml-4"
                              title={r.latestText}
                            >
                              {r.latestText}
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  {s.error ? <p className="caption-sm mt-2 text-amber-600">scan note: {s.error}</p> : null}
                </Card>
              );
            })}
          </div>

          <Note tone="info" className="mt-4">
            The venue keeps each room as a rolling ring (~10 MiB) and notes as durable records. Messages
            that fell out of retention will honestly read “none retained” — re-running the activity from
            /pro/auto puts fresh, verifiable activity on the ledger again.
          </Note>
        </section>
      ) : null}
    </div>
  );
}
