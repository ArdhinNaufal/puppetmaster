/**
 * CLI for the eval harness (Stage 5): `pnpm eval [--k N]`. Runs the golden
 * suite against ephemeral PGlite stores with the mock provider and prints a
 * pass^k table; exit code 1 when any task fails.
 */
import { runSuite } from "./eval/harness.js";

const kFlag = process.argv.indexOf("--k");
const k = kFlag > -1 ? Math.max(1, Number(process.argv[kFlag + 1] ?? 3)) : 3;

const suite = await runSuite(k);

console.log(`\nGolden suite · pass^${suite.k} · ${suite.passed}/${suite.total} tasks passed\n`);
for (const r of suite.results) {
  const marks = r.passes.map((p) => (p ? "✓" : "✗")).join("");
  console.log(`  ${r.pass ? "PASS" : "FAIL"}  [${marks}]  ${r.id} — ${r.description}`);
  for (const note of r.notes) console.log(`        ${note}`);
}
console.log();
process.exit(suite.passed === suite.total ? 0 : 1);
