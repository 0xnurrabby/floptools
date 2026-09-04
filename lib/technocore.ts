/**
 * Technocore client — read-only proxy-safe wrapper over the public HTTP API.
 *
 * Two transport modes:
 *   - "proxy" (browser): requests go to the same-origin `/api/tc?u=<path>`
 *     route, which forwards public Technocore GETs. This exists because the
 *     public instance serves no CORS headers, so browser JS cannot read
 *     responses directly (writes still land, but unreadably).
 *   - "direct" (CLI/Node): fetches the upstream base URL directly.
 *
 * Nothing here ever sees or transmits a private key. Signing happens in the
 * caller; only public material (did, sig, nonce, text) is sent, exactly as
 * the protocol requires.
 */

import {
  noteReadPath,
  noteSetPath,
  roomReadPath,
  signedSayPath,
} from "./urlencode";

export const DEFAULT_BASE_URL = "https://technocore.chat";

export type TransportMode = "proxy" | "direct";

export interface TechnocoreOptions {
  baseUrl?: string;
  mode?: TransportMode;
  fetchImpl?: typeof fetch;
}

export class TechnocoreError extends Error {
  status: number;
  body: string;
  kind:
    | "rate_limited"
    | "rejected"
    | "duplicate"
    | "bad_request"
    | "network"
    | "other";
  constructor(
    status: number,
    body: string,
    kind: TechnocoreError["kind"] = "other",
  ) {
    super(`Technocore HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "TechnocoreError";
    this.status = status;
    this.body = body;
    this.kind = kind;
  }
}

export interface TcMessage {
  seq: number;
  ts: string;
  from: string;
  text: string;
  nonce?: number;
  sig?: string;
}

export interface TcRoomRead {
  room: string;
  count: number;
  first_seq: number;
  last_seq: number;
  generation: number;
  messages: TcMessage[];
  rawBody: string;
}

export interface TcWriteResult {
  status: number;
  url: string;
  body: string;
  posted?: TcMessage;
}

export interface TcNoteResult {
  status: number;
  body: string;
  found: boolean;
  value: string;
  url: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

function assertName(ns: string, key: string): void {
  if (!NAME_RE.test(ns) || !NAME_RE.test(key)) {
    throw new Error(
      `invalid note path: ns/key must match ${NAME_RE.source}`,
    );
  }
}

export class TechnocoreClient {
  readonly baseUrl: string;
  readonly mode: TransportMode;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TechnocoreOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.mode = opts.mode ?? "direct";
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  /** Build the URL the caller will actually hit (for display / deep links). */
  upstreamUrl(path: string): string {
    if (this.mode === "proxy") {
      return `/api/tc?u=${encodeURIComponent(path)}`;
    }
    return this.baseUrl + path;
  }

  async request(
    path: string,
    opts: { timeoutMs?: number; allowText?: boolean; allowedStatuses?: number[] } = {},
  ): Promise<{ status: number; body: string; url: string }> {
    const timeoutMs = opts.timeoutMs ?? 20000;
    const url = this.upstreamUrl(path);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: "application/json, text/plain;q=0.9" },
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError") {
        throw new TechnocoreError(0, "request timed out", "network");
      }
      throw new TechnocoreError(0, e.message, "network");
    }
    const body = await res.text();
    const tolerated = opts.allowedStatuses ?? [];
    if (!res.ok && !tolerated.includes(res.status)) {
      const kind =
        res.status === 429
          ? "rate_limited"
          : res.status === 403
            ? "rejected"
            : res.status === 422
              ? "duplicate"
              : res.status === 400
                ? "bad_request"
                : "other";
      throw new TechnocoreError(res.status, body, kind);
    }
    return { status: res.status, body, url };
  }

  parseRoomJson(body: string, room: string): TcRoomRead {
    let parsed: {
      room?: string;
      count?: number;
      first_seq?: number;
      last_seq?: number;
      generation?: number;
      messages?: TcMessage[];
    };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      throw new Error("server did not return JSON despite format=json");
    }
    return {
      room: parsed.room ?? room,
      count: parsed.count ?? 0,
      first_seq: parsed.first_seq ?? 0,
      last_seq: parsed.last_seq ?? 0,
      generation: parsed.generation ?? 0,
      messages: parsed.messages ?? [],
      rawBody: body,
    };
  }

  async readRoom(
    room: string,
    opts: { since?: number | string; limit?: number; wait?: number; n?: number } = {},
  ): Promise<TcRoomRead> {
    const path = roomReadPath(room, { ...opts, format: "json" });
    const { body } = await this.request(path);
    return this.parseRoomJson(body, room);
  }

  async writeSigned(opts: {
    room: string;
    did: string;
    sig: string;
    nonce: string;
    text: string;
  }): Promise<TcWriteResult> {
    const path = signedSayPath(opts) + "?format=json";
    const res = await this.request(path);
    let posted: TcMessage | undefined;
    if (res.status >= 200 && res.status < 300) {
      try {
        const parsed = JSON.parse(res.body) as { posted?: TcMessage };
        posted = parsed.posted;
      } catch {
        /* text lane — fine, posted is undefined */
      }
    }
    return { status: res.status, url: res.url, body: res.body, posted };
  }

  async readNote(ns: string, key: string): Promise<TcNoteResult> {
    assertName(ns, key);
    const path = noteReadPath(ns, key);
    const { status, body, url } = await this.request(path, {
      allowText: true,
      allowedStatuses: [404],
    });
    const found = status === 200;
    return { status, body, found, value: found ? body : "", url };
  }

  async setNote(
    ns: string,
    key: string,
    value: string,
    condition?: { ifAbsent?: boolean; if?: string },
  ): Promise<{ status: number; body: string; url: string }> {
    assertName(ns, key);
    const path = noteSetPath(ns, key, value, condition);
    const res = await this.request(path);
    return res;
  }

  async exportRoom(room: string): Promise<string> {
    const { body } = await this.request(`/r/${room}/export`);
    return body;
  }
}