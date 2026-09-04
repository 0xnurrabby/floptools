/**
 * URL handling for the Technocore GET write lane.
 *
 * The signature and DID are base64url/alphanumeric and must be sent raw
 * (never double-encoded). The text is the only segment that needs encoding:
 * it can contain spaces, slashes, percent signs and non-ASCII. We encode
 * everything except RFC 3986 unreserved characters so a message can never
 * break out of its path segment.
 */

export function encodePathSegment(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

export function assertValidRoom(room: string): void {
  if (!isValidName(room)) {
    throw new Error(
      `room must match ${NAME_RE.source} (lowercase, 1-48 chars, [a-z0-9_-])`,
    );
  }
}

/** Full upstream path for a signed message write. */
export function signedSayPath(opts: {
  room: string;
  did: string;
  sig: string;
  nonce: string;
  text: string;
}): string {
  assertValidRoom(opts.room);
  return [
    "/r",
    opts.room,
    "say-signed",
    opts.did,
    opts.sig,
    opts.nonce,
    encodePathSegment(opts.text),
  ].join("/");
}

export function unsignedSayPath(opts: {
  room: string;
  nick: string;
  text: string;
}): string {
  assertValidRoom(opts.room);
  return [
    "/r",
    opts.room,
    "say",
    opts.nick,
    encodePathSegment(opts.text),
  ].join("/");
}

export function noteReadPath(ns: string, key: string): string {
  return `/kv/${ns}/${key}`;
}

export function noteSetPath(
  ns: string,
  key: string,
  value: string,
  condition?: { ifAbsent?: boolean; if?: string },
): string {
  let path = `/kv/${ns}/${key}/set/${encodePathSegment(value)}`;
  if (condition?.ifAbsent) path += "?if_absent=1";
  else if (condition?.if !== undefined)
    path += `?if=${encodeURIComponent(condition.if)}`;
  return path;
}

export function roomReadPath(
  room: string,
  opts: {
    since?: number | string;
    limit?: number;
    wait?: number;
    format?: "json" | "text";
    n?: number;
  } = {},
): string {
  const qs = new URLSearchParams();
  if (opts.since !== undefined) qs.set("since", String(opts.since));
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  if (opts.wait !== undefined) qs.set("wait", String(opts.wait));
  if (opts.format === "json") qs.set("format", "json");
  if (opts.n !== undefined) qs.set("n", String(opts.n));
  const q = qs.toString();
  return q ? `/r/${room}?${q}` : `/r/${room}`;
}