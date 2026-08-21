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
  recommendedKeepRecentTokens, compactAtTokens, observeContext } =
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

const CEILING = 36000;   // 300s at ~120 tok/s, pi's default timeout
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
resetCompactionState();
observeContext(34000);
tokens = 35000;
check("just under the ceiling, a thin margin still stands down",
  requestCompaction(ctx, "x", { force: true }) === false,
  "1000 accumulated against keepRecent " + KEEP);
resetCompactionState();
observeContext(35500);
tokens = 36500;
check("past the ceiling it compacts on a thin margin anyway",
  requestCompaction(ctx, "x", { force: true }) === true,
  "a timed-out prompt is the more expensive failure");

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
  check("phi's recommendation is a fraction of the trigger, not of the window",
    recommendedKeepRecentTokens(65536) === 9800);
  check("pi's default would leave nothing for a compaction to reclaim",
    keepRecentTokens(65536) > compactAtTokens(65536) * 0.5,
    "20000 against a 28000 trigger");
  if (before === undefined) delete process.env.PI_KEEP_RECENT_TOKENS;
  else process.env.PI_KEEP_RECENT_TOKENS = before;
  resetCompactionState();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
