// The write gate. This lived in lib/ as a .ts file that nothing ran: it printed
// "pass"/"FAIL" in a format the runner does not parse, so it claimed coverage
// it was not providing.
import { tooBig, DEFAULT_LIMITS } from "../lib/incremental-writes-rules.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

const lines = (n) => Array.from({ length: n }, (_, i) => `const x${i} = ${i};`).join("\n");

const cases = [
  // The real failure: a whole game as one index.html.
  ["giant new html file", tooBig("pang-clone/index.html", lines(2000), false), true],
  ["giant rewrite of existing source", tooBig("src/game.ts", lines(900), true), true],
  // Must NOT fire — these are normal work.
  ["small new file", tooBig("src/player.ts", lines(80), false), false],
  ["file exactly at the ceiling", tooBig("src/a.ts", lines(DEFAULT_LIMITS.maxLines), false), false],
  // Formats where one big write is the only sensible shape.
  ["large json data", tooBig("data/seed.json", lines(5000), false), false],
  ["large markdown doc", tooBig("PLAN.md", lines(1200), false), false],
  ["generated output", tooBig("src/generated/Manifest.php", lines(5000), true), false],
  // Bytes matter independently of line count: one enormous line still fails.
  ["one absurdly long line", tooBig("src/blob.ts", "x".repeat(40_000), false), true],
]


for (const [name, result, shouldBlock] of cases) {
  check(`${shouldBlock ? "blocks" : "allows"}: ${name}`, (result !== null) === shouldBlock);
}

// The limits have to stay reachable, or every case above passes vacuously.
check("the line ceiling is a real number", Number.isFinite(DEFAULT_LIMITS.maxLines) && DEFAULT_LIMITS.maxLines > 0,
  String(DEFAULT_LIMITS.maxLines));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
