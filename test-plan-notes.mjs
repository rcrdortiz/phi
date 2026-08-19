import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import mod from "/Users/rcrd/AI/pi-local/extensions/plan-notes.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "plan-"));
const tools = {}; const handlers = {};
mod({ registerTool: (t) => (tools[t.name] = t), registerCommand: () => {}, on: (e, h) => (handlers[e] = h) });

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

async function scenario(label, ctxExtras, expect) {
  fs.rmSync(path.join(DIR, ".pi"), { recursive: true, force: true });
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

// 1. Tool ctx lacks newSession (the reported failure) but the event ctx has it.
let newSessionCalled = null;
await scenario("full context", { newSession: async (o) => { newSessionCalled = o; await o.withSession({ sendUserMessage: async (m) => (newSessionCalled = m) }); } },
  ({ toolOk }) => {
    check("plan_next no longer throws from the tool context", toolOk);
    check("session resets at the step boundary (turn_end), once", typeof newSessionCalled === "string" && /Step 2 of 2/.test(newSessionCalled), String(newSessionCalled));
  });

// 2. No newSession anywhere -> falls back to compaction.
let compacted = false;
await scenario("compact fallback", { compact: () => (compacted = true) },
  ({ notes }) => check("falls back to compaction when newSession is absent", compacted && notes.some((n) => /compacted/i.test(n)), notes.join(" | ")));

// 3. Neither available -> warns, does not crash.
await scenario("no APIs", {}, ({ notes }) =>
  check("degrades to a warning when neither API exists", notes.some((n) => /was not reset/i.test(n)), notes.join(" | ")));

// 4. The plan file still advanced in every case.
const plan = fs.readFileSync(path.join(DIR, ".pi", "PLAN.md"), "utf8");
check("plan still records the completed step", /- \[x\] one/.test(plan), plan.trim().split("\n").slice(-2).join(" / "));

fs.rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
