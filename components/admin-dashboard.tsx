"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Note,
  Spinner,
  StatusChip,
  TerminalCard,
} from "@/components/ui";

interface IpGeo {
  flag: string;
  countryCode: string;
  country: string;
  region: string;
  city: string;
}

interface Stats {
  dbError?: string;
  overview: {
    usersAllTime: number;
    users24h: number;
    pageviewsAllTime: number;
    pageviews24h: number;
    didsAllTime: number;
    dids24h: number;
    generationsAllTime: number;
    generations24h: number;
    tokensAllTime: number;
    tokens24h: number;
    promptTokens: number;
    completionTokens: number;
    generationCalls: number;
    activeDids: number;
    trackedDids: number;
  } | null;
  dids: {
    did: string;
    ip: string;
    geo?: IpGeo | null;
    createdAt: string;
    lastActive: string;
    generations: number;
    tokens: number;
    active: boolean;
  }[];
  topIps: { ip: string; dids: number }[];
  ipRows: {
    ip: string;
    lastActive: string;
    pageviews: number;
    dids: number;
    aiGens: number;
    geo?: IpGeo | null;
  }[];
  recent: { ip: string; path: string; createdAt: string }[];
}

type Phase = "loading" | "ready" | "error" | "unauthorized";

export function AdminDashboard() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [stats, setStats] = useState<Stats | null>(null);
  const [refreshAt, setRefreshAt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/stats", { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) {
          setPhase("unauthorized");
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Stats & { ok: boolean };
        if (!data.ok) throw new Error("bad payload");
        setStats(data);
        setPhase("ready");
      })
      .catch(() => {
        if (!cancelled) setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [refreshAt]);

  const refresh = () => {
    setPhase("loading");
    setRefreshAt(Date.now());
  };

  const logout = async () => {
    await fetch("/api/admin/logout", { method: "POST" });
    router.refresh();
  };

  if (phase === "unauthorized") {
    return (
      <div className="mx-auto max-w-md pt-16">
        <Note tone="warn">Session expired. Sign in again.</Note>
      </div>
    );
  }
  if (phase === "loading") {
    return <Spinner label="Loading dashboard…" />;
  }
  if (phase === "error" || !stats) {
    return (
      <div className="space-y-4">
        <Note tone="error">Could not load statistics. Is DATABASE_URL set?</Note>
        <Button variant="secondary" onClick={refresh}>Retry</Button>
      </div>
    );
  }

  const o = stats.overview;
  const pct = o && o.trackedDids > 0 ? Math.round((o.activeDids / o.trackedDids) * 100) : 0;

  if (stats.dbError) {
    return (
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="caption-sm text-mute">floptools · dashboard</p>
            <h1 className="display-lg mt-2">Admin</h1>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={refresh}>Refresh</Button>
            <Button variant="secondary" onClick={logout}>Sign out</Button>
          </div>
        </div>
        <div className="mt-8">
          <Note tone="error">
            <strong className="font-medium text-ink">Database is not reachable.</strong> {stats.dbError}
            <div className="mt-2">
              Fix the DATABASE_URL (Neon connection string) in the server environment (Vercel Settings
              → Environment Variables), then redeploy. Page views, DIDs and AI usage are recorded but
              cannot be counted until the database accepts the connection.
            </div>
          </Note>
        </div>
      </div>
    );
  }
  if (!o) return null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="caption-sm text-mute">floptools · dashboard</p>
          <h1 className="display-lg mt-2">Admin</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={refresh}>Refresh</Button>
          <Button variant="secondary" onClick={logout}>Sign out</Button>
        </div>
      </div>

      {/* Overview cards */}
      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Users (unique IPs)" value={o.usersAllTime} sub={`${o.users24h} in last 24h`} />
        <Stat label="Page views" value={o.pageviewsAllTime} sub={`${o.pageviews24h} in last 24h`} />
        <Stat label="DIDs created" value={o.didsAllTime} sub={`${o.dids24h} in last 24h`} />
        <Stat
          label="DIDs active"
          value={o.activeDids}
          sub={`tracked ${o.trackedDids} (${pct}% active)`}
        />
        <Stat label="AI generations" value={o.generationsAllTime} sub={`${o.generations24h} in last 24h`} />
        <Stat label="AI tokens used" value={o.tokensAllTime} sub={`${o.tokens24h} in last 24h`} />
        <Stat label="Prompt tokens" value={o.promptTokens} sub={`completion ${o.completionTokens}`} />
        <Stat label="Generation calls" value={o.generationCalls} sub="logged in DB" />
      </div>

      {/* DID states */}
      <section className="mt-10">
        <h2 className="heading-lg">DID states</h2>
        <p className="caption-sm mt-1 text-body">
          Active = the DID note is present on the ledger (durable signal). Last
          active = the most recent signed message or AI generation recorded for
          that DID. Freshness checked for the latest {o.trackedDids} DIDs, cached 10 minutes.
        </p>
        <div className="mt-4 overflow-x-auto rounded-[12px] border border-hairline">
          <table className="w-full min-w-[880px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-hairline bg-surface-soft">
                <th className="px-4 py-2.5 font-medium text-mute">DID</th>
                <th className="px-4 py-2.5 font-medium text-mute">IP</th>
                <th className="px-4 py-2.5 font-medium text-mute">Created</th>
                <th className="px-4 py-2.5 font-medium text-mute">Last active</th>
                <th className="px-4 py-2.5 font-medium text-mute">AI gens</th>
                <th className="px-4 py-2.5 font-medium text-mute">Tokens</th>
                <th className="px-4 py-2.5 font-medium text-mute">State</th>
              </tr>
            </thead>
            <tbody>
              {stats.dids.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-mute">No DIDs recorded yet.</td>
                </tr>
              ) : (
                stats.dids.map((d) => (
                  <tr key={d.did} className="border-b border-hairline last:border-0">
                    <td className="max-w-72 break-all px-4 py-2.5 font-mono">{d.did}</td>
                    <td className="px-4 py-2.5">
                      <span className="flex w-max max-w-full items-center gap-1.5">
                        <GeoText ip={d.ip} geo={d.geo} />
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-body">{fmtTime(d.createdAt)}</td>
                    <td className="px-4 py-2.5 text-body">{fmtTime(d.lastActive)}</td>
                    <td className="px-4 py-2.5 text-body">{d.generations}</td>
                    <td className="px-4 py-2.5 font-mono text-body">{d.tokens.toLocaleString()}</td>
                    <td className="px-4 py-2.5">
                      <StatusChip tone={d.active ? "ok" : "empty"}>
                        {d.active ? "active" : "dead / unknown"}
                      </StatusChip>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Unique IPs */}
      <section className="mt-10">
        <h2 className="heading-lg">Unique IPs</h2>
        <p className="caption-sm mt-1 text-body">
          Where visitors came from, with their last seen time and what they did.
        </p>
        <div className="mt-4 overflow-x-auto rounded-[12px] border border-hairline">
          <table className="w-full min-w-[560px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-hairline bg-surface-soft">
                <th className="px-4 py-2.5 font-medium text-mute">IP</th>
                <th className="px-4 py-2.5 font-medium text-mute">Location</th>
                <th className="px-4 py-2.5 font-medium text-mute">Last active</th>
                <th className="px-4 py-2.5 font-medium text-mute">Views</th>
                <th className="px-4 py-2.5 font-medium text-mute">DIDs</th>
                <th className="px-4 py-2.5 font-medium text-mute">AI gens</th>
              </tr>
            </thead>
            <tbody>
              {stats.ipRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-mute">No visits recorded yet.</td>
                </tr>
              ) : (
                stats.ipRows.map((r) => (
                  <tr key={r.ip} className="border-b border-hairline last:border-0">
                    <td className="px-4 py-2.5 font-mono">{r.ip}</td>
                    <td className="px-4 py-2.5">
                      <GeoText ip={r.ip} geo={r.geo} />
                    </td>
                    <td className="px-4 py-2.5 text-body">{fmtTime(r.lastActive)}</td>
                    <td className="px-4 py-2.5 text-body">{r.pageviews}</td>
                    <td className="px-4 py-2.5 text-body">{r.dids}</td>
                    <td className="px-4 py-2.5 text-body">{r.aiGens}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Top IPs */}
      <section className="mt-10 grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="heading-lg">DID creators by IP</h2>
          <TerminalCard title="top creators" className="mt-3">
            {stats.topIps.map((t) => (
              <div key={t.ip} className="flex justify-between gap-4">
                <span>{t.ip}</span>
                <span className="text-mute">{t.dids} dids</span>
              </div>
            )) || <span className="text-mute">no data</span>}
          </TerminalCard>
        </div>
        <div>
          <h2 className="heading-lg">Recent activity</h2>
          <TerminalCard title="recent" className="mt-3">
            {stats.recent.slice(0, 16).map((r, i) => (
              <div key={i} className="flex justify-between gap-4">
                <span>{r.path}</span>
                <span className="text-mute">{r.ip}</span>
              </div>
            ))}
          </TerminalCard>
        </div>
      </section>

      <p className="caption-sm mt-10 text-body">
        Anonymous aggregate stats only: no keys, no message content, no user data beyond IP for counting.
        The admin session is a signed HttpOnly cookie; the password lives in server environment.
      </p>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-[12px] border border-hairline bg-surface-card p-4">
      <p className="caption-sm text-mute">{label}</p>
      <p className="display-lg mt-1 text-ink">{value.toLocaleString()}</p>
      {sub ? <p className="caption-sm mt-1 text-body">{sub}</p> : null}
    </div>
  );
}

function fmtTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function GeoText({ ip, geo }: { ip: string; geo?: IpGeo | null }) {
  if (geo?.countryCode) {
    const place = [geo.city, geo.region].filter(Boolean).join(", ");
    return (
      <span className="min-w-0" title={`${geo.country}${place ? ` · ${place}` : ""}`}>
        <span className="mr-1.5">{geo.flag}</span>
        <span className="text-body">{geo.country}</span>
        {place ? <span className="caption-sm text-mute"> · {place.slice(0, 40)}</span> : null}
      </span>
    );
  }
  return <span className="text-mute">{ip}</span>;
}