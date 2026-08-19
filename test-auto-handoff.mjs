import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import mod from "/Users/rcrd/AI/pi-local/extensions/auto-handoff.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"));
const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

function harness(windowSize = 100_000) {
  const handlers = {}; const notes = []; let compacts = 0; let tokens = 0;
  mod({ on: (e, h) => (handlers[e] = h), registerCommand: (n, o) => (handlers["/" + n] = o.handler), registerTool: () => {} });
  const ctx = {
    cwd: DIR,
    ui: { notify: (t) => notes.push(t) },
    getContextUsage: () => ({ tokens, contextWindow: windowSize, percent: (tokens / windowSize) * 100 }),
    compact: (opts) => { compacts++; opts.onComplete?.({ summary: "S", tokensBefore: tokens }); tokens = Math.floor(tokens * 0.3); },
  };
  return {
    notes, ctx, handlers,
    get compacts() { return compacts; },
    async turn(delta) { tokens += delta; await handlers["turn_end"]({}, ctx); return tokens; },
  };
}

// 1. Steady slow growth: no premature compaction well below the line.
let h = harness();
for (let i = 0; i < 6; i++) await h.turn(2_000);   // reaches 12%
check("does not compact while far from the limit", h.compacts === 0, `at ${(h.ctx.getContextUsage().percent).toFixed(0)}%`);

// 2. Big jumps: must act on the projection BEFORE crossing 85%.
h = harness();
await h.turn(20_000); await h.turn(20_000);        // 40%
const before = h.ctx.getContextUsage().percent;
await h.turn(20_000);                              // 60% — next two turns would blow past 85%
check(
  "compacts on the forecast, before the threshold is crossed",
  h.compacts === 1 && before < 85,
  `${h.notes[0] ?? ""}`,
);

// 3. A single huge jump still triggers the hard limit.
h = harness();
await h.turn(94_000);
check("hard limit catches a single oversized turn", h.compacts === 1, h.notes[0] ?? "");

// 4. The summary is written to disk.
check("writes the handoff summary", fs.existsSync(path.join(DIR, ".pi", "HANDOFF.md")),
  fs.existsSync(path.join(DIR, ".pi", "HANDOFF.md")) ? fs.readFileSync(path.join(DIR, ".pi", "HANDOFF.md"), "utf8").split("\n")[2] : "");

// 5. It compacts rather than swapping sessions (no newSession is even needed).
h = harness();
h.ctx.newSession = () => { throw new Error("must not swap sessions mid-task"); };
await h.turn(50_000); await h.turn(45_000);
check("never swaps sessions mid-task", h.compacts >= 1);

// 6. /context reports the growth rate and remaining turns.
h = harness();
await h.turn(5_000); await h.turn(5_000);
h.notes.length = 0;
await h.handlers["/context"]("", h.ctx);
check("/context reports rate and remaining room", /tokens\/turn/.test(h.notes.join(" ")), h.notes.join(" ").split("\n").slice(-1)[0]);

fs.rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
