// Set BEFORE the module is loaded: ESM hoists static imports above assignments,
// so a plain `import` here would read the default 20s gap and block the test.
process.env.PI_COMPACT_MIN_GAP_MS = "0";
const { requestCompaction, resetCompactionState, trackExternalCompactions, keepRecentTokens, observeContext } =
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

const CEILING = 36000;
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

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
