/**
 * Tests for the gate. Run:
 *   node --experimental-strip-types ~/.pi/lib/incremental-writes-rules.test.ts
 */
import { tooBig, DEFAULT_LIMITS } from "./incremental-writes-rules.ts"

const lines = (n: number) => Array.from({ length: n }, (_, i) => `const x${i} = ${i};`).join("\n")

const cases: [string, string | null, boolean][] = [
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

let failed = 0
for (const [name, result, shouldBlock] of cases) {
  const got = result !== null
  const ok = got === shouldBlock
  if (!ok) failed++
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : ` — expected ${shouldBlock ? "block" : "allow"}`}`)
}
console.log(failed ? `\n${failed} failing` : `\nall ${cases.length} cases pass`)
process.exit(failed ? 1 : 0)
