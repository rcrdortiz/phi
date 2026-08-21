import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import mod from "../extensions/plan-notes.ts";
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
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
