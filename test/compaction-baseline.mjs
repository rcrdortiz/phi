// Set BEFORE the module is loaded: ESM hoists static imports above assignments,
// so a plain `import` here would read the default 20s gap and block the test.
process.env.PI_COMPACT_MIN_GAP_MS = "0";
// keepRecentTokens now reports what pi WILL keep, read from settings.json,
// rather than what phi would choose. With no settings file these tests would
// get pi's default of 20000, which on a small window is most of the trigger and
// is the production bug being fixed, not the case under test here. Seed the
// value phi installs. Set before the import: ESM hoists it above assignments.
process.env.PI_KEEP_RECENT_TOKENS = "9800";
const { requestCompaction, resetCompactionState, trackExternalCompactions, keepRecentTokens,
  recommendedKeepRecentTokens, compactAtTokens, observeContext, prefillCeiling,
  observedTurnGrowth, overshootAllowance, resetTurnGrowth, midRunCompactionAllowed } =
  await import("../lib/compaction.ts");

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

const WINDOW = 51200;
const KEEP = keepRecentTokens(WINDOW);           // 15360
let tokens = 0, compacted = 0, lastOpts = null;
const ctx = {
  ui: { notify: () => {} },
  getContextUsage: () => ({ tokens, contextWindow: WINDOW }),
  compact: (o) => { compacted++; lastOpts = o; },
};
const handlers = {};
trackExternalCompactions({ on: (e, h) => (handlers[e] = h) });

// A fresh session with no prior compaction behaves as before.
resetCompactionState();
tokens = Math.round(KEEP * 1.05);
check("below keepRecent, no compaction is attempted", requestCompaction(ctx, "x") === false,
  `${tokens} tokens vs keepRecent ${KEEP}`);
tokens = Math.round(KEEP * 2);
check("well above keepRecent, it compacts", requestCompaction(ctx, "x") === true,
  `${tokens} tokens against keepRecent ${KEEP}`);

// THE REGRESSION: after a compaction, total context is still large, but almost
// all of it is summary + the recent tail pi would keep anyway.
await handlers["session_compact"]({}, ctx);
tokens = 16000;                                   // post-compaction reading
check("the first request after a compaction only sets the baseline", requestCompaction(ctx, "x") === false,
  "no compaction attempted, so pi cannot answer 'nothing to compact'");

tokens = 21700;                                   // the size from the failing screenshot
check("a large TOTAL is not enough on its own", requestCompaction(ctx, "x") === false,
  `${tokens} total, but only ${tokens - 16000} since the last compaction (needs > ${Math.round(KEEP * 1.5)})`);

// Past the trigger an unforced request stands down for pi, so this exercises
// the baseline arithmetic through the watchdog's path, which is the caller that
// actually reaches it at this depth.
tokens = 16000 + Math.round(KEEP * 2);
check("enough NEW content does compact", requestCompaction(ctx, "x", { force: true }) === true,
  `${tokens - 16000} tokens since the last compaction`);

// Failure must not strand an unattended run.
resetCompactionState();
tokens = Math.round(KEEP * 2);      // clear of the 1.5x margin, not exactly on it
let continued = 0;
requestCompaction(ctx, "x", { onDone: () => continued++ });
lastOpts.onError?.(new Error("Nothing to compact (session too small)"));
check("onDone fires when the compaction is refused", continued === 1,
  "a refused compaction must not stop the plan");

resetCompactionState();
tokens = Math.round(KEEP * 2);
continued = 0;
requestCompaction(ctx, "x", { onDone: () => continued++ });
lastOpts.onComplete?.({ summary: "s", tokensBefore: 100 });
check("onDone fires on success too", continued === 1);

// --- the system-prompt floor ---------------------------------------------
// pi's keepRecentTokens counts session MESSAGES; getContextUsage reports the
// whole context, system prompt included. Without subtracting that floor a
// two-thirds-full window can hold almost no summarisable history.
resetCompactionState();
observeContext(6000);          // the floor: system prompt + first exchange
tokens = 11000;
check("a context that is mostly system prompt does not compact",
  requestCompaction(ctx, "x", { force: true }) === false,
  `11000 total - 6000 floor = 5000 of messages, under keepRecent ${KEEP} x1.5`);
resetCompactionState();
observeContext(6000);
tokens = 6000 + Math.round(KEEP * 1.8);
check("enough MESSAGES does compact", requestCompaction(ctx, "x", { force: true }) === true,
  `${tokens - 6000} of messages against keepRecent ${KEEP}`);

// --- the mid-run watchdog ------------------------------------------------
// pi checks for auto-compaction "at agent_end and before prompt submission".
// A long agentic run reaches neither, so above the trigger nothing acts.
resetCompactionState();
tokens = Math.round(WINDOW * 0.963);          // the observed 96.3%
check("without force, a high-water context stands down for pi",
  requestCompaction(ctx, "x") === false,
  "correct between runs, where pi really is about to act");
resetCompactionState();
check("with force, the watchdog compacts anyway",
  requestCompaction(ctx, "x", { force: true }) === true,
  `${tokens} tokens = 96% of ${WINDOW}, and pi will not act until the run ends`);

// force must not defeat the other guards
resetCompactionState();
tokens = 1000;
check("force does not compact a session with nothing to compact",
  requestCompaction(ctx, "x", { force: true }) === false);

// --- the baseline has to come from a reading taken BELOW the trigger --------
// Observed live at 70.4% of a 64K window, followed by `Request timed out` on
// the next prompt. requestCompaction is only reached once usage is past the
// trigger, so a baseline claimed there records the TRIGGER depth rather than
// the depth compaction left behind, and the `since` margin stacks on top of the
// trigger instead of on top of the floor.
//
// The property that matters is not where the baseline is recorded, it is the
// depth the session actually reaches before compacting. Walk it up and find out.
const firstCompactionDepth = (observeSettled) => {
  resetCompactionState();
  tokens = 40000;
  requestCompaction(ctx, "x", { force: true });   // compacts, arms the baseline
  handlers.session_compact?.({}, ctx);
  if (observeSettled !== undefined) observeContext(observeSettled);
  // The watchdog returns before requestCompaction below the trigger, so the
  // walk has to as well. That early return is the whole reason the lazily
  // claimed baseline lands on the trigger depth.
  const TRIGGER = 28000;
  for (let t = 12000; t <= 64000; t += 250) {
    tokens = t;
    if (t < TRIGGER) { if (observeSettled !== undefined) observeContext(t); continue; }
    if (requestCompaction(ctx, "x", { force: true })) return t;
  }
  return Infinity;
};

const CEILING = prefillCeiling();
const withBaseline = firstCompactionDepth(14000);
check("compaction happens before a prefix-cache miss stops fitting in the timeout",
  withBaseline < CEILING,
  `first compaction at ${withBaseline}, ceiling ${CEILING}`);

// The same walk with no reading taken below the trigger is the bug: the first
// call past the trigger claims the baseline, and the margin stacks on top of it.
const withoutBaseline = firstCompactionDepth(undefined);
check("without a low reading it runs deep, which is what the fix addresses",
  withoutBaseline > withBaseline,
  `${withoutBaseline} against ${withBaseline}`);

// --- the ceiling valve -----------------------------------------------------
// Past the prefill ceiling the margin stops applying: a cosmetic "Nothing to
// compact" is cheaper than the user's next prompt timing out.
// Derived, not hardcoded: the ceiling is the idle timeout times the measured
// prefill rate, and both have moved. A literal here goes stale silently and
// the test then asserts the wrong side of the line.
// Pinned, because the real ceiling is now above the context window: at the
// measured 180 tok/s a 500s timeout covers 90,000 tokens and the window is
// 65,536, so "past the ceiling" cannot be reached at all on this install. That
// is worth knowing on its own, but the valve still has to work wherever the
// ceiling lands, so this pins one low enough to construct the case.
process.env.PI_PREFILL_CEILING_TOKENS = "20000";
const CEIL = prefillCeiling();
resetCompactionState();
observeContext(CEIL - 2000);
tokens = CEIL - 1000;
check("just under the ceiling, a thin margin still stands down",
  requestCompaction(ctx, "x", { force: true }) === false,
  `1000 accumulated against keepRecent ${KEEP}, ceiling ${CEIL}`);
resetCompactionState();
observeContext(CEIL);
tokens = CEIL + 1000;
check("past the ceiling it compacts on a thin margin anyway",
  requestCompaction(ctx, "x", { force: true }) === true,
  "a timed-out prompt is the more expensive failure");
delete process.env.PI_PREFILL_CEILING_TOKENS;

// At the measured rate even pi's stock 300s timeout clears the safe depth:
// 300s x 180 tok/s is 54,000, and 70% of that is 37,800, above the 36,000 cap.
// So the prefill ceiling has stopped being the binding constraint anywhere, and
// the safe depth is what decides. Recorded because that was not true with the
// old 115, where a stock install compacted at 24,150.
check("the ceiling still binds before the raised safe depth",
  Math.round(prefillCeiling() * 0.7) < 45000,
  `ceiling ${prefillCeiling().toLocaleString()}, 70% is ${Math.round(prefillCeiling() * 0.7).toLocaleString()}`);

// --- the ceiling is derived, not hardcoded ---------------------------------
// It is the product of pi's HTTP idle timeout and the measured prefill rate.
// Both move: the timeout is a setting, and raising it genuinely raises the
// ceiling. A hardcoded value stops matching the moment someone changes it, and
// the mistimed compaction that follows looks like a bug rather than a stale
// constant.
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phi-timeout-"));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 500000 }));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  resetCompactionState();
  const { httpIdleTimeoutMs } = await import("../lib/compaction.ts");
  check("the timeout is read from pi's settings, not assumed",
    httpIdleTimeoutMs() === 500000, "500s configured");

  // At 500s the ceiling is 60,000, so a thin margin at 36,500 no longer forces
  // a compaction the way it does under the 300s default.
  observeContext(35500);
  tokens = 36500;
  check("a longer timeout moves the ceiling with it",
    requestCompaction(ctx, "x", { force: true }) === false,
    "36,500 is past the 300s ceiling but well inside the 500s one");

  if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = before;
  resetCompactionState();
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- pi's own default is the bug ------------------------------------------
// Measured live: a compaction at 31,126 tokens left about 29,500, because pi
// keeps compaction.keepRecentTokens of recent messages and defaults to 20000,
// a number sized for a 128K+ window. On this window that is most of the
// trigger, so compaction reclaims nothing, the session sits permanently above
// the trigger, and the next cache miss has 26,000 tokens to re-prefill.
{
  const before = process.env.PI_KEEP_RECENT_TOKENS;
  delete process.env.PI_KEEP_RECENT_TOKENS;
  resetCompactionState();
  check("with no setting, keepRecentTokens reports pi's default and not ours",
    keepRecentTokens(65536) === 20000,
    "reporting our own preference here is what hid the problem");
  check("phi's recommendation is a fixed count, not a fraction of the window",
    recommendedKeepRecentTokens(65536) === 6000);
  check("pi's default would leave nothing for a compaction to reclaim",
    keepRecentTokens(65536) > compactAtTokens(65536) * 0.5,
    "20000 against a 28000 trigger");
  if (before === undefined) delete process.env.PI_KEEP_RECENT_TOKENS;
  else process.env.PI_KEEP_RECENT_TOKENS = before;
  resetCompactionState();
}

// --- the trigger and what it costs ----------------------------------------
// Measured, not assumed: prefill at depth, forcing a cache miss each time, on
// an idle machine with the weights already resident.
//
//   31,772 tokens  224s  142 tok/s     margin under a 500s timeout: 276s
//   39,698 tokens  335s  119 tok/s                                  165s
//   47,625 tokens  413s  115 tok/s                                   87s
//
// 36,000 takes most of the gain from the longer timeout while keeping enough
// margin to absorb a machine that is being used for something else, which is
// the normal case here and is not what the benchmark measured.
check("the trigger never exceeds what a cache miss can recover from",
  compactAtTokens(65536) <= prefillCeiling() * 0.75,
  `${compactAtTokens(65536)} against a ceiling of ${prefillCeiling()}`);

// A shorter timeout has to pull the trigger down with it. A literal 36,000 sat
// above the 34,500 ceiling of a default 300s install, which is a guaranteed
// timeout dressed up as a configuration choice.
{
  const fsx = await import("node:fs");
  const osx = await import("node:os");
  const px = await import("node:path");
  const dir = fsx.mkdtempSync(px.join(osx.tmpdir(), "phi-trigger-"));
  const at = (ms) => {
    fsx.writeFileSync(px.join(dir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: ms }));
    process.env.PI_CODING_AGENT_DIR = dir;
    resetCompactionState();
    return compactAtTokens(65536);
  };
  const before = process.env.PI_CODING_AGENT_DIR;
  check("a 500s timeout allows the full working depth", at(500_000) === 45000, String(at(500_000)));
  // 300s no longer pulls it down. At the measured 180 tok/s a 300s timeout
  // covers 54,000 tokens, and 70% of that is above the 36,000 safe depth, so
  // the safe depth binds instead. With the old 115 this test asserted 24,150,
  // which was half the usable context and came from a rate measured while the
  // prefix cache was thrashing.
  // 300s now lands between the two: 300s x 180 tok/s x 70% is 37,800, below the
  // 45,000 safe depth, so the ceiling binds again. Still far above the 24,150 it
  // gave with the old 115 tok/s figure.
  check("pi's 300s default binds below the safe depth again", at(300_000) === 37800, String(at(300_000)));
  check("a short timeout still binds before the safe depth", at(150_000) < 36000, String(at(150_000)));
  check("a 60s timeout makes it much shallower still", at(60_000) < at(300_000));
  if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = before;
  resetCompactionState();
  fsx.rmSync(dir, { recursive: true, force: true });
}

// keepRecent answers a question about continuity, not about depth. Scaling it
// with the trigger would have cancelled most of the gain from raising one.
check("raising the trigger does not raise what is kept",
  recommendedKeepRecentTokens(65536) === 6000 && recommendedKeepRecentTokens(32768) === 6000,
  "it used to be 35% of the trigger, which quietly made it scale");
// Lowered from 9,800, which was 61% of the 16,138-token floor a compaction
// lands on here: most of what compacting reclaimed was recent conversation
// coming straight back in. It must stay well under that floor to be worth doing.
check("what is kept is a minority of the post-compaction floor",
  recommendedKeepRecentTokens(65536) < 16138 * 0.5,
  "keeping more than half the floor pays twice for what the summary holds");

// --- the trigger learns what a turn costs ----------------------------------
// The check only runs at turn_end, so depth keeps climbing until the turn ends.
// Measured live: a run crossed a 36,000 trigger at 37,560 and did not reach
// turn_end until 53,097. The trigger fires early by that much so the turn ENDS
// near the intended depth instead of starting there.
resetCompactionState();
const flat = compactAtTokens(65_536);
check("a fresh session has no overshoot allowance", observedTurnGrowth() === 0 && overshootAllowance(flat) === 0,
  `growth=${observedTurnGrowth()}`);

observeContext(10_000);
observeContext(12_000);
check("small turns barely move the trigger", compactAtTokens(65_536) === flat - 2_000,
  `${compactAtTokens(65_536)} vs ${flat}`);

observeContext(30_000);
check("the worst turn is what counts, not the last one", observedTurnGrowth() === 18_000,
  `growth=${observedTurnGrowth()}`);

check("the trigger drops by the worst turn's growth", compactAtTokens(65_536) < flat,
  `${compactAtTokens(65_536)} vs ${flat}`);

// A single enormous turn must not collapse the trigger: a session that compacts
// every turn re-prefills every turn, which is slower than running deeper.
resetTurnGrowth();
observeContext(1_000);
observeContext(60_000);
check("one huge turn cannot collapse the trigger", compactAtTokens(65_536) >= Math.round(flat * 0.6),
  `${compactAtTokens(65_536)} floor ${Math.round(flat * 0.6)} of ${flat}`);

// The drop across a compaction is not something a turn spent.
resetTurnGrowth();
observeContext(50_000);
observeContext(7_000);
check("a compaction's drop is not counted as growth", observedTurnGrowth() === 0,
  `growth=${observedTurnGrowth()}`);

resetTurnGrowth();

// --- mid-run compaction must not fire in print mode -------------------------
// Compaction aborts the turn it fires in, and a print run is a single turn:
// runPrintMode awaits one session.prompt() and returns as soon as it resolves,
// aborted or not. The resume is a new turn and never lands. Measured on quill:
// the run compacted at 32,647 tokens and exited having edited nothing.
{
  const argv = process.argv;
  const env = process.env.PI_PRINT_COMPACT;
  try {
    process.argv = ["node", "pi", "--print", "do the thing", "--approve"];
    delete process.env.PI_PRINT_COMPACT;
    check("a --print run does not compact mid-turn", midRunCompactionAllowed() === false,
      "this is what made three of four quill runs score the untouched baseline");

    process.argv = ["node", "pi", "-p", "do the thing"];
    check("the -p short form counts too", midRunCompactionAllowed() === false);

    process.env.PI_PRINT_COMPACT = "1";
    check("the escape hatch restores it", midRunCompactionAllowed() === true,
      "needed to test the resume path itself");

    delete process.env.PI_PRINT_COMPACT;
    process.argv = ["node", "pi"];
    check("an interactive session still compacts", midRunCompactionAllowed() === true,
      "there the resume lands, and this has always worked");
  } finally {
    process.argv = argv;
    if (env === undefined) delete process.env.PI_PRINT_COMPACT; else process.env.PI_PRINT_COMPACT = env;
  }
}


const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
