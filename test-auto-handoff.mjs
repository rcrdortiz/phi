import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import mod from "/Users/rcrd/AI/pi-local/extensions/auto-handoff.ts";
import { resetCompactionState, compactAtTokens, keepRecentTokens } from "/Users/rcrd/AI/pi-local/lib/compaction.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"));
const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

resetCompactionState();
const handlers = {}, cmds = [], notes = [], sent = [];
let compactCalls = 0;
let lastCompactOpts = null;
// pi runs EVERY handler registered for an event. A stub that keeps only the
// last one silently drops registrations — auto-handoff registers session_compact
// twice, once to track the lock and once to write the handoff file — and a test
// against it can pass while asserting nothing.
mod({
  on: (e, h) => ((handlers[e] ||= []).push(h)),
  registerCommand: (n, o) => { cmds.push(n); handlers["/" + n] = [o.handler]; },
  registerTool: () => {},
  sendUserMessage: (m) => sent.push(m),
});
const fire = async (event, ev = {}, c = ctx) => {
  let result;
  for (const h of handlers[event] ?? []) {
    const r = await h(ev, c);
    if (r !== undefined) result = r;
  }
  return result;
};
const ctx = {
  cwd: DIR,
  ui: { notify: (t) => notes.push(t) },
  // Comfortably past the watchdog trigger and the keepRecent margin, expressed
  // relative to them so a window change does not silently disarm this test.
  getContextUsage: () => ({ tokens: Math.round(compactAtTokens(65_536) * 1.1), contextWindow: 65_536 }),
  compact: (o) => { compactCalls++; lastCompactOpts = o; o.onComplete?.({ summary: "state summary", tokensBefore: 40_000 }); },
};

// 1. turn_end IS hooked again, as a mid-run watchdog. pi checks for
//    auto-compaction only at agent_end and before prompt submission, so during
//    one long agentic run nothing watches the window: observed at 96.3% of 51K.
check("hooks turn_end as a mid-run watchdog", (handlers["turn_end"] ?? []).length > 0,
  Object.keys(handlers).filter((k) => !k.startsWith("/")).join(", "));

// It must stay quiet well below pi's trigger, so it does not pre-empt pi
// between runs, where pi genuinely does act.
compactCalls = 0;
await fire("turn_end", {}, { ...ctx, getContextUsage: () => ({ tokens: 20_000, contextWindow: 65_536 }) });
check("the watchdog stays quiet below its trigger", compactCalls === 0, `20k vs trigger ${compactAtTokens(65_536)}`);

resetCompactionState();
compactCalls = 0;
// The watchdog samples every turn, so by the time the context is deep it has
// already seen the session floor — the system prompt it must not count as
// summarisable history. Feeding only the deep reading would leave the floor
// unset and is not how it runs.
await fire("turn_end", {}, { ...ctx, getContextUsage: () => ({ tokens: 6_000, contextWindow: 65_536 }) });
check("the watchdog is quiet while the context is mostly system prompt", compactCalls === 0, "6k floor");
const deep = Math.round(compactAtTokens(65_536) * 1.1);
await fire("turn_end", {}, { ...ctx, getContextUsage: () => ({ tokens: deep, contextWindow: 65_536 }) });
check("the watchdog fires past its trigger", compactCalls === 1, `${deep} vs trigger ${compactAtTokens(65_536)}`);

// 2. pi's own compaction still lands on disk.
await fire("session_compact", { compactionEntry: { summary: "pi's summary", tokensBefore: 54_784 } });
const hp = path.join(DIR, ".pi", "HANDOFF.md");
check("records pi's compaction to disk", fs.existsSync(hp) && /pi's summary/.test(fs.readFileSync(hp, "utf8")),
  fs.existsSync(hp) ? fs.readFileSync(hp, "utf8").split("\n")[2] : "missing");

// 3. /handoff still compacts on demand, with our instructions.
resetCompactionState();
compactCalls = 0;                 // the watchdog checks above ran their own
await fire("/handoff", "");
check("/handoff compacts on demand", compactCalls === 1);
check("/handoff writes its own summary", /state summary/.test(fs.readFileSync(hp, "utf8")));

// 4. /context reports pi's trigger, not ours.
notes.length = 0;
await fire("/context", "");
check("/context reports pi's compaction point", /pi compacts above 75%/.test(notes.join(" ")), notes.join(" ").split("\n")[1]);

fs.rmSync(DIR, { recursive: true, force: true });
// --- the run must survive its own compaction ------------------------------
// Compaction aborts the in-flight turn. Without a resume, compacting in the
// middle of a step leaves the agent at a prompt with the work half done.
fs.mkdirSync(path.join(DIR, ".pi"), { recursive: true });
fs.writeFileSync(path.join(DIR, ".pi", "PLAN.md"), "# Plan\n\n- [x] one\n- [ ] wire up the HUD\n");
resetCompactionState();
sent.length = 0;
compactCalls = 0;
const deepCtx = { ...ctx, getContextUsage: () => ({ tokens: Math.round(compactAtTokens(65_536) * 1.1), contextWindow: 65_536 }) };
await fire("turn_end", {}, { ...deepCtx, getContextUsage: () => ({ tokens: 5_000, contextWindow: 65_536 }) });
await fire("turn_end", {}, deepCtx);
check("a mid-run compaction resumes the run", sent.length === 1, sent[0] ?? "(nothing sent)");
check("the resume names the unfinished step", /wire up the HUD/.test(sent[0] ?? ""), sent[0]);

// A finished plan must NOT be nudged: stopping is the correct outcome, and a
// wasted turn at full context depth is expensive.
fs.writeFileSync(path.join(DIR, ".pi", "PLAN.md"), "# Plan\n\n- [x] one\n- [x] two\n");
resetCompactionState();
sent.length = 0;
await fire("turn_end", {}, { ...deepCtx, getContextUsage: () => ({ tokens: 5_000, contextWindow: 65_536 }) });
await fire("turn_end", {}, deepCtx);
check("a finished plan is left alone", sent.length === 0, sent.join(" | ") || "(nothing sent)");

// --- our own compaction must not print an error ---------------------------
// Compacting interrupts the in-flight turn; that interruption surfaced as a red
// "Error: This operation was aborted" for something working as designed.
resetCompactionState();
const aborted = { role: "assistant", errorMessage: "This operation was aborted", usage: { output: 5 } };

const notOurs = await fire("message_end", { message: { ...aborted } });
check("an abort we did not cause is left visible", notOurs === undefined,
  "escape-to-interrupt still reports, because the user needs to see it");

// Simulate a compaction having just run.
await fire("session_compact", { compactionEntry: { summary: "s", tokensBefore: 1 } });
const ours = await fire("message_end", { message: { ...aborted } });
check("the abort from our compaction is swallowed", ours?.message?.errorMessage === undefined,
  JSON.stringify(ours?.message ?? null));
check("and the message itself survives", ours?.message?.role === "assistant" && ours?.message?.usage?.output === 5);

const realError = await fire("message_end", { message: { role: "assistant", errorMessage: "connection refused" } });
check("a genuine error is never swallowed", realError === undefined, "only aborts are suppressed");

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
