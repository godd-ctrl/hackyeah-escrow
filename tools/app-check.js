#!/usr/bin/env node
/**
 * CHECKS THE BROWSER APP AGAINST THE PROGRAM'S IDL.
 *
 * WHY THIS EXISTS.
 *
 * The app encodes six Anchor instructions by hand, because @coral-xyz/anchor's browser build needs a
 * bundler and mixing two copies of @solana/web3.js is a reliable way to get "instanceof PublicKey"
 * failures that read like RPC errors. Hand-encoding is fine; hand-encoding *unverified* is not, and
 * this app cannot be run against the program here because nothing is deployed to devnet and there is
 * no Solana toolchain on this machine.
 *
 * So the things that could be wrong are checked statically, against the IDL the program was compiled
 * with, which is the same source of truth the client would otherwise have trusted:
 *
 *   1. Every discriminator in the app must equal sha256("global:<snake_case>")[0..8] - the exact rule
 *      Anchor uses. The rule itself is validated in check 0 against Anchor's published constant for
 *      `initialize`, so a wrong hashing convention fails here rather than silently agreeing with
 *      itself.
 *   2. Every instruction the program exposes must be present in the app, and every instruction the
 *      app sends must exist in the program. A typo in a name produces a 16-hex discriminator that
 *      looks plausible and is rejected on chain with no useful message.
 *   3. The Escrow account size implied by the IDL must equal the size the decoder insists on. If the
 *      struct grows, the decoder must be updated, and a silent mismatch would misread every field
 *      after the change.
 *   4. The app must not reference Node's Buffer, which does not exist in a browser. This was a real
 *      bug in the first draft: `Buffer.from("escrow")` in the PDA derivation would have thrown on the
 *      first click.
 *
 * Usage: node tools/app-check.js
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const APP = path.join(ROOT, "app", "index.html");
const IDL = path.join(ROOT, "idl", "escrow.json");

let failures = 0;
const ok = (msg) => console.log("   PASS  " + msg);
const bad = (msg) => {
  failures++;
  console.log("   FAIL  " + msg);
};

console.log("");
console.log("  ===== APP <-> IDL CONSISTENCY =====");
console.log("");

const idl = JSON.parse(fs.readFileSync(IDL, "utf8"));
const html = fs.readFileSync(APP, "utf8");

const disc = (s) => crypto.createHash("sha256").update(s).digest().subarray(0, 8).toString("hex");
const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

// ---- 0. the hashing rule itself ----------------------------------------------------------------
// Anchor's `initialize` discriminator is a published constant. If this fails, every derived value
// below is wrong and the app would send instructions no program recognises.
if (disc("global:initialize") === "afaf6d1f0d989bed") ok("discriminator rule matches Anchor's published `initialize` constant");
else bad("discriminator rule is wrong - sha256('global:initialize')[0..8] is not afaf6d1f0d989bed");

// ---- 1. the app's table ------------------------------------------------------------------------
const tableBlock = html.match(/const IX = \{([\s\S]*?)\};/);
if (!tableBlock) {
  bad("could not find the IX discriminator table in app/index.html");
} else {
  const appTable = {};
  for (const m of tableBlock[1].matchAll(/(\w+)\s*:\s*"([0-9a-f]{16})"/g)) appTable[m[1]] = m[2];
  console.log("");
  console.log("  -- instruction discriminators --");
  for (const ins of idl.instructions) {
    const want = disc("global:" + snake(ins.name));
    const got = appTable[ins.name];
    if (!got) bad(`${ins.name}: missing from the app entirely`);
    else if (got !== want) bad(`${ins.name}: app ${got} != idl ${want}`);
    else ok(`${ins.name.padEnd(19)} ${got}`);
  }
  const idlNames = new Set(idl.instructions.map((i) => i.name));
  for (const name of Object.keys(appTable)) {
    if (!idlNames.has(name)) bad(`${name}: the app sends it but the program does not expose it`);
  }
}

// ---- 3. account layout --------------------------------------------------------------------------
console.log("");
console.log("  -- Escrow account layout --");
const SIZE = {
  publicKey: 32,
  u64: 8,
  i64: 8,
  u8: 1,
  u16: 2,
  u32: 4,
  bool: 1,
  i128: 16,
  u128: 16,
};
function fieldSize(t) {
  if (typeof t === "string") return SIZE[t] ?? NaN;
  // Option<T> in an Anchor ACCOUNT is 1 tag byte + sizeof(T), because the space is allocated up
  // front regardless of which variant is stored. Treating it as variable-length is the classic way
  // to misread every field after it.
  if (t.option) return 1 + fieldSize(t.option);
  if (t.defined) {
    const def = idl.types.find((x) => x.name === t.defined);
    if (!def) return NaN;
    const v = def.type.variants;
    return v ? 1 : def.type.fields.reduce((s, f) => s + fieldSize(f.type), 0);
  }
  if (t.vector) return NaN; // not used here; refusing to guess is better than guessing wrong
  if (t.array) return fieldSize(t.array[0]) * t.array[1];
  return NaN;
}
const escrow = idl.accounts.find((a) => a.name === "Escrow");
const body = escrow.type.fields.reduce((s, f) => s + fieldSize(f.type), 0);
const total = 8 + body;
console.log(`     fields total ${body} bytes + 8 discriminator = ${total}`);
if (Number.isFinite(total)) ok("layout is computable from the IDL");
else bad("layout contains a type this checker does not understand - fix the checker, do not ignore it");

const guard = html.match(/buf\.length\s*<\s*(\d+)/);
if (!guard) bad("the decoder has no length guard");
else if (Number(guard[1]) !== total) bad(`decoder insists on ${guard[1]} bytes but the IDL says ${total}`);
else ok(`decoder length guard matches the IDL (${total} bytes)`);

// ---- 4. browser safety ---------------------------------------------------------------------------
console.log("");
console.log("  -- browser safety --");
const scriptMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!scriptMatch) bad("no module script found");
else {
  const js = scriptMatch[1];
  const bufferHits = js.match(/\bBuffer\s*[.(]/g) || [];
  if (bufferHits.length) bad(`app uses Node's Buffer ${bufferHits.length} time(s) - it does not exist in a browser`);
  else ok("no direct Buffer usage");

  // node --check catches syntax errors, which is worth having because the app cannot be executed
  // here (no wallet, nothing deployed). It is a parse check, not a behaviour check - said out loud
  // so it is not mistaken for one.
  const tmp = path.join(process.env.TEMP || process.env.TMP || ".", "escrow-app-check.mjs");
  fs.writeFileSync(tmp, js);
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    ok("module parses (node --check) - parse only, not behaviour");
  } catch (e) {
    bad("module does not parse:\n" + String(e.stderr || e.message).slice(0, 800));
  }
}

console.log("");
if (failures) {
  console.log(`  ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("  ALL CHECKS PASSED");
console.log("");
