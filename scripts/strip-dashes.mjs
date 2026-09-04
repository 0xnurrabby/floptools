// One-shot: strip every em/en dash from user-facing source strings.
// Run once with `node scripts/strip-dashes.js`. Idempotent.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIRS = ["app", "components", "lib"];
const FILES = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(name)) FILES.push(p);
  }
}
for (const d of DIRS) walk(d);

let changed = 0;
for (const file of FILES) {
  let s = readFileSync(file, "utf8");
  const before = s;

  // standalone placeholders
  s = s.replaceAll('?? "\u2014"', '?? "n/a"');
  s = s.replaceAll('text-mute">\u2014</span>', 'text-mute">n/a</span>');
  // brand titles keep the middot separator
  s = s.replaceAll("floptools \u2014 keep", "floptools \u00b7 keep");
  s = s.replaceAll("floptools \u2014 one", "floptools \u00b7 one");
  // explanatory sentences read best with a colon or middot
  s = s.replaceAll(" \u2014 ", " \u00b7 ");
  // any leftover dash becomes a plain hyphen
  s = s.replaceAll("\u2014", "-");
  s = s.replaceAll("\u2013", "-");

  if (s !== before) {
    writeFileSync(file, s, "utf8");
    changed++;
  }
}
console.log(`scanned ${FILES.length} files, changed ${changed}`);

let remaining = 0;
for (const file of FILES) {
  const s = readFileSync(file, "utf8");
  if (s.includes("\u2014") || s.includes("\u2013")) {
    console.log("remaining:", file);
    remaining++;
  }
}
console.log(remaining === 0 ? "CLEAN: no em/en dashes left" : `WARNING: ${remaining} files still contain dashes`);
