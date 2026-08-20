// The lock exists so two sources of compaction cannot collide. Since
// auto-handoff no longer compacts on a threshold, the remaining sources are
// plan-notes (step boundaries), pi itself (size), and /handoff (you).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import planNotes from "/Users/rcrd/AI/pi-local/extensions/plan-notes.ts";
import autoHandoff from "/Users/rcrd/AI/pi-local/extensions/auto-handoff.ts";
import { resetCompactionState, requestCompaction } from "/Users/rcrd/AI/pi-local/lib/compaction.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"));
const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

const tools = {}, planH = {}, handoffH = {};
planNotes({
  registerTool: (t) => (tools[t.name] = t),
  registerCommand: () => {},
  on: (e, h) => (planH[e] = h),
  sendUserMessage: () => {},                       // auto-continue is not what this suite tests
});
autoHandoff({ registerTool: () => {}, registerCommand: (n, o) => (handoffH["/" + n] = o.handler), on: (e, h) => (handoffH[e] = h) });

let compactCalls = 0, notes = [], completeFns = [];
const ctx = {
  cwd: DIR,
  ui: { notify: (t) => notes.push(t) },
  getContextUsage: () => ({ tokens: 40_000, contextWindow: 65_536, percent: 61 }),
  compact: (o) => { compactCalls++; completeFns.push(o.onComplete); },   // stays in flight
};

// 1. A finished plan step compacts, with instructions aimed at the next step.
resetCompactionState();
await tools.plan_write.execute("1", { goal: "g", steps: ["one", "two"] }, undefined, undefined, ctx);
await tools.plan_next.execute("2", {}, undefined, undefined, ctx);
await planH["turn_end"]({}, ctx);
check("a finished step compacts", compactCalls === 1, notes.join(" | "));

// 2. /handoff must not stack a second compaction on top of one in flight.
await handoffH["/handoff"]("", ctx);
check("in-flight compaction blocks /handoff", compactCalls === 1, `calls=${compactCalls}`);

// 3. pi's own compaction holds the lock too.
resetCompactionState();
compactCalls = 0;
await handoffH["session_before_compact"]({}, ctx);
await tools.plan_write.execute("3", { goal: "g", steps: ["three", "four"] }, undefined, undefined, ctx);
await tools.plan_next.execute("4", {}, undefined, undefined, ctx);
await planH["turn_end"]({}, ctx);
check("no compaction is requested while pi is running one", compactCalls === 0, `calls=${compactCalls}`);

// 4. After pi finishes, the cooldown still prevents an immediate follow-up.
await handoffH["session_compact"]({ compactionEntry: { summary: "pi", tokensBefore: 50_000 } }, ctx);
await planH["turn_end"]({}, ctx);
check("cooldown prevents an immediate follow-up", compactCalls === 0, `calls=${compactCalls}`);

// 5. When usage is already past pi's trigger, we must not ask at all — pi is
// compacting or in overflow recovery, and a request there is what produced
// "This operation was aborted" followed by "Already compacted".
{
  resetCompactionState();
  compactCalls = 0;
  const overflowing = {
    ...ctx,
    // 73,211 of a 65,536 window: exactly the state in the reported failure.
    getContextUsage: () => ({ tokens: 73_211, contextWindow: 65_536, percent: 112 }),
  };
  await tools.plan_write.execute("5", { goal: "g", steps: ["five", "six"] }, undefined, undefined, overflowing);
  await tools.plan_next.execute("6", {}, undefined, undefined, overflowing);
  await planH["turn_end"]({}, overflowing);
  check("stands down when pi has already taken over", compactCalls === 0,
    `calls=${compactCalls} — past the window, pi owns overflow recovery, and force does not override that`);

  // Below the window, a step boundary forces: pi does not act mid-run.
  resetCompactionState();
  const roomy = { ...ctx, getContextUsage: () => ({ tokens: 40_000, contextWindow: 65_536, percent: 61 }) };
  await tools.plan_write.execute("7", { goal: "g", steps: ["seven", "eight"] }, undefined, undefined, roomy);
  await tools.plan_next.execute("8", {}, undefined, undefined, roomy);
  await planH["turn_end"]({}, roomy);
  check("a step boundary compacts below the window", compactCalls === 1, `calls=${compactCalls}`);
}

// 6. A short task has nothing to compact — asking produces an error for a
// session that is perfectly fine, so we must not ask.
{
  resetCompactionState();
  compactCalls = 0;
  const small = { ...ctx, getContextUsage: () => ({ tokens: 4_000, contextWindow: 65_536, percent: 6 }) };
  await tools.plan_write.execute("9", { goal: "g", steps: ["nine", "ten"] }, undefined, undefined, small);
  await tools.plan_next.execute("10", {}, undefined, undefined, small);
  notes = [];
  await planH["turn_end"]({}, small);
  check("does not compact a short session", compactCalls === 0, `calls=${compactCalls}`);
  check("and says nothing about it", !notes.some((n) => /compact/i.test(n)), notes.join(" | ") || "(silent)");
}

// 7. Benign outcomes never reach the user as failures.
for (const msg of ["Already compacted", "Nothing to compact (session too small)", "This operation was aborted"]) {
  resetCompactionState();
  notes = [];
  requestCompaction(
    { ui: { notify: (t) => notes.push(t) }, compact: (o) => o.onError(new Error(msg)) },
    "test",
    { announce: false },
  );
  check(`"${msg.slice(0, 22)}…" is not surfaced as a failure`, !notes.some((n) => /failed/i.test(n)), notes.join(" | ") || "(silent)");
}

fs.rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
