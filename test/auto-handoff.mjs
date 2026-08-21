// keepRecentTokens now reports what pi WILL keep, read from settings.json,
// rather than what phi would choose. With no settings file these tests would
// get pi's default of 20000, which on a small window is most of the trigger and
// is the production bug being fixed, not the case under test here. Seed the
// value phi installs. Set before the import: ESM hoists it above assignments.
process.env.PI_KEEP_RECENT_TOKENS = "9800";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import mod from "../extensions/auto-handoff.ts";
import { resetCompactionState, compactAtTokens, keepRecentTokens } from "../lib/compaction.ts";
import { STATE_DIR, statePath } from "../lib/state-dir.ts";

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
const hp = path.join(DIR, STATE_DIR, "HANDOFF.md");
check("records pi's compaction to disk", fs.existsSync(hp) && /pi's summary/.test(fs.readFileSync(hp, "utf8")),
  fs.existsSync(hp) ? fs.readFileSync(hp, "utf8").split("\n")[2] : "missing");

// 3. /handoff still compacts on demand, with our instructions.
resetCompactionState();
compactCalls = 0;                 // the watchdog checks above ran their own
await fire("/handoff", "");
check("/handoff compacts on demand", compactCalls === 1);
check("/handoff writes its own summary", /state summary/.test(fs.readFileSync(hp, "utf8")));

// 4. /context has to report the trigger that actually fires.
// It used to quote pi's, which sits far above ours: that says half a window of
// room remains when compaction is a few thousand tokens away, and it is the
// same gap that makes the footer read as though there is plenty left.
notes.length = 0;
await fire("/context", "");
const ctxOut = notes.join(" ");
check("/context counts against our trigger, not the window",
  new RegExp(`of ${compactAtTokens(65536).toLocaleString()} tokens before compaction`).test(ctxOut),
  ctxOut.split("\n")[0]);
check("/context explains why the footer disagrees", /footer/.test(ctxOut),
  "the number on screen is the model's window, and it is nearly twice the working depth");
check("/context still names pi's trigger as the backstop", /only ever acts on what we miss/.test(ctxOut));

fs.rmSync(DIR, { recursive: true, force: true });
// --- the run must survive its own compaction ------------------------------
// Compaction aborts the in-flight turn. Without a resume, compacting in the
// middle of a step leaves the agent at a prompt with the work half done.
fs.mkdirSync(path.join(DIR, STATE_DIR), { recursive: true });
fs.writeFileSync(path.join(DIR, STATE_DIR, "PLAN.md"), "# Plan\n\n- [x] one\n- [ ] wire up the HUD\n");
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
fs.writeFileSync(path.join(DIR, STATE_DIR, "PLAN.md"), "# Plan\n\n- [x] one\n- [x] two\n");
resetCompactionState();
sent.length = 0;
await fire("turn_end", {}, { ...deepCtx, getContextUsage: () => ({ tokens: 5_000, contextWindow: 65_536 }) });
await fire("turn_end", {}, deepCtx);
check("a finished plan is left alone", sent.length === 0, sent.join(" | ") || "(nothing sent)");

// --- our own compaction must not print an error ---------------------------
// Compacting aborts the in-flight turn. That arrives as stopReason "error" with
// the text "This operation was aborted", recorded live rather than assumed.
resetCompactionState();
const aborted = { role: "assistant", stopReason: "error", errorMessage: "This operation was aborted", usage: { output: 5 } };

const notOurs = await fire("message_end", { message: { ...aborted } });
check("an abort we did not cause is left visible", notOurs === undefined,
  "escape-to-interrupt still reports, because the user needs to see it");

// Simulate a compaction having just run.
await fire("session_compact", { compactionEntry: { summary: "s", tokensBefore: 1 } });
const ours = await fire("message_end", { message: { ...aborted } });
check("the abort from our compaction stops being an error",
  ours?.message?.stopReason === "stop" && ours?.message?.errorMessage === undefined,
  JSON.stringify(ours?.message ?? null));

// THE REGRESSION. Blanking the text alone was worse than doing nothing: pi
// renders `errorMessage || "Unknown error"` whenever the stop reason is
// "error", so removing the one useful word produced a red line naming nothing.
check("the stop reason is rewritten, not just the text",
  ours?.message?.stopReason !== "error",
  "a blank message under stopReason error renders as \"Unknown error\"");
check("and the message itself survives", ours?.message?.role === "assistant" && ours?.message?.usage?.output === 5);

const realError = await fire("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "connection refused" } });
check("a failure that names itself is never swallowed", realError === undefined,
  "only aborts, and only inside the window");

// The other shape: no text at all.
const blank = { role: "assistant", stopReason: "error", usage: { output: 3 } };
const quiet = await fire("message_end", { message: { ...blank } });
check("a textless error during our compaction is also quieted",
  quiet?.message?.stopReason === "stop");

check("a textless error is still shown when nothing of ours is running",
  (resetCompactionState(),
   await fire("message_end", { message: { ...blank } })) === undefined,
  "outside the window it is somebody else's problem");

await fire("session_compact", { compactionEntry: { summary: "s", tokensBefore: 1 } });
check("an ordinary finished turn is not rewritten",
  (await fire("message_end", { message: { role: "assistant", stopReason: "stop" } })) === undefined);
check("a user message is never touched",
  (await fire("message_end", { message: { role: "user", stopReason: "error" } })) === undefined);

// --- resuming after a compaction ------------------------------------------
// Resuming used to require a pending plan step, so anything not driven by a
// plan died at the compaction: investigation, a request typed into the chat,
// even the turn on its way to calling plan_write. The plan was a proxy for "is
// there work left", and a poor one.
{
  const fsx = await import("node:fs");
  const osx = await import("node:os");
  const px = await import("node:path");
  const dir = fsx.mkdtempSync(px.join(osx.tmpdir(), "phi-resume-"));
  fsx.mkdirSync(px.join(dir, STATE_DIR), { recursive: true });

  const run = async ({ plan, interrupt }) => {
    resetCompactionState();
    sent.length = 0;
    if (plan) fsx.writeFileSync(px.join(dir, STATE_DIR, "PLAN.md"), `# Plan\n\n${plan}\n`);
    else fsx.rmSync(px.join(dir, STATE_DIR, "PLAN.md"), { force: true });
    let tokens = 4000;
    const c = {
      cwd: dir,
      ui: { notify: () => {}, setStatus: () => {} },
      getContextUsage: () => ({ tokens, contextWindow: 65536 }),
      compact: (o) => { lastCompactOpts = o; },
    };
    for (tokens of [4000, 12000, 20000, 26000, 40000]) await fire("turn_end", {}, c);
    // The abort our compaction causes, which is the evidence of interruption.
    if (interrupt) await fire("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" } }, c);
    lastCompactOpts?.onComplete?.({ summary: "s", tokensBefore: 1 });
    return sent.join(" | ");
  };

  check("an interrupted turn with no plan is resumed",
    (await run({ plan: null, interrupt: true })).length > 0,
    "this is the case that used to die silently");
  check("the resume does not invent a step it does not have",
    !/step/i.test(await run({ plan: null, interrupt: true })));
  check("an interrupted turn with a plan names the step",
    /rename the thing/.test(await run({ plan: "- [ ] rename the thing", interrupt: true })));
  check("a compaction that interrupted nothing resumes nothing",
    (await run({ plan: null, interrupt: false })) === "",
    "the case the old guard was really protecting");
  check("a finished plan still resumes when a turn was cut off",
    (await run({ plan: "- [x] done", interrupt: true })).length > 0,
    "new work outlives the plan that happened to be on disk");

  fsx.rmSync(dir, { recursive: true, force: true });
}

// --- what the summariser is told ------------------------------------------
// The expensive thing to carry forward is not the conversation, it is the model
// arguing with itself: at thinking level high a single decision can run to
// several hundred tokens of reconsidering, and a faithful summary keeps all of
// it. The conclusion is actionable, the route to it is not.
{
  const src = fs.readFileSync(new URL("../extensions/auto-handoff.ts", import.meta.url), "utf8");
  check("the summariser is told to drop deliberation", /not the deliberation/.test(src));
  check("and given a test for what to cut",
    /would not change what the next session does/.test(src),
    "a rule the model can apply per sentence beats an adjective");
  check("a rejected option survives as one line, not as the argument",
    /Dead ends as one line/.test(src));

  // Three copies of these rules drifted apart, and only one was ever updated.
  const uses = src.match(/instructions:/g) ?? [];
  check("every compaction shares one instruction set",
    !/Summarise for a session continuing the SAME task mid-flight/.test(src) && uses.length >= 2,
    `${uses.length} call sites, one definition`);
}

// --- the diagnostic --------------------------------------------------------
// The suppressor above is correct in isolation and was still not working live,
// so the next occurrence has to leave evidence rather than another theory.
check("recording is off unless asked for",
  process.env.PHI_DEBUG_MESSAGE_END !== "1",
  "it writes a line on every single turn");

{
  const fsx = await import("node:fs");
  const osx = await import("node:os");
  const px = await import("node:path");
  const dir = fsx.mkdtempSync(px.join(osx.tmpdir(), "phi-msgend-"));
  process.env.PHI_DEBUG_MESSAGE_END = "1";
  const h2 = {};
  const mod2 = (await import("../extensions/auto-handoff.ts?debug")).default;
  mod2({ on: (e, fn) => ((h2[e] ||= []).push(fn)), registerCommand: () => {}, registerTool: () => {}, sendUserMessage: () => {} });
  for (const fn of h2.message_end ?? []) {
    await fn({ message: { role: "assistant", stopReason: "error", content: [{ type: "text" }] } }, { cwd: dir, ui: { notify: () => {} } });
  }
  const log = px.join(dir, STATE_DIR, "message-end.log");
  const wrote = fsx.existsSync(log) ? JSON.parse(fsx.readFileSync(log, "utf8").trim().split("\n")[0]) : undefined;
  check("a recorded line carries what the decision was made on",
    wrote?.stopReason === "error" && wrote?.role === "assistant" &&
      "busy" in (wrote ?? {}) && "recent" in (wrote ?? {}) && Array.isArray(wrote?.parts),
    JSON.stringify(wrote));
  delete process.env.PHI_DEBUG_MESSAGE_END;
  fsx.rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
