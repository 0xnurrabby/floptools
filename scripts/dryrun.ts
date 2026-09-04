// Live dry-run: create -> restore -> sign lobby -> publish note -> check DID.
// Uses a fresh throwaway key against the real public instance.
import { readFileSync } from "node:fs";
import { encryptIdentity, decryptIdentity, isIdentityFile } from "../lib/identity";
import { generateSeed, publicKeyFromSeed } from "../lib/crypto";
import { didFromPublicKey, didNotePaths } from "../lib/didkey";
import { signMessage } from "../lib/sign";
import { nextNonce } from "../lib/nonce";
import { TechnocoreClient } from "../lib/technocore";
import { checkDid, verifyRecord } from "../lib/check";

const BASE = "https://technocore.chat";
const client = new TechnocoreClient({ baseUrl: BASE, mode: "direct" });
const PASSPHRASE = "dry-run passphrase 123!";
const FILE = "C:/Users/Nur/AppData/Local/Temp/opencode/dryrun.enc";
import { writeFileSync } from "node:fs";

async function main() {
  const step = (s: string) => console.log(`\n== ${s} ==`);

  step("1. create (generate + encrypt identity file)");
  const seed = generateSeed();
  const pub = publicKeyFromSeed(seed);
  const did = didFromPublicKey(pub);
  const file = await encryptIdentity(seed, did, pub, PASSPHRASE);
  writeFileSync(FILE, JSON.stringify(file));
  console.log("did:", did);
  if (!isIdentityFile(JSON.parse(readFileSync(FILE, "utf8")))) throw new Error("identity file invalid");
  console.log("encrypted file written + validated");

  step("2. restore (decrypt identity file)");
  const restored = await decryptIdentity(file, PASSPHRASE);
  if (restored.did !== did) throw new Error("did mismatch after restore");
  console.log("restored did:", restored.did);

  step("3. sign + publish to lobby");
  const nonce = nextNonce();
  const msg = signMessage({ seed, room: "lobby", nonce, text: "Dry-run from the floptools live test — a fresh throwaway key." });
  const res = await client.writeSigned({ room: "lobby", did: msg.did, sig: msg.sig, nonce: msg.nonce, text: msg.sweptText });
  console.log("status:", res.status, "| seq:", res.posted?.seq);
  if (!res.posted?.seq) throw new Error("publish failed");

  step("4. verify the exact record we just published (deterministic)");
  const vr = await verifyRecord(client, "lobby", res.posted.seq, did);
  console.log("found:", vr.found, "| valid:", vr.valid, "| error:", vr.error ?? "none");

  step("5. publish DID note");
  const paths = await didNotePaths(did);
  const noteRes = await client.setNote(paths.sharded.ns, paths.sharded.key, did, { ifAbsent: true });
  console.log("note status:", noteRes.status, "| path: /kv/" + paths.sharded.ns + "/" + paths.sharded.key);

  step("6. check the DID on the public ledger");
  const check = await checkDid(client, did);
  console.log("note present:", check.noteFound);
  console.log("signed observed:", check.signedMessageCount, "(of last-200 tail per room)");
  console.log("state:", check.state);
  for (const a of check.activity) console.log(`  /${a.room}: ${a.signedMessages} signed (scanned ${a.scannedMessages})`);

  console.log("\ndry-run complete.");
}

main().catch((e) => {
  console.error("DRY-RUN FAILED:", e.message);
  process.exitCode = 1;
});