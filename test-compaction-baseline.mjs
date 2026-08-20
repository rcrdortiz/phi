// Set BEFORE the module is loaded: ESM hoists static imports above assignments,
// so a plain `import` here would read the default 20s gap and block the test.
process.env.PI_COMPACT_MIN_GAP_MS = "0";
const { requestCompaction, resetCompactionState, trackExternalCompactions, keepRecentTokens } =
  await import("/Users/rcrd/AI/pi-local/lib/compaction.ts");

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
tokens = Math.round(KEEP * 1.5);
check("well above keepRecent, it compacts", requestCompaction(ctx, "x") === true, `${tokens} tokens`);

// THE REGRESSION: after a compaction, total context is still large, but almost
// all of it is summary + the recent tail pi would keep anyway.
await handlers["session_compact"]({}, ctx);
tokens = 16000;                                   // post-compaction reading
check("the first request after a compaction only sets the baseline", requestCompaction(ctx, "x") === false,
  "no compaction attempted, so pi cannot answer 'nothing to compact'");

tokens = 21700;                                   // the size from the failing screenshot
check("a large TOTAL is not enough on its own", requestCompaction(ctx, "x") === false,
  `${tokens} total, but only ${tokens - 16000} since the last compaction (needs > ${Math.round(KEEP * 1.1)})`);

// Past the trigger an unforced request stands down for pi, so this exercises
// the baseline arithmetic through the watchdog's path, which is the caller that
// actually reaches it at this depth.
tokens = 16000 + Math.round(KEEP * 1.3);
check("enough NEW content does compact", requestCompaction(ctx, "x", { force: true }) === true,
  `${tokens - 16000} tokens since the last compaction`);

// Failure must not strand an unattended run.
resetCompactionState();
tokens = Math.round(KEEP * 1.5);
let continued = 0;
requestCompaction(ctx, "x", { onDone: () => continued++ });
lastOpts.onError?.(new Error("Nothing to compact (session too small)"));
check("onDone fires when the compaction is refused", continued === 1,
  "a refused compaction must not stop the plan");

resetCompactionState();
continued = 0;
requestCompaction(ctx, "x", { onDone: () => continued++ });
lastOpts.onComplete?.({ summary: "s", tokensBefore: 100 });
check("onDone fires on success too", continued === 1);

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

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
