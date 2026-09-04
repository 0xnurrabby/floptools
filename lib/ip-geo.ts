/**
 * IP → country/region geolocation for the admin dashboard.
 *
 * - Lookup via ipwho.is (free HTTPS JSON, no key).
 * - Results are cached in the ip_geo table (and a small in-memory TTL), so an
 *   admin refresh costs ~zero lookups; failed or private IPs are retried
 *   politely (never spammed).
 * - Flags are derived locally from the ISO country code (regional indicator
 *   symbols), so no flag asset or service is involved.
 */

import { safeQuery, safeExec } from "./db";

export interface IpGeo {
  ip: string;
  countryCode: string;
  country: string;
  region: string;
  city: string;
  flag: string;
}

const memCache = new Map<string, { geo: IpGeo | null; at: number }>();
const memTtl = 10 * 60 * 1000;

export function flagEmoji(countryCode: string): string {
  const cc = countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return "";
  return String.fromCodePoint(
    ...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

function normalizeRegion(region: string): string {
  return region.replace(/^Province of /i, "").slice(0, 40);
}

async function fetchGeo(ip: string): Promise<IpGeo | null> {
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      headers: { Accept: "application/json", "User-Agent": "floptools-admin/1.0" },
      signal: AbortSignal.timeout(6000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      success?: boolean;
      country_code?: string;
      country?: string;
      region?: string;
      city?: string;
    };
    if (!j.success || typeof j.country_code !== "string") return null;
    const code = j.country_code.toUpperCase();
    const geo: IpGeo = {
      ip,
      countryCode: code,
      country: j.country ?? code,
      region: normalizeRegion(j.region ?? ""),
      city: (j.city ?? "").slice(0, 40),
      flag: flagEmoji(code),
    };
    await safeExec(
      `INSERT INTO ip_geo (ip, country, country_code, region, city)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (ip) DO UPDATE
         SET country = EXCLUDED.country, country_code = EXCLUDED.country_code,
             region = EXCLUDED.region, city = EXCLUDED.city,
             updated_at = now()`,
      [ip, geo.country, geo.countryCode, geo.region, geo.city],
    );
    return geo;
  } catch {
    return null;
  }
}

export async function geoForIp(ip: string): Promise<IpGeo | null> {
  if (!ip || ip === "?" || ip === "unknown" || ip === "local") return null;
  const mem = memCache.get(ip);
  if (mem && Date.now() - mem.at < memTtl) return mem.geo;

  const rows = (await safeQuery(
    "SELECT country, country_code, region, city FROM ip_geo WHERE ip = $1",
    [ip],
  )) ?? [];
  const row = rows[0];
  if (row) {
    const geo: IpGeo = {
      ip,
      countryCode: String(row["country_code"] ?? ""),
      country: String(row["country"] ?? ""),
      region: String(row["region"] ?? ""),
      city: String(row["city"] ?? ""),
      flag: flagEmoji(String(row["country_code"] ?? "")),
    };
    memCache.set(ip, { geo, at: Date.now() });
    return geo;
  }

  const geo = await fetchGeo(ip);
  memCache.set(ip, { geo, at: Date.now() });
  return geo;
}

export async function geoForMany(ips: string[], chunk = 6): Promise<Map<string, IpGeo | null>> {
  const out = new Map<string, IpGeo | null>();
  const unique = [...new Set(ips.filter(Boolean))];
  for (let i = 0; i < unique.length; i += chunk) {
    const batch = await Promise.allSettled(unique.slice(i, i + chunk).map((ip) => geoForIp(ip)));
    batch.forEach((r, j) => {
      out.set(unique[i + j], r.status === "fulfilled" ? r.value : null);
    });
  }
  return out;
}