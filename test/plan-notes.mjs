import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
import mod, { asSteps } from "../extensions/plan-notes.ts";
import { resetCompactionState } from "../lib/compaction.ts";
import { STATE_DIR, statePath } from "../lib/state-dir.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "plan-"));
const tools = {}; const handlers = {};
const sentMessages = [];
mod({
  registerTool: (t) => (tools[t.name] = t),
  registerCommand: () => {},
  on: (e, h) => (handlers[e] = h),
  sendUserMessage: (m) => sentMessages.push(m),   // plan_next auto-continues
});

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

async function scenario(label, ctxExtras, expect) {
  resetCompactionState();
  fs.rmSync(path.join(DIR, STATE_DIR), { recursive: true, force: true });
  const notes = [];
  const base = { cwd: DIR, ui: { notify: (m) => notes.push(m) } };
  const toolCtx = { ...base };                       // tools get the partial ctx
  const eventCtx = { ...base, ...ctxExtras };        // events get the mode's ctx
  await tools.plan_write.execute("1", { goal: "g", steps: ["one", "two"] }, undefined, undefined, toolCtx);
  const r = await tools.plan_next.execute("2", {}, undefined, undefined, toolCtx);
  const toolOk = !r.isError;
  await handlers["turn_end"]({}, eventCtx);   // fires first, at the step boundary
  await handlers["agent_settled"]({}, eventCtx); // backstop must be a no-op
  expect({ toolOk, notes, r });
}

// 1. A completed step compacts (newSession is not reachable from a tool or an
// event handler — it exists only on ExtensionCommandContext).
let compacted = null;
await scenario("step boundary", { compact: (o) => (compacted = o) },
  ({ toolOk }) => {
    check("plan_next no longer throws from the tool context", toolOk);
    check("a finished step triggers compaction", compacted !== null);
    check("the summary is aimed at the next step",
      /next step is: two/i.test(compacted?.customInstructions ?? ""),
      (compacted?.customInstructions ?? "").slice(0, 70));
  });

// 2. No compaction available -> degrades quietly rather than erroring.
await scenario("no compact API", {}, ({ notes }) =>
  check("degrades quietly when the context cannot compact",
    !notes.some((n) => /error|failed/i.test(n)), notes.join(" | ") || "(silent)"));

// 4. The plan file still advanced in every case.
const plan = fs.readFileSync(path.join(DIR, STATE_DIR, "PLAN.md"), "utf8");
check("plan still records the completed step", /- \[x\] one/.test(plan), plan.trim().split("\n").slice(-2).join(" / "));

fs.rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;

// --- plan_write must not stall, and must not be fussy --------------------
{
  const src = fs.readFileSync(path.join(root, "extensions/plan-notes.ts"), "utf8");
  check("plan_write tells the model to begin, not to ask",
    /begin step 1 in this same turn/.test(src) && /Do not ask whether to start/.test(src),
    "it used to say 'raise anything you want decided', and the model stopped and asked");
  check("the recap survives", /Summarise for the user what you found/.test(src),
    "a wrong plan is cheapest to correct before any editing happens");

  check("steps sent as one string are accepted", JSON.stringify(asSteps("1. one\n2. two")) === '["one","two"]',
    JSON.stringify(asSteps("1. one\n2. two")));
  check("bullets are stripped too", JSON.stringify(asSteps("- a\n* b")) === '["a","b"]');
  check("an array is passed through", JSON.stringify(asSteps(["x", "y"])) === '["x","y"]');
  check("blank lines are dropped", JSON.stringify(asSteps("a\n\n  \nb")) === '["a","b"]');
}

console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
