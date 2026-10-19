#!/usr/bin/env node
// Regenerate the `target/` artifacts from the committed IDL.
//
// WHY THIS EXISTS
// ---------------
// `tests/escrow.ts` imports `../target/types/escrow`, and tests/**/*.ts is the only thing standing
// between this repo and a real verification run. But `target/` is a BUILD OUTPUT: it is gitignored,
// it only ever existed inside Solana Playground, and it does not survive a fresh clone. So anyone
// who clones this repo and runs the tests hits a missing import and concludes the project is broken.
//
// The IDL, by contrast, IS committed (idl/escrow.json) because it is a real artifact of a real
// successful build - it is the interface the program actually exposes. `anchor build` emits exactly
// two things into target/ that the tests consume: target/idl/escrow.json and target/types/escrow.ts.
// Both are pure mechanical restatements of the IDL. So this reconstructs them from the committed
// copy instead of asking every reader to reproduce a build environment first.
//
// This is NOT the same as `anchor build` - it cannot be, because it does not compile anything. It
// regenerates the type surface only. The program's behaviour still has to be proven by actually
// running the tests against a deployed .so, which is what the test suite is for.
//
//   node tools/make-target-types.js

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const idlPath = path.join(root, "idl", "escrow.json");

if (!fs.existsSync(idlPath)) {
  console.error(`no IDL at ${idlPath} - cannot regenerate target/`);
  process.exit(1);
}

const raw = fs.readFileSync(idlPath, "utf8");
let idl;
try {
  idl = JSON.parse(raw);
} catch (e) {
  console.error(`idl/escrow.json is not valid JSON: ${e.message}`);
  process.exit(1);
}

// Anchor derives the exported type name from the program name: escrow -> Escrow.
// The test file imports `{ Escrow }`, so this has to match that convention exactly.
const programName = (idl.metadata && idl.metadata.name) || idl.name || "escrow";
const typeName = programName
  .split(/[-_]/)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join("");

const pretty = JSON.stringify(idl, null, 2);

const idlOut = path.join(root, "target", "idl", `${programName}.json`);
const typesOut = path.join(root, "target", "types", `${programName}.ts`);
fs.mkdirSync(path.dirname(idlOut), { recursive: true });
fs.mkdirSync(path.dirname(typesOut), { recursive: true });

fs.writeFileSync(idlOut, pretty + "\n");
fs.writeFileSync(
  typesOut,
  `export type ${typeName} = ${pretty};\n\nexport const IDL: ${typeName} = ${pretty};\n`
);

// Report what was made, and prove the instruction names survived the round trip - a silently empty
// types file would satisfy the import and prove nothing.
const ixs = (idl.instructions || []).map((i) => i.name);
console.log(`wrote ${path.relative(root, idlOut)}`);
console.log(`wrote ${path.relative(root, typesOut)}`);
console.log(`program name : ${programName}`);
console.log(`exported type: ${typeName}`);
console.log(`instructions : ${ixs.length} [${ixs.join(", ")}]`);
if (ixs.length === 0) {
  console.error("WARNING: the IDL carries no instructions - the types file would be useless");
  process.exit(1);
}
