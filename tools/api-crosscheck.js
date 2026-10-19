// Cross-check the test suite against the program WITHOUT a Rust toolchain.
//
// This catches the failure mode a compiler would normally catch: the tests calling an instruction
// or an account that does not exist, or naming it differently. That drift is invisible until
// someone runs `anchor test`, which is exactly when you least want to discover it.
//
// It also checks Rust brace balance, since an unbalanced file is not a program.
//
// NOTE ON THIS CHECKER ITSELF: the first version matched `.accounts({...})` with a lazy
// `[\s\S]{0,240}?`, which let a call's account block be matched from the NEXT test. It reported 8
// failures that did not exist. A checker whose regex can wander across boundaries is worse than no
// checker, so the parse below is bounded: each instruction call is isolated by splitting on the
// `program.methods` marker that begins it.
const fs = require("fs");

const RUST = process.argv[2];
const TS = process.argv[3];
const rs = fs.readFileSync(RUST, "utf8");
const tsText = fs.readFileSync(TS, "utf8");

let failures = 0;
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const ok = (m) => console.log(`  ok    ${m}`);

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// ── 1. Rust structural sanity ────────────────────────────────────────────────────────────────────
console.log("\n  ===== Rust structure =====");
const rsClean = rs
  .replace(/\/\/[^\n]*/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/"(?:\\.|[^"\\])*"/g, '""');
for (const [open, close, name] of [["{", "}", "braces"], ["(", ")", "parens"], ["[", "]", "brackets"]]) {
  const o = (rsClean.match(new RegExp("\\" + open, "g")) || []).length;
  const c = (rsClean.match(new RegExp("\\" + close, "g")) || []).length;
  if (o === c) ok(`${name} balanced (${o})`);
  else fail(`${name} UNBALANCED: ${o} open vs ${c} close`);
}

// ── 2. instructions declared in #[program] ───────────────────────────────────────────────────────
console.log("\n  ===== instructions =====");
const programBlock = rs.slice(rs.indexOf("#[program]"), rs.indexOf("// ── state"));
const instructions = [...programBlock.matchAll(/pub fn (\w+)\s*\(\s*ctx:\s*Context<(\w+)>/g)]
  .map((m) => ({ fn: m[1], ctx: m[2] }));
if (instructions.length) ok(`${instructions.length} instructions found`);
else fail("no instructions parsed - the regex missed them, so this check proves nothing");

// ── 3. accounts in each #[derive(Accounts)] struct ───────────────────────────────────────────────
const structs = {};
for (const m of rs.matchAll(/#\[derive\(Accounts\)\][\s\S]*?pub struct (\w+)<'info>\s*\{([\s\S]*?)\n\}/g)) {
  structs[m[1]] = [...m[2].matchAll(/pub (\w+):/g)].map((x) => x[1]);
}
ok(`${Object.keys(structs).length} Accounts structs: ${Object.keys(structs).join(", ")}`);

const structByIx = Object.fromEntries(instructions.map((i) => [camel(i.fn), i.ctx]));
const declNames = new Set(instructions.map((i) => camel(i.fn)));

// ── 4. isolate each instruction call, then check it ──────────────────────────────────────────────
console.log("\n  ===== test -> program =====");
const chunks = tsText.split("program.methods").slice(1);
if (!chunks.length) fail("no `program.methods` calls found in the tests - check would be vacuous");

const exercised = new Set();
let accountKeysChecked = 0;
for (const chunk of chunks) {
  const m = chunk.match(/^\s*\.\s*(\w+)\s*\(/);
  if (!m) continue;
  const ix = m[1];
  exercised.add(ix);

  if (!declNames.has(ix)) {
    fail(`test calls .${ix}() which is NOT declared in the program`);
    continue;
  }

  // Only an INLINE account object can be checked here; the object literal is the boundary, so the
  // match cannot leak into the next call.
  const inline = chunk.match(/\.accounts\(\s*\{([^}]*)\}/);
  if (!inline) continue;
  const ctxStruct = structByIx[ix];
  const valid = new Set((structs[ctxStruct] || []).map(camel));
  if (!valid.size) { fail(`no accounts parsed for ${ctxStruct}`); continue; }
  for (const raw of inline[1].split(",")) {
    const key = raw.split(":")[0].trim();
    if (!key) continue;
    accountKeysChecked++;
    if (!valid.has(key)) {
      fail(`.${ix}() passes "${key}", not a field of ${ctxStruct} (has: ${[...valid].join(", ")})`);
    }
  }
}
ok(`inline account keys checked: ${accountKeysChecked} (0 problems means every one resolves)`);

// the accounts({...}) shape is only used inline; the helper form is checked separately
const helper = tsText.match(/const createAccounts =[\s\S]*?=> \(\s*\{([\s\S]*?)\n  \}\);/);
if (helper) {
  const valid = new Set((structs["CreateEscrow"] || []).map(camel));
  const keys = [...helper[1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1]);
  const bad = keys.filter((k) => !valid.has(k));
  if (bad.length) fail(`createAccounts() passes ${bad.join(", ")} - not on CreateEscrow`);
  else ok(`createAccounts() keys all exist on CreateEscrow (${keys.join(", ")})`);
} else {
  console.log("  note  helper createAccounts() not parsed - account-props form is unchecked");
}

// ── 5. every declared instruction is exercised ───────────────────────────────────────────────────
console.log("\n  ===== coverage: is every instruction tested? =====");
for (const i of instructions) {
  const n = camel(i.fn);
  if (exercised.has(n)) ok(`${n} is exercised`);
  else fail(`${n} is declared but NEVER called by any test - an untested instruction`);
}

// ── 6. which declared error messages does the suite assert on? ───────────────────────────────────
//
// Uses the TypeScript PARSER, not a quote regex. The regex version of this section silently
// under-reported coverage: pairing `"` characters by hand desynchronises the moment a template
// literal contains an empty string (`${x ?? ""}`), after which a target's opening quote pairs with
// a distant closing quote and the string vanishes from the extracted set. Regex cannot tokenise.
console.log("\n  ===== error-path coverage =====");
let tsMod = null;
try {
  tsMod = require("typescript");
  if (!tsMod.createSourceFile) tsMod = null; // typescript 7 native has a different API surface
} catch {
  tsMod = null;
}

if (!tsMod) {
  // Deliberately SKIP rather than approximate. An earlier version of this section used a quote
  // regex and reported coverage that was simply wrong. "Cannot check" is a usable answer;
  // a wrong number is not.
  console.log("  SKIP  typescript is not installed, so this section cannot run.");
  console.log("        install it (npm i -D typescript@5.6.3) or read the gap as UNKNOWN, not as zero.");
} else {
  const sf = tsMod.createSourceFile("tests.ts", tsText, tsMod.ScriptTarget.ES2020, true, tsMod.ScriptKind.TS);
  if ((sf.parseDiagnostics || []).length) {
    console.log(`  note  ${sf.parseDiagnostics.length} TS parse diagnostics (see tools/ts-parse-check.js)`);
  }
  const literals = [];
  const walk = (n) => {
    if (tsMod.isStringLiteral(n) || tsMod.isNoSubstitutionTemplateLiteral(n)) literals.push(n.text);
    else if (tsMod.isTemplateExpression(n)) {
      literals.push(n.head.text);
      for (const sp of n.templateSpans) literals.push(sp.literal.text);
    }
    tsMod.forEachChild(n, walk);
  };
  walk(sf);

  const declared = [...rs.matchAll(/#\[msg\("([^"]+)"\)\]\s*\n\s*(\w+),/g)].map((m) => ({ msg: m[1], variant: m[2] }));
  if (!declared.length) fail("no #[msg(...)] variants parsed - the regex missed them");
  const asserted = [];
  for (const d of declared) {
    // the tests may assert the whole message or a distinctive fragment of it
    const hit = literals.includes(d.msg) || literals.some((s) => s.length >= 12 && d.msg.includes(s));
    if (hit) asserted.push(d);
  }
  ok(`${literals.length} string literals parsed from the tests`);
  if (asserted.length) ok(`${declared.length} error variants declared, ${asserted.length} asserted:`);
  else fail(`${declared.length} error variants declared, NONE asserted`);
  const unasserted = declared.filter((d) => !asserted.includes(d));
  for (const u of unasserted) console.log(`        UNTESTED rejection path: ${u.variant} ("${u.msg}")`);
  if (unasserted.length) console.log(`        ^ honest gaps: rejection paths with no test behind them`);
}

console.log(`\n  ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}\n`);
process.exit(failures ? 1 : 0);
