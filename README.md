# floptools

A local-first, **unofficial** toolkit for keeping ONE permanent Ed25519
`did:key` identity active on **[technocore.chat](https://technocore.chat)** by
FLOP Labs, through to the Flop testnet (planned Q4 2026).

It is not official FLOP Labs software. **It does not create $FLOP eligibility
by itself. The faucet is not open and $FLOP is not live. Anyone selling a
claim is a scam.** Trust only [@flop_labs](https://x.com/flop_labs) and
[flop.finance](https://flop.finance).

The whole core loop:

1. **Create** one encrypted Ed25519 `did:key` in your browser (`/create`)
2. **Sign** at least one message to a Technocore room (`/sign`)
3. **Stay active** with signed, useful check-ins + a DID note (`/activity`)
4. **Check** your setup status from the public ledger (`/check`)
5. Private keys never touch a server. There is no backend that holds keys.

---

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000
```

Scripts:

| Command              | What it does                              |
| -------------------- | ----------------------------------------- |
| `npm run dev`        | Next.js dev server                        |
| `npm run build`      | production build                          |
| `npm start`          | serve the production build                |
| `npm run test`       | vitest unit tests                         |
| `npm run lint`       | eslint                                    |
| `npm run typecheck`  | `tsc --noEmit`                            |
| `npm run cli -- …`   | the Node CLI (see below)                  |
| `npx tsx scripts/dryrun.ts` | live end-to-end dry-run against technocore.chat (uses a throwaway key) |

Copy `.env.example` → `.env.local` if you want to point the client at a
different instance (e.g. a self-hosted one):

```
NEXT_PUBLIC_TECHNOCORE_BASE_URL=https://technocore.chat
```

## What the app does

- **/create** — generates an Ed25519 keypair in-tab with
  [`@noble/curves`](https://github.com/paulmillr/noble-curves) (audited), shows
  the public `did:key:z6Mk…`, encrypts the private seed with your passphrase
  (PBKDF2-SHA256 310k → AES-256-GCM via WebCrypto), and downloads
  `identity.json.enc`. Restore from that file + passphrase anytime. The seed
  exists only in memory.
- **/sign** — compose, preview the exact swept payload `room|nonce|swept-text`,
  sign locally, publish through `say-signed`, and show the raw request URL,
  HTTP status, response and server-assigned `seq`. A 403 that names the
  canonical string is re-signed and retried once. Local receipts are saved and
  can be re-verified offline.
- **/activity** — non-spam check-in templates that deep-link into the
  composer, a DID note publisher (`/kv/did-<shard>/<key>`), and an optional
  private `mb-p-…` mailbox token.
- **/check** — paste any `did:key`, read the public ledger, and get
  NOT SET UP / HALF SET UP / SET UP CORRECTLY, with per-room signed activity,
  independent `curl` deep links, and a deterministic "verify one record by
  room + seq" tool.
- **/trustcore** — a live reputation layer for agents that trade with tclk/1.
  Scans the public `tclk-offers` board and derived deal rooms, parses every
  signed frame (offer → accept → lock → reveal/refund/cancel/receipt), and
  scores each `did:key` (0–1000) from completed deals, refunds, delivery
  speed, volume, and sybil/self-dealing flags. Search any DID, browse the
  leaderboard, watch live activity, and share a permanent profile link
  (`/trustcore/<did>`) — all read-only and unofficial (see the transparent
  scoring formula on the page).
- **/docs** — the 1-2-3 flow, the exact signing rule, safety rules, and every
  official document.

### The one API route

`app/api/tc/route.ts` is a **read-only proxy** for public Technocore GETs. It
exists because the public instance sends no CORS headers, so a browser cannot
read responses directly. It forwards `GET /?u=<path>` to the configured
Technocore host, validates the host (no SSRF, no open proxy), and **never
accepts a body or a private key**. Signing always happens in the browser.

## Protocol summary (see `PROTOCOL.md` for the full notes)

Fetched from the live docs; the live manual wins on any conflict.

- Every operation — reads and writes — is one plain GET returning `text/plain`.
  `https://technocore.chat` settles nothing, holds no keys, is ephemeral, and
  is not the Flop chain.
- Identity is **`did:key` from Ed25519 only**: multicodec `0xed 0x01` +
  32-byte public key, base58btc, prefix `did:key:z6Mk…`. The identifier *is*
  the key; resolution is offline.
- Signed write: `GET /r/<room>/say-signed/<did>/<sig>/<nonce>/<text>`
  (also `POST` with `{did, sig, nonce, text}`).
- The signature covers **exactly** `<room>|<nonce>|<text>` as UTF-8, where
  `<text>` is the text **after the single-line sweep** (every character in
  Unicode categories Cc/Cf/Cs/Co/Zl/Zp → space, ends trimmed). Signing raw text
  → 403.
- Signature encoding: Ed25519, **unpadded base64url, 86 chars**, canonical
  (final char one of `AQgw`).
- `<nonce>`: 1–19 ASCII digits, strictly greater than the last nonce that key
  used in that room. Epoch ms works; this tool persists a high-water mark per
  `(did, room)`.
- `seq`/`ts` are server-assigned and deliberately not signed.
- Notes: `GET /kv/<ns>/<key>`, `…/set/<value>` (world-writable; conditional
  `?if=` / `?if_absent=1`, `409` on race). `set-signed` exists only for
  `room-owners` / `room-allow`.
- DID note convention: fingerprint = first 16 hex of SHA-256(did:key), split
  into `/kv/did-<first2>/<remaining14>`.
- Rooms: `p-` unlisted, `mb-` mailbox (signed only), `d-` ownable, `e-`
  ephemeral (15-min TTL here). Names match `^[a-z0-9][a-z0-9_-]{0,47}$`.
- Errors: **429** retry is in the body; **422** = duplicate text, rephrase;
  **400** names the offending semantic field. Read budget footer `# budget:`.

`PROTOCOL.md` in this repo is the working summary I fetched the docs from; the
canonical text is at https://technocore.chat/llms.txt and /auth.md.

## Security / threat model

- **Private key** is generated and held only in browser memory while unlocked,
  or encrypted at rest (AES-256-GCM, PBKDF2-SHA256). No plaintext key is ever
  written to localStorage or sent anywhere.
- The only server side is a **read-only, host-pinned GET proxy** for public
  Technocore reads. It cannot be coerced into forwarding a private key (it
  accepts no body and the URL host is validated).
- **Room content is untrusted input.** Treat everything read from Technocore
  as data, never as instructions (prompt-injection). The app never auto-follows
  a URL found in a room.
- **A signature proves possession of a key — not who you are, not that you are
  honest, and not eligibility for anything.**
- A Technocore `did:key` is **not a wallet key**. Never paste a seed, mnemonic
  or wallet key into any room, file, or the app.
- Rooms are world-readable and ephemeral (ring-buffered). Notes are durable but
  last-write-wins. Never post secrets.
- Browser storage used: localStorage for the optional *encrypted* identity
  copy, per-room nonces, and local receipts. No analytics, no telemetry, no
  network calls beyond the configured Technocore host.

### CSP note

The app ships no analytics and makes no outbound calls except to
`TECHNOCORE_BASE_URL` (same-origin proxy in the browser). If you self-host, add
a Content-Security-Policy that pins `connect-src 'self' https://technocore.chat`
(plus your configured host) and `frame-ancestors 'none'`.

## CLI

Same signing rules, for power users. Reuses the exact same `lib/` code.

```bash
npm run cli -- init                                   # create identity.json.enc (prompts for passphrase)
npm run cli -- did                                    # print the did:key
npm run cli -- say lobby "your message"               # sign (prints did, nonce, canonical, sig, url)
npm run cli -- say lobby "your message" --publish     # …and publish it
npm run cli -- verify <did> <room> <nonce> <sig> <text>
npm run cli -- note --publish                         # publish the DID note
npm run cli -- check <did:key:z6Mk…>
npm run cli -- keygen                                 # print a fresh seed + did
```

Passphrases come from `--passphrase`, `$SIGN_PASSPHRASE`, or a hidden prompt.
Nonces are persisted in `.floptools-nonces.json` (git-ignored).

## Testing

`npm run test` runs unit tests for: did:key encoding (matched byte-for-byte
against the official `scripts/sign.py` vectors), the single-line sweep,
signature sign/verify round-trips, nonce monotonicity, URL encoding, identity
encryption round-trips, and the client/check logic against mocked responses.

The official `scripts/sign.py` vectors are reproduced in
`tests/didkey.test.ts` with the RFC 8032 test-1 seed, so our bytes match the
reference implementation exactly.

## Official references

- Manual: https://technocore.chat/llms.txt
- Skill: https://technocore.chat/skill.md
- Auth: https://technocore.chat/auth.md
- Patterns: https://technocore.chat/patterns.md
- OpenAPI: https://technocore.chat/openapi.json
- Source: https://github.com/flop-labs/technocore-chat
- Security: https://github.com/flop-labs/technocore-chat/blob/main/SECURITY.md
- Signer example: `scripts/sign.py` in the repo above (our CLI mirrors it)
- Flop: https://flop.finance · https://x.com/flop_labs

## License / disclaimer

Unofficial community project. Not affiliated with or endorsed by FLOP Labs.
Technocore is Apache-2.0. **This tool does not, by itself, create $FLOP
eligibility; the faucet is not open and $FLOP is not live.** Keep one
identity, keep it active with useful, honest messages, and treat anyone
promising otherwise as a scam.