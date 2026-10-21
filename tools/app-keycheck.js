#!/usr/bin/env node
/**
 * RUNS THE APP'S OWN ENCODER CODE AND CHECKS IT AGAINST THE IDL AND THE LIBRARY.
 *
 * WHY THIS EXISTS, AND WHY tools/app-check.js WAS NOT ENOUGH.
 *
 * app-check.js proves the discriminators are right, because those are pure hashes and can be
 * recomputed. It cannot prove the *account order* is right, and account order is the failure mode
 * that matters most: Anchor matches accounts positionally, so swapping two keys produces a
 * perfectly well-formed transaction that the program rejects with a constraint error nobody can
 * read. A wrong discriminator at least looks different; a swapped key looks correct.
 *
 * So this harness takes the real <script> block out of app/index.html, swaps only its CDN loader for
 * the real @solana/web3.js (installed in an isolated workspace, not in this repo), stubs the DOM just
 * enough for the module to evaluate, and then calls the shipped encoders. The assertions come from
 * idl/escrow.json - not from a copy of the app's own opinion - so this can genuinely fail.
 *
 * It also round-trips the Escrow decoder on a synthetic account laid out from the IDL, including the
 * case that matters: an Option<Pubkey> that is None still occupies 1 + 32 bytes, and a decoder that
 * forgot that would silently misread every field after it.
 *
 * WHAT THIS STILL DOES NOT PROVE.
 *
 * It does not run the program. There is no Solana toolchain on this machine and nothing is deployed
 * to devnet, so "the client builds the instruction the Rust program expects" is verified against the
 * IDL the program was compiled with, not against a live program. That limitation is stated in the
 * README rather than implied to be tested.
 *
 * Setup (once), in an isolated workspace:
 *   npm install --prefix "%TEMP%\opencode\escrow-check" @solana/web3.js@1.95.8
 *
 * Usage:
 *   node tools/app-keycheck.js
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const APP = path.join(ROOT, "app", "index.html");
const IDL = path.join(ROOT, "idl", "escrow.json");
const WORK = path.join(os.tmpdir(), "opencode", "escrow-check");

let failures = 0;
const ok = (m) => console.log("   PASS  " + m);
const bad = (m) => { failures++; console.log("   FAIL  " + m); };

console.log("");
console.log("  ===== APP ENCODERS vs IDL (behavioural) =====");
console.log("");

if (!fs.existsSync(path.join(WORK, "node_modules", "@solana", "web3.js"))) {
  console.log("  @solana/web3.js is not installed in " + WORK);
  console.log("  run: npm install --prefix \"" + WORK + "\" @solana/web3.js@1.95.8");
  process.exit(2);
}

const idl = JSON.parse(fs.readFileSync(IDL, "utf8"));
const html = fs.readFileSync(APP, "utf8");

/* -------------------------------------------------------------------------------------------------
   BUILD A RUNNABLE COPY OF THE APP'S MODULE

   Only two edits are made, and both are asserted to have happened. An edit that silently does not
   apply would leave the CDN loader in place, the import would hit the network, and the test would be
   measuring something other than the shipped code.
   ------------------------------------------------------------------------------------------------- */
const scriptMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.log("  no module script found in app/index.html"); process.exit(1); }
let js = scriptMatch[1];

const LOADER = "const web3 = await loadWeb3();";
if (!js.includes(LOADER)) { console.log("  could not find the loader line - the harness is out of date"); process.exit(1); }
// The CDN loader is replaced by the real package, resolved from this temp directory's node_modules.
// m.default matters: the package resolves to CommonJS here, and its exports live on module.exports.
js = js.replace(LOADER, 'const web3 = await import("@solana/web3.js").then((m) => m.default ?? m);');

const BOOT = "\nboot();";
if (!js.includes(BOOT)) { console.log("  could not find the boot() call - the harness is out of date"); process.exit(1); }
// boot() reads localStorage and hits the network to check whether the program is deployed. Neither
// is under test here, and a flaky public RPC should not be able to fail an encoding check.
js = js.replace(BOOT, "\n");

/* Minimal DOM. The module wires click handlers at import time; that is the only reason any of this
   exists. Anything not stubbed would throw at import and be reported as a failure to load. */
const stubEl = () => ({
  addEventListener() {}, prepend() {}, remove() {},
  value: "", textContent: "", className: "", innerHTML: "", hidden: false,
  disabled: false, style: {}, childElementCount: 0, lastElementChild: { remove() {} },
});
// navigator is deliberately not stubbed: recent Node defines it as a getter-only global, so assigning
// to it throws, and the app only touches navigator.clipboard inside a click handler that never runs
// here. A stub is not needed; a crash at import would be.
const stubs = `
globalThis.document = { getElementById: () => (${stubEl.toString()})(), createElement: () => (${stubEl.toString()})() };
globalThis.window = {};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
`;

const EXPORTS = `
export { createEscrowIx, acceptEscrowIx, approveMilestoneIx, cancelEscrowIx, claimUnreviewedIx,
         closeEscrowIx, escrowPda, vaultPda, decodeEscrow, ataFor, DEFAULT_PROGRAM_ID };
`;

const tempFile = path.join(WORK, "app-under-test.mjs");
fs.writeFileSync(tempFile, stubs + js + EXPORTS);

let app;
try {
  app = await import(pathToFileURL(tempFile).href);
} catch (e) {
  console.log("  the app module failed to load: " + (e && e.message));
  console.log("  (a failure here usually means the DOM stub is missing something the module touches at import)");
  process.exit(1);
}
ok("app module evaluates with the real @solana/web3.js");

/* Resolve the package entry through its own package.json rather than importing the directory: Node's
   ESM resolver refuses directory imports, and hard-coding lib/index.cjs.js would break silently on a
   version bump rather than failing loudly here. */
const web3Dir = path.join(WORK, "node_modules", "@solana", "web3.js");
const web3Pkg = JSON.parse(fs.readFileSync(path.join(web3Dir, "package.json"), "utf8"));
const web3File = path.join(web3Dir, web3Pkg.main || "lib/index.cjs.js");
if (!fs.existsSync(web3File)) {
  console.log("  web3 entry not found at " + web3File);
  process.exit(2);
}
const { PublicKey, Keypair } = await import(pathToFileURL(web3File).href).then((m) => m.default ?? m);

/* Known-by-definition accounts, so the IDL name -> pubkey mapping is explicit rather than inferred. */
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
const RENT = new PublicKey("SysvarRent111111111111111111111111111111111");
const PROGRAM = new PublicKey(app.DEFAULT_PROGRAM_ID);

const kp = {
  client: Keypair.generate(),
  freelancer: Keypair.generate(),
  mint: Keypair.generate(),
  clientAta: Keypair.generate(),
  freelancerAta: Keypair.generate(),
};

/* A fixed, plausible deadline. It has to be inside the i64 range and, more importantly, it has to be
   a value whose little-endian bytes are not palindromic - otherwise a byte-order bug in the
   deadline encoding would round-trip and pass. */
const DEADLINE = 1767225600n; // 2026-01-01T00:00:00Z
const AMOUNT = 300000000n;    // 300 tokens at 6 decimals
const MILESTONES = 3;

/* -------------------------------------------------------------------------------------------------
   ASSERTIONS
   ------------------------------------------------------------------------------------------------- */
const DISC = {
  createEscrow: "fdd7a574246c4450",
  acceptEscrow: "c102e0f52474419a",
  approveMilestone: "91555c3c3282db6a",
  cancelEscrow: "9ccb36b326482115",
  claimUnreviewed: "8a20068f9aacf496",
  closeEscrow: "8bab5e92bf5b9032",
};

const hex = (u8) => Buffer.from(u8).toString("hex");

/**
 * The heart of the test: for one instruction, compare the built keys against the IDL's account list
 * position by position, including the signer/writable flags. `name -> pubkey` is supplied by the
 * caller, so a key that is present but in the wrong slot is caught, which is exactly the mistake a
 * discriminator check cannot see.
 */
function checkKeys(label, ins, expectedByRole) {
  const idlIns = idl.instructions.find((i) => i.name === label);
  if (!idlIns) { bad(label + ": not in the IDL"); return; }
  if (!ins) { bad(label + ": the app produced no instruction"); return; }

  if (ins.programId.toBase58() !== PROGRAM.toBase58()) {
    bad(label + `: program id is ${ins.programId.toBase58()}, expected ${PROGRAM.toBase58()}`);
  }
  if (ins.keys.length !== idlIns.accounts.length) {
    bad(label + `: ${ins.keys.length} accounts, IDL says ${idlIns.accounts.length}`);
    return;
  }
  let rowBad = 0;
  idlIns.accounts.forEach((acc, i) => {
    const got = ins.keys[i];
    const want = expectedByRole[acc.name];
    if (!want) { bad(`${label}.${acc.name}: harness has no key for this account name`); rowBad++; return; }
    if (got.pubkey.toBase58() !== want.toBase58()) {
      bad(`${label}.${acc.name} [${i}]: ${got.pubkey.toBase58()} != expected ${want.toBase58()}`);
      rowBad++;
    }
    if (got.isSigner !== acc.isSigner) {
      bad(`${label}.${acc.name} [${i}]: isSigner=${got.isSigner}, IDL says ${acc.isSigner}`);
      rowBad++;
    }
    if (got.isWritable !== acc.isMut) {
      bad(`${label}.${acc.name} [${i}]: isWritable=${got.isWritable}, IDL says ${acc.isMut}`);
      rowBad++;
    }
  });
  if (!rowBad) ok(label.padEnd(19) + ` ${ins.keys.length} accounts in IDL order, flags match`);
}

/* ---- createEscrow ----------------------------------------------------------------------------- */
const created = app.createEscrowIx(kp.client.publicKey, kp.mint.publicKey, kp.clientAta.publicKey, AMOUNT, MILESTONES, DEADLINE);
const escrowAddr = app.escrowPda(kp.client.publicKey, kp.mint.publicKey, DEADLINE);
const vaultAddr = app.vaultPda(escrowAddr);

if (created.escrow.toBase58() !== escrowAddr.toBase58()) {
  bad("createEscrow returns a different escrow address than escrowPda derives");
} else {
  ok("createEscrow returns the same PDA it encodes against");
}

checkKeys("createEscrow", created.ix, {
  client: kp.client.publicKey,
  escrow: escrowAddr,
  mint: kp.mint.publicKey,
  clientTokenAccount: kp.clientAta.publicKey,
  vault: vaultAddr,
  tokenProgram: TOKEN_PROGRAM,
  systemProgram: SYSTEM_PROGRAM,
  rent: RENT,
});

/* Data layout: discriminator + u64 + u8 + i64 = 8 + 8 + 1 + 8 = 25 bytes. The values are read back
   with an independent DataView rather than trusting the encoder's own arithmetic. */
const d = created.ix.data;
if (d.length !== 25) bad(`createEscrow data is ${d.length} bytes, expected 25 (8 + u64 + u8 + i64)`);
else {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const a = dv.getBigUint64(8, true);
  const m = d[16];
  const dl = dv.getBigInt64(17, true);
  if (hex(d.subarray(0, 8)) !== DISC.createEscrow) bad("createEscrow discriminator bytes are wrong");
  else if (a !== AMOUNT) bad(`createEscrow amount round-trips as ${a}, expected ${AMOUNT}`);
  else if (m !== MILESTONES) bad(`createEscrow milestones round-trips as ${m}, expected ${MILESTONES}`);
  else if (dl !== DEADLINE) bad(`createEscrow deadline round-trips as ${dl}, expected ${DEADLINE}`);
  else ok(`createEscrow data 25 bytes, values round-trip (amount, milestones, deadline)`);
}

/* ---- the rest --------------------------------------------------------------------------------- */
const accepted = app.acceptEscrowIx(kp.freelancer.publicKey, escrowAddr);
checkKeys("acceptEscrow", accepted, {
  freelancer: kp.freelancer.publicKey,
  escrow: escrowAddr,
});

const approved = app.approveMilestoneIx(kp.client.publicKey, escrowAddr, kp.freelancer.publicKey, kp.mint.publicKey, vaultAddr, kp.freelancerAta.publicKey);
checkKeys("approveMilestone", approved, {
  client: kp.client.publicKey,
  escrow: escrowAddr,
  freelancer: kp.freelancer.publicKey,
  mint: kp.mint.publicKey,
  vault: vaultAddr,
  freelancerTokenAccount: kp.freelancerAta.publicKey,
  tokenProgram: TOKEN_PROGRAM,
});

const cancelled = app.cancelEscrowIx(kp.client.publicKey, escrowAddr, kp.mint.publicKey, vaultAddr, kp.clientAta.publicKey);
checkKeys("cancelEscrow", cancelled, {
  client: kp.client.publicKey,
  escrow: escrowAddr,
  mint: kp.mint.publicKey,
  vault: vaultAddr,
  clientTokenAccount: kp.clientAta.publicKey,
  tokenProgram: TOKEN_PROGRAM,
});

const claimed = app.claimUnreviewedIx(kp.freelancer.publicKey, escrowAddr, kp.mint.publicKey, vaultAddr, kp.freelancerAta.publicKey);
checkKeys("claimUnreviewed", claimed, {
  freelancer: kp.freelancer.publicKey,
  escrow: escrowAddr,
  mint: kp.mint.publicKey,
  vault: vaultAddr,
  freelancerTokenAccount: kp.freelancerAta.publicKey,
  tokenProgram: TOKEN_PROGRAM,
});

const closed = app.closeEscrowIx(kp.client.publicKey, escrowAddr, vaultAddr);
checkKeys("closeEscrow", closed, {
  client: kp.client.publicKey,
  escrow: escrowAddr,
  vault: vaultAddr,
  tokenProgram: TOKEN_PROGRAM,
});

/* ---- argument-free instructions must carry exactly the discriminator ---------------------------- */
for (const [name, ins] of Object.entries({ acceptEscrow: accepted, approveMilestone: approved, cancelEscrow: cancelled, claimUnreviewed: claimed, closeEscrow: closed })) {
  if (ins.data.length !== 8) bad(`${name} data is ${ins.data.length} bytes, expected only the 8-byte discriminator`);
  else if (hex(ins.data) !== DISC[name]) bad(`${name} discriminator bytes are wrong`);
  else ok(name.padEnd(19) + " data is exactly the discriminator");
}

/* ---- ataFor ------------------------------------------------------------------------------------ */
{
  const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const expected = PublicKey.findProgramAddressSync(
    [kp.client.publicKey.toBuffer(), TOKEN_PROGRAM.toBuffer(), kp.mint.publicKey.toBuffer()],
    ATA_PROGRAM
  )[0];
  if (app.ataFor(kp.client.publicKey, kp.mint.publicKey).toBase58() !== expected.toBase58()) {
    bad("ataFor does not derive the associated token account for (owner, tokenProgram, mint)");
  } else ok("ataFor matches the associated-token-account derivation");
}

/* ---- the decoder -------------------------------------------------------------------------------

   A synthetic account is laid out from the IDL, not from the decoder: 8 discriminator bytes, then
   each field at its own offset, with the Option<Pubkey> written as tag + 32 bytes even when None.
   If the decoder's offsets have drifted, this reads back wrong numbers. */
function buildEscrowAccount({ freelancer, status }) {
  const buf = new Uint8Array(126);
  buf.set(Buffer.from("1fd57bbbba16da9b", "hex"), 0);
  let o = 8;
  buf.set(kp.client.publicKey.toBuffer(), o); o += 32;
  if (freelancer) { buf[o] = 1; buf.set(freelancer.toBuffer(), o + 1); } else { buf[o] = 0; }
  o += 1 + 32; // the option's payload is always reserved, even when the tag is 0
  buf.set(kp.mint.publicKey.toBuffer(), o); o += 32;
  new DataView(buf.buffer).setBigUint64(o, AMOUNT, true); o += 8;
  buf[o] = MILESTONES; o += 1;
  buf[o] = 1; o += 1; // approved
  new DataView(buf.buffer).setBigInt64(o, DEADLINE, true); o += 8;
  buf[o] = status; o += 1;
  buf[o] = 255; o += 1; // bump
  buf[o] = 254; o += 1; // vault bump
  if (o !== 126) throw new Error("harness built " + o + " bytes, expected 126");
  return buf;
}

{
  const withFreelancer = app.decodeEscrow(buildEscrowAccount({ freelancer: kp.freelancer.publicKey, status: 1 }));
  if (!withFreelancer) bad("decoder rejected a valid-looking account");
  else if (withFreelancer.client.toBase58() !== kp.client.publicKey.toBase58()) bad("decoder misread client");
  else if (!withFreelancer.freelancer || withFreelancer.freelancer.toBase58() !== kp.freelancer.publicKey.toBase58()) bad("decoder misread freelancer");
  else if (withFreelancer.mint.toBase58() !== kp.mint.publicKey.toBase58()) bad("decoder misread mint");
  else if (withFreelancer.amount !== AMOUNT) bad(`decoder misread amount (${withFreelancer.amount})`);
  else if (withFreelancer.milestones !== MILESTONES) bad(`decoder misread milestones (${withFreelancer.milestones})`);
  else if (withFreelancer.approved !== 1) bad(`decoder misread approved (${withFreelancer.approved})`);
  else if (withFreelancer.deadline !== DEADLINE) bad(`decoder misread deadline (${withFreelancer.deadline})`);
  else if (withFreelancer.status !== 1) bad(`decoder misread status (${withFreelancer.status})`);
  else if (withFreelancer.bump !== 255 || withFreelancer.vaultBump !== 254) bad("decoder misread the bumps");
  else ok("decoder round-trips a full account (Some(freelancer))");

  const none = app.decodeEscrow(buildEscrowAccount({ freelancer: null, status: 0 }));
  if (!none) bad("decoder rejected an account whose freelancer is None");
  else if (none.freelancer !== null) bad("decoder invented a freelancer where the tag says None");
  // This is the assertion that catches the classic error: if None consumed only 1 byte, every field
  // after it would shift by 32 and the amount would come back as garbage rather than 300000000.
  else if (none.amount !== AMOUNT) bad(`decoder misread amount after None freelancer (${none.amount}) - option padding is wrong`);
  else ok("decoder handles None(freelancer) without shifting later fields");

  const wrong = app.decodeEscrow(new Uint8Array(126));
  if (wrong !== null) bad("decoder accepted an account with the wrong discriminator");
  else ok("decoder rejects a wrong discriminator");
}

console.log("");
if (failures) {
  console.log(`  ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("  ALL CHECKS PASSED");
console.log("");
