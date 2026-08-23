// Compaction is a model call on a large prompt, so it takes as long as a turn.
// A spinner that says nothing about elapsed time makes a slow compaction and a
// wedged one look identical.
process.env.PI_COMPACT_MIN_GAP_MS = "0";
process.env.PI_KEEP_RECENT_TOKENS = "9800";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
import { STATE_DIR, statePath } from "../lib/state-dir.ts";
const { requestCompaction, resetCompactionState, progressLabel, estimateMs, recordCompactionMs } =
  await import("../lib/compaction.ts");

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

// --- the label -------------------------------------------------------------
check("with no history it is just a clock", progressLabel(3000, undefined) === "compacting 3s",
  "the first compaction in a project has nothing to compare against");
check("a bar appears once there is something to compare against",
  progressLabel(15_000, 30_000).includes("15s / ~30s") && /█+░+/.test(progressLabel(15_000, 30_000)));
check("the bar fills in proportion",
  (progressLabel(15_000, 30_000).match(/█/g) ?? []).length === 5, progressLabel(15_000, 30_000));
check("past the estimate it stops predicting and says so",
  progressLabel(42_000, 30_000) === "compacting ██████████ 42s (over 30s)",
  "a bar that keeps growing past the end is lying");
check("the bar never overflows its width",
  (progressLabel(600_000, 30_000).match(/[█░]/g) ?? []).length === 10);
check("zero elapsed is not an error", progressLabel(0, 30_000).includes("0s"));

// --- the estimate ----------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phi-progress-"));
fs.mkdirSync(path.join(dir, STATE_DIR), { recursive: true });
const timesFile = path.join(dir, STATE_DIR, "compaction-times.json");

check("no file means no estimate", estimateMs(dir) === undefined);
check("no cwd means no estimate", estimateMs(undefined) === undefined,
  "some contexts have no project directory");
fs.writeFileSync(timesFile, JSON.stringify([10_000, 20_000, 30_000]));
check("the estimate is the mean of what was recorded", estimateMs(dir) === 20_000);
fs.writeFileSync(timesFile, "not json");
check("a corrupt file is ignored rather than thrown", estimateMs(dir) === undefined);
fs.writeFileSync(timesFile, JSON.stringify([1, "x", -5, null, 8000]));
check("nonsense entries are dropped", estimateMs(dir) === Math.round((1 + 8000) / 2),
  "a negative or non-numeric duration would poison the average");

// --- the ticker ------------------------------------------------------------
fs.rmSync(timesFile, { force: true });
const status = new Map();
let opts = null;
const ctx = {
  cwd: dir,
  ui: { notify: () => {}, setStatus: (k, v) => (v === undefined ? status.delete(k) : status.set(k, v)) },
  getContextUsage: () => ({ tokens: 40_000, contextWindow: 65_536 }),
  compact: (o) => { opts = o; },
};
resetCompactionState();
requestCompaction(ctx, "test", { force: true });
check("a chip appears as soon as compaction starts", [...status.values()].some((v) => v.startsWith("compacting")),
  [...status.values()].join(" | "));

opts.onComplete({ summary: "s", tokensBefore: 1 });
check("the chip is removed when it finishes", status.size === 0);
check("an implausibly fast compaction is not recorded", !fs.existsSync(timesFile),
  "a stub finishing in the same millisecond would promise an instant compaction");

// A failure must not teach the estimate anything either.
recordCompactionMs(dir, 12_000);
const before = fs.readFileSync(timesFile, "utf8");
resetCompactionState();
requestCompaction(ctx, "test", { force: true });
opts.onError(new Error("nope"));
check("a failed compaction is not recorded", fs.readFileSync(timesFile, "utf8") === before,
  "one that failed in two seconds would promise two seconds next time");
check("and its chip is removed too", status.size === 0);

recordCompactionMs(dir, 18_000);
check("a real duration is kept and averaged", estimateMs(dir) === 15_000,
  JSON.stringify(JSON.parse(fs.readFileSync(timesFile, "utf8"))));
for (let i = 0; i < 8; i++) recordCompactionMs(dir, 20_000);
check("only the recent samples are kept",
  JSON.parse(fs.readFileSync(timesFile, "utf8")).length === 5,
  "a compaction that was slow last week should not weigh on today");

// Without a TUI there is no chip, and nothing should break.
resetCompactionState();
const headless = { ...ctx, ui: { notify: () => {} } };
check("a context with no setStatus still compacts",
  requestCompaction(headless, "test", { force: true }) === true);
opts.onComplete({ summary: "s", tokensBefore: 1 });

// --- thinking during compaction --------------------------------------------
// pi passes the session level to compact(), so at `high` the model deliberates
// before writing the summary. Measured live: 79s of prefill then ~380s of
// generation, against a 500s timeout it was about to hit. Summarising a
// transcript is not a reasoning task.
{
  const levels = [];
  // The setter is passed in, not read off the context: it lives on the
  // ExtensionAPI object. Reaching for ctx.setThinkingLevel compiles through a
  // cast and then does nothing at all, which is worse than not trying.
  const thinkingCtx = { ...ctx, thinkingLevel: "high" };
  const setLevel = (l) => { levels.push(l); };
  resetCompactionState();
  requestCompaction(thinkingCtx, "test", { force: true, setThinkingLevel: setLevel });
  check("thinking is turned off before summarising", levels[0] === "off", levels.join(" -> "));
  opts.onComplete({ summary: "s", tokensBefore: 1 });
  check("and restored afterwards", levels[levels.length - 1] === "high", levels.join(" -> "),
    "the level is session-wide, so leaving it low would change every later turn");

  levels.length = 0;
  resetCompactionState();
  requestCompaction(thinkingCtx, "test", { force: true, setThinkingLevel: setLevel });
  opts.onError(new Error("nope"));
  check("restored after a failure too", levels[levels.length - 1] === "high", levels.join(" -> "));

  // A session already at the target level should not be churned.
  levels.length = 0;
  resetCompactionState();
  requestCompaction({ ...thinkingCtx, thinkingLevel: "off" }, "test", { force: true, setThinkingLevel: setLevel });
  check("a session already low is left alone", levels.length === 0);
  opts.onComplete({ summary: "s", tokensBefore: 1 });

  // A host that cannot change it must still compact.
  resetCompactionState();
  check("a caller that passes no setter still compacts",
    requestCompaction({ ...ctx, thinkingLevel: "high" }, "test", { force: true }) === true,
    "the level is an optimisation; compaction is not");
  opts.onComplete({ summary: "s", tokensBefore: 1 });
}

// The setter must actually be wired from the extensions, or the whole thing is
// a no-op that passes its own unit test.
{
  const fsx = await import("node:fs");
  for (const f of ["auto-handoff.ts", "plan-notes.ts"]) {
    const src = fsx.readFileSync(new URL(`../extensions/${f}`, import.meta.url), "utf8");
    const wired = (src.match(/setThinkingLevel:/g) ?? []).length;
    const compactions = (src.match(/requestCompaction\(/g) ?? []).length;
    check(`${f} passes the setter at every compaction it requests`,
      wired === compactions, `${wired} setters for ${compactions} call sites`);
  }
}

fs.rmSync(dir, { recursive: true, force: true });

// --- the abort must arrive explained ---------------------------------------
// Compaction cancels the turn it fires in, and pi prints that as
// "Error: This operation was aborted" through its own channel, which an
// extension rewriting the message cannot reach. Observed live at a plan step
// boundary: plan_next, then a red error, then the compaction spinner, with
// nothing saying the error was the compaction's own doing.
{
  const src = fs.readFileSync(path.join(root, "lib/compaction.ts"), "utf8");
  check("the announcement says what compacting buys",
    /full context window/.test(src),
    "a bare reason does not tell the user why their turn just stopped");
  check("and warns that the turn is cancelled to do it",
    /the turn is cancelled to do it/.test(src) && /reports as an abort/.test(src),
    "the error line follows; it should read as the price, not a fault");
  check("it is announced before the abort, not after",
    src.indexOf("Compacting now so the next step") < src.indexOf("const startedAt = Date.now()"),
    "an explanation after the error explains nothing");
  check("still suppressible", /options\.announce !== false/.test(src));
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
