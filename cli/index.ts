#!/usr/bin/env node
/**
 * floptools CLI — same signing rules as the web app, for power users.
 *
 *   node cli/index.ts init            create an encrypted identity file
 *   node cli/index.ts did             print the did:key for an identity file
 *   node cli/index.ts say <room> <text>          sign a message (prints did + sig + url)
 *   node cli/index.ts say <room> <text> --publish   ...and publish it
 *   node cli/index.ts verify <did> <room> <nonce> <sig> <text>
 *   node cli/index.ts note [--mailbox mb-p-...] [--publish]
 *   node cli/index.ts check <did>
 *   node cli/index.ts keygen          print a fresh seed + did:key
 *
 * Passphrase sources, in order: --passphrase, $SIGN_PASSPHRASE, hidden prompt.
 * Private keys exist only in this process's memory and in the encrypted file.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as readline from "node:readline";
import process from "node:process";
import {
  encryptIdentity,
  decryptIdentity,
  isIdentityFile,
  MIN_PASSPHRASE_LENGTH,
  DEFAULT_IDENTITY_FILENAME,
  type IdentityFile,
} from "../lib/identity";
import { generateSeed, publicKeyFromSeed, bytesToHex } from "../lib/crypto";
import { didFromPublicKey, didNotePaths } from "../lib/didkey";
import { signMessage, verifyMessage } from "../lib/sign";
import { nextNonce, isValidNonce } from "../lib/nonce";
import { TechnocoreClient } from "../lib/technocore";
import { checkDid } from "../lib/check";

const BASE = process.env.TECHNOCORE_BASE_URL ?? "https://technocore.chat";
const client = new TechnocoreClient({ baseUrl: BASE, mode: "direct" });

/* ---------- tiny arg parsing ---------- */

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/* ---------- passphrase ---------- */

function resolvePassphrase(flag: string | true | undefined): Promise<string> {
  if (typeof flag === "string" && flag) return Promise.resolve(flag);
  const env = process.env.SIGN_PASSPHRASE;
  if (env) return Promise.resolve(env);
  return promptHidden("passphrase: ");
}

function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const origWrite = process.stdout.write.bind(process.stdout);
    const swallow: typeof process.stdout.write = () => true;
    process.stdout.write = swallow;
    rl.question("", (ans) => {
      process.stdout.write = origWrite;
      process.stdout.write("\n");
      rl.close();
      resolve(ans);
    });
    rl.on("error", () => {
      process.stdout.write = origWrite;
    });
  });
}

/* ---------- identity file helpers ---------- */

function identityPath(file: string | true | undefined): string {
  return file && file !== true ? file : DEFAULT_IDENTITY_FILENAME;
}

function readIdentity(path: string): IdentityFile {
  if (!existsSync(path)) {
    throw new Error(`identity file not found: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isIdentityFile(parsed)) {
    throw new Error(`${path} is not a floptools identity file`);
  }
  return parsed;
}

/* ---------- nonce persistence (sidecar file, per did:room) ---------- */

const NONCE_FILE = ".floptools-nonces.json";

function loadNonceMap(): Record<string, string> {
  try {
    if (existsSync(NONCE_FILE)) {
      return JSON.parse(readFileSync(NONCE_FILE, "utf8")) as Record<string, string>;
    }
  } catch {
    /* ignore corrupt */
  }
  return {};
}

function lastNonceFor(did: string, room: string): string | undefined {
  return loadNonceMap()[`${did}::${room}`];
}

function saveNonceFor(did: string, room: string, nonce: string): void {
  const map = loadNonceMap();
  map[`${did}::${room}`] = nonce;
  writeFileSync(NONCE_FILE, JSON.stringify(map, null, 2) + "\n");
}

/* ---------- commands ---------- */

async function cmdInit(positional: string[], flags: Record<string, string | true>) {
  const path = identityPath(flags.file);
  if (existsSync(path)) {
    throw new Error(`${path} already exists — refusing to overwrite. Choose a new --file path.`);
  }
  const pass = await resolvePassphrase(flags.passphrase as string | undefined);
  if (pass.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const seed = generateSeed();
  const publicKey = publicKeyFromSeed(seed);
  const did = didFromPublicKey(publicKey);
  const file = await encryptIdentity(seed, did, publicKey, pass);
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  process.stdout.write(`did:      ${did}\n`);
  process.stdout.write(`file:     ${path}\n`);
  process.stdout.write(`back up ${path} and your passphrase separately. never commit ${path} to git.\n`);
}

async function cmdDid(positional: string[], flags: Record<string, string | true>) {
  const path = identityPath(flags.file);
  const file = readIdentity(path);
  const pass = await resolvePassphrase(flags.passphrase as string | undefined);
  const unlocked = await decryptIdentity(file, pass);
  process.stdout.write(`${unlocked.did}\n`);
}

async function cmdSay(positional: string[], flags: Record<string, string | true>) {
  if (positional.length < 2) {
    throw new Error("usage: say <room> <text> [--nonce N] [--publish] [--file path]");
  }
  const [room, ...rest] = positional;
  const text = rest.join(" ");
  const path = identityPath(flags.file);
  const file = readIdentity(path);
  const pass = await resolvePassphrase(flags.passphrase as string | undefined);
  const unlocked = await decryptIdentity(file, pass);
  let nonce: string;
  if (flags.nonce && flags.nonce !== true) {
    nonce = String(flags.nonce);
    if (!isValidNonce(nonce)) throw new Error("nonce must be 1-19 ASCII digits");
  } else {
    nonce = nextNonce(lastNonceFor(unlocked.did, room));
  }
  const msg = signMessage({ seed: unlocked.seed, room, nonce, text });
  saveNonceFor(msg.did, room, msg.nonce);

  process.stdout.write(`did:      ${msg.did}\n`);
  process.stdout.write(`nonce:    ${msg.nonce}\n`);
  process.stdout.write(`swept:    ${msg.sweptText}\n`);
  process.stdout.write(`canonical:${msg.canonical}\n`);
  process.stdout.write(`sig:      ${msg.sig}\n`);
  process.stdout.write(`url:      ${BASE}/r/${room}/say-signed/${msg.did}/${msg.sig}/${msg.nonce}/${encodeURIComponent(msg.sweptText)}\n`);

  if (flags.publish) {
    process.stdout.write(`\npublishing…\n`);
    const res = await client.writeSigned({
      room,
      did: msg.did,
      sig: msg.sig,
      nonce: msg.nonce,
      text: msg.sweptText,
    });
    process.stdout.write(`status:   ${res.status}\n`);
    process.stdout.write(`seq:      ${res.posted?.seq ?? "—"}\n`);
    process.stdout.write(`${res.body}\n`);
  }
}

async function cmdVerify(positional: string[], _flags: Record<string, string | true>) {
  if (positional.length < 5) {
    throw new Error("usage: verify <did> <room> <nonce> <sig> <text>");
  }
  const [did, room, nonce, sig, ...rest] = positional;
  const text = rest.join(" ");
  const res = verifyMessage({ did, room, nonce, text, sig });
  process.stdout.write(`canonical: ${res.canonical}\n`);
  process.stdout.write(`valid:     ${res.valid ? "yes" : "no"}${res.error ? ` (${res.error})` : ""}\n`);
  process.exitCode = res.valid ? 0 : 1;
}

async function cmdNote(positional: string[], flags: Record<string, string | true>) {
  const path = identityPath(flags.file);
  const file = readIdentity(path);
  const pass = await resolvePassphrase(flags.passphrase as string | undefined);
  const unlocked = await decryptIdentity(file, pass);
  const paths = await didNotePaths(unlocked.did);
  const mailbox = flags.mailbox && flags.mailbox !== true ? String(flags.mailbox) : undefined;
  const value = unlocked.did + (mailbox ? ` mailbox:${mailbox}` : "");

  process.stdout.write(`did:      ${unlocked.did}\n`);
  process.stdout.write(`note:     /kv/${paths.sharded.ns}/${paths.sharded.key}\n`);
  process.stdout.write(`value:    ${value}\n`);
  if (flags.publish) {
    process.stdout.write(`publishing…\n`);
    const res = await client.setNote(paths.sharded.ns, paths.sharded.key, value, {
      ifAbsent: !flags.force,
    });
    process.stdout.write(`status:   ${res.status}\n`);
    process.stdout.write(`${res.body}\n`);
  }
}

async function cmdCheck(positional: string[], _flags: Record<string, string | true>) {
  if (positional.length < 1) {
    throw new Error("usage: check <did:key:z6Mk...>");
  }
  const did = positional[0];
  const res = await checkDid(client, did);
  process.stdout.write(`did:      ${res.did}\n`);
  process.stdout.write(`note:     ${res.noteFound ? `present at /kv/${res.notePath}` : "absent"}\n`);
  process.stdout.write(`signed:   ${res.signedMessageCount} message(s) observed\n`);
  for (const a of res.activity) {
    process.stdout.write(`  /${a.room}: ${a.signedMessages} signed (of ${a.scannedMessages} scanned)${a.latestSeq ? ` · latest seq ${a.latestSeq}` : ""}\n`);
  }
  process.stdout.write(`state:    ${res.state.replace(/_/g, " ")}\n`);
}

function cmdKeygen() {
  const seed = generateSeed();
  const did = didFromPublicKey(publicKeyFromSeed(seed));
  process.stdout.write(`seed:     ${bytesToHex(seed)}\n`);
  process.stdout.write(`did:      ${did}\n`);
}

/* ---------- main ---------- */

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  try {
    switch (command) {
      case "init":
        await cmdInit(rest, flags);
        break;
      case "did":
        await cmdDid(rest, flags);
        break;
      case "say":
        await cmdSay(rest, flags);
        break;
      case "verify":
        await cmdVerify(rest, flags);
        break;
      case "note":
        await cmdNote(rest, flags);
        break;
      case "check":
        await cmdCheck(rest, flags);
        break;
      case "keygen":
        cmdKeygen();
        break;
      case undefined:
        process.stdout.write(
          "floptools CLI — same rules as the web app.\n\n" +
            "commands:\n" +
            "  init        create an encrypted identity file\n" +
            "  did         print the did:key\n" +
            "  say <room> <text> [--publish]\n" +
            "  verify <did> <room> <nonce> <sig> <text>\n" +
            "  note [--mailbox mb-p-...] [--publish] [--force]\n" +
            "  check <did>\n" +
            "  keygen\n" +
            "flags:\n" +
            "  --file <path>       identity file (default identity.json.enc)\n" +
            "  --passphrase <p>    or $SIGN_PASSPHRASE, or a hidden prompt\n" +
            "  --nonce <n>         explicit nonce for say\n" +
            "  --publish           actually POST to the server\n",
        );
        break;
      default:
        throw new Error(`unknown command: ${command}`);
    }
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

void main();