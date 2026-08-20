import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import mod from "/Users/rcrd/AI/pi-local/extensions/plan-notes.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archive-"));
const tools = {}, handlers = {};
mod({ registerTool: (t) => (tools[t.name] = t), registerCommand: (n, o) => (handlers[n] = o.handler), on: (e, h) => (handlers[e] = h) });

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

const notes = [];
const ctx = { cwd: DIR, mode: "tui", ui: { notify: (m) => notes.push(m), confirm: async () => true } };
const read = (f) => { try { return fs.readFileSync(path.join(DIR, ".pi", f), "utf8"); } catch { return ""; } };
const plan = () => read("PLAN.md"), done = () => read("PLAN-DONE.md");

const steps = ["one", "two", "three", "four", "five", "six", "seven"];
await tools.plan_write.execute("1", { goal: "ship it", steps }, undefined, undefined, ctx);

// Nothing to archive while the plan is young.
await tools.plan_next.execute("a", { summary: "did one" }, undefined, undefined, ctx);
await tools.plan_next.execute("b", { summary: "did two" }, undefined, undefined, ctx);
check("under the threshold, nothing is archived", done() === "", "PLAN-DONE.md not created yet");
check("all completed steps still in the plan", /- \[x\] one/.test(plan()) && /- \[x\] two/.test(plan()));

// Crossing the threshold moves the oldest out.
await tools.plan_next.execute("c", { summary: "did three" }, undefined, undefined, ctx);
await tools.plan_next.execute("d", { summary: "did four" }, undefined, undefined, ctx);
check("the oldest completed step leaves the plan", !/- \[x\] one/.test(plan()), plan().trim());
check("and lands in the archive", /- one — did one/.test(done()), done().trim());
check("the three most recent stay in the plan",
  ["two", "three", "four"].every((t) => new RegExp(`- \\[x\\] ${t}`).test(plan())), plan().trim());
check("pending steps are untouched",
  ["five", "six", "seven"].every((t) => new RegExp(`- \\[ \\] ${t}`).test(plan())));
check("summaries survive archiving", /did one/.test(done()));

// Keep going; the archive accumulates and the plan does not.
await tools.plan_next.execute("e", { summary: "did five" }, undefined, undefined, ctx);
await tools.plan_next.execute("f", { summary: "did six" }, undefined, undefined, ctx);
check("the plan holds at three completed steps", (plan().match(/- \[x\]/g) ?? []).length === 3,
  `${(plan().match(/- \[x\]/g) ?? []).length} completed lines`);
check("the archive has the rest", (done().match(/^- /gm) ?? []).length === 3, done().trim());

// The archive header is written once, not per append.
check("the archive header appears exactly once", (done().match(/# Completed/g) ?? []).length === 1);

// Re-archiving the same step must not duplicate it.
const beforeDup = done();
await tools.plan_write.execute("2", { goal: "ship it", steps: ["four", "five", "six", "seven", "eight"] }, undefined, undefined, ctx);
check("a plan revision does not duplicate archive entries",
  (done().match(/- one/g) ?? []).length === 1, `before ${(beforeDup.match(/- one/g) ?? []).length}, after ${(done().match(/- one/g) ?? []).length}`);

// plan_status points at the archive rather than listing it.
const st = await tools.plan_status.execute("3", {}, undefined, undefined, ctx);
check("plan_status reports the archived count", /PLAN-DONE\.md/.test(st.content[0].text), st.content[0].text);
check("plan_status details carry the count", typeof st.details.archived === "number" && st.details.archived > 0, JSON.stringify(st.details));

fs.rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
