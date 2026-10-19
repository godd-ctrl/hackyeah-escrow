const ts = require("typescript");
const fs = require("fs");
const p = process.argv[2];
const src = fs.readFileSync(p, "utf8");
const sf = ts.createSourceFile(p, src, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
const diags = sf.parseDiagnostics || [];
console.log(`  file: ${p}`);
console.log(`  lines: ${src.split("\n").length}   parse diagnostics: ${diags.length}`);
for (const d of diags.slice(0, 20)) {
  const { line, character } = sf.getLineAndCharacterOfPosition(d.start);
  console.log(`    ${line + 1}:${character + 1}  ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}
// count the tests so the suite's size is not a guess
let itCount = 0, describeCount = 0, awaits = 0;
const walk = (n) => {
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
    if (n.expression.text === "it") itCount++;
    if (n.expression.text === "describe") describeCount++;
  }
  if (n.kind === ts.SyntaxKind.AwaitExpression) awaits++;
  ts.forEachChild(n, walk);
};
walk(sf);
console.log(`  describes: ${describeCount}   its: ${itCount}   awaits: ${awaits}`);
process.exit(diags.length ? 1 : 0);
