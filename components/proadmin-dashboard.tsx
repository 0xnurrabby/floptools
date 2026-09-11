"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Note, Spinner, StatusChip } from "@/components/ui";
import { LocalTime } from "@/components/local-time";
import type { IpGeo } from "@/lib/ip-geo";

interface ProEventRow {
  ip: string;
  kind: string;
  detail: string | null;
  createdAt: string;
  geo: IpGeo | null;
}

interface TopIpRow {
  ip: string;
  unlocks: number;
  bypasses: number;
  failures: number;
  events: number;
  lastSeen: string;
  geo: IpGeo | null;
}

interface ProStats {
  ok: boolean;
  overview: {
    unlocks: number;
    unlocksToday: number;
    unlocks30d: number;
    uniqueIps: number;
    failures: number;
    locks: number;
    bypasses: number;
    autoRuns: number;
    events: number;
  };
  byFeature: { feature: string; n: number }[];
  recent: ProEventRow[];
  topIps: TopIpRow[];
}

type Phase = "loading" | "ready" | "error" | "unauthorized";

const KIND_LABEL: Record<string, string> = {
  unlock_ok: "unlock",
  unlock_fail: "wrong pass",
  lock: "lock",
  limit_bypass: "bypass",
  auto_run: "auto run",
};

/**
 * /proadmin dashboard — Pro-panel tracking only. No app-wide stats here; those
 * live on /admin, deliberately unmixed.
 */
export function ProAdminDashboard() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [stats, setStats] = useState<ProStats | null>(null);
  const [refreshAt, setRefreshAt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/proadmin/stats", { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) {
          setPhase("unauthorized");
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ProStats;
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
    await fetch("/api/proadmin/logout", { method: "POST" });
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
    return <Spinner label="Loading pro panel…" />;
  }
  if (phase === "error" || !stats) {
    return (
      <div className="space-y-4">
        <Note tone="error">Could not load pro tracking. Is DATABASE_URL set?</Note>
        <Button variant="secondary" onClick={refresh}>Retry</Button>
      </div>
    );
  }

  const o = stats.overview;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="caption-sm text-mute">floptools · pro panel</p>
          <h1 className="display-lg mt-2">Pro access</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={refresh}>Refresh</Button>
          <Button variant="secondary" onClick={logout}>Sign out</Button>
        </div>
      </div>

      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Unlocks" value={o.unlocks} sub={`${o.unlocksToday} today`} />
        <Stat label="Active unlocks (30d)" value={o.unlocks30d} sub="cookie lifetime is 30 days" />
        <Stat label="Unique IPs" value={o.uniqueIps} sub="browsers that ever unlocked" />
        <Stat label="Failed attempts" value={o.failures} sub="wrong passcode" />
        <Stat label="Limit bypasses" value={o.bypasses} sub="gates skipped in pro mode" />
        <Stat label="Auto runs" value={o.autoRuns} sub="wallet runs from /pro/auto" />
        <Stat label="Locks" value={o.locks} sub="pro mode closed again" />
        <Stat label="Pro events" value={o.events} sub="all rows in pro_events" />
      </div>

      <section className="mt-10">
        <h2 className="heading-lg">Bypass usage by feature</h2>
        <p className="caption-sm mt-1 text-body">
          Which fair-use gate Pro mode skipped — the app-wide numbers stay on /admin.
        </p>
        {stats.byFeature.length === 0 ? (
          <p className="caption-sm mt-3 text-mute">No bypasses recorded yet.</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {stats.byFeature.map((f) => (
              <span
                key={f.feature}
                className="inline-flex items-center gap-2 rounded-full border border-hairline bg-surface-card px-4 py-1.5 text-[13px] text-ink"
              >
                <span className="font-mono">{f.feature}</span>
                <span className="font-semibold text-brand-600">{f.n.toLocaleString()}</span>
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="mt-10">
        <h2 className="heading-lg">Recent pro activity</h2>
        <div className="mt-4 overflow-x-auto rounded-[12px] border border-hairline">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-hairline bg-surface-soft">
                <th className="px-4 py-2.5 font-medium text-mute">When</th>
                <th className="px-4 py-2.5 font-medium text-mute">IP</th>
                <th className="px-4 py-2.5 font-medium text-mute">Event</th>
                <th className="px-4 py-2.5 font-medium text-mute">Detail</th>
              </tr>
            </thead>
            <tbody>
              {stats.recent.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-mute">No pro activity yet.</td>
                </tr>
              ) : (
                stats.recent.map((e, i) => (
                  <tr key={`${e.createdAt}-${i}`} className="border-b border-hairline last:border-0">
                    <td className="whitespace-nowrap px-4 py-2.5 text-body">
                      <LocalTime value={e.createdAt} />
                    </td>
                    <td className="px-4 py-2.5">
                      <GeoText ip={e.ip} geo={e.geo} />
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusChip
                        tone={
                          e.kind === "unlock_ok"
                            ? "ok"
                            : e.kind === "unlock_fail"
                              ? "error"
                              : e.kind === "limit_bypass"
                                ? "empty"
                                : "warn"
                        }
                      >
                        {KIND_LABEL[e.kind] ?? e.kind}
                      </StatusChip>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-body">{e.detail ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="heading-lg">Top IPs</h2>
        <div className="mt-4 overflow-x-auto rounded-[12px] border border-hairline">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-hairline bg-surface-soft">
                <th className="px-4 py-2.5 font-medium text-mute">IP</th>
                <th className="px-4 py-2.5 font-medium text-mute">Unlocks</th>
                <th className="px-4 py-2.5 font-medium text-mute">Bypasses</th>
                <th className="px-4 py-2.5 font-medium text-mute">Failures</th>
                <th className="px-4 py-2.5 font-medium text-mute">Events</th>
                <th className="px-4 py-2.5 font-medium text-mute">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {stats.topIps.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-mute">No IPs recorded yet.</td>
                </tr>
              ) : (
                stats.topIps.map((t) => (
                  <tr key={t.ip} className="border-b border-hairline last:border-0">
                    <td className="px-4 py-2.5">
                      <GeoText ip={t.ip} geo={t.geo} />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-body">{t.unlocks}</td>
                    <td className="px-4 py-2.5 font-mono text-body">{t.bypasses}</td>
                    <td className="px-4 py-2.5 font-mono text-body">{t.failures}</td>
                    <td className="px-4 py-2.5 font-mono text-body">{t.events}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-body">
                      <LocalTime value={t.lastSeen} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="caption-sm mt-10 text-body">
        Pro tracking only: unlocks, failures, locks and limit-bypass events. No keys, no message
        content — IP is kept for counting and abuse review.
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
  return <span className="font-mono text-mute">{ip}</span>;
}
