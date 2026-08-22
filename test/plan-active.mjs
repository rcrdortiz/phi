// `[o]` means started. "Current" used to be inferred as "first not done", which
// cannot tell a step that was interrupted from one nobody has touched, and that
// distinction is the whole question after a crash, a ctrl+c or a compaction.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import plan, { markActive } from "../extensions/plan-notes.ts";
import { STATE_DIR } from "../lib/state-dir.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

// --- marking ----------------------------------------------------------------
const steps = [{ done: true, text: "one" }, { done: false, text: "two" }, { done: false, text: "three" }];
const marked = markActive(steps);
check("the first unfinished step is the one marked", marked[1].active === true && !marked[2].active);
check("finished steps are left alone", marked[0].done === true && !marked[0].active);
check("marking twice changes nothing", markActive(marked) === undefined,
  "it must be safe to call on every edit");
check("a finished plan has nothing to mark", markActive([{ done: true, text: "x" }]) === undefined);
check("an already-marked later step wins over an earlier waiting one",
  markActive([{ done: false, text: "a" }, { done: false, active: true, text: "b" }]) === undefined,
  "work can happen out of order, and the mark is the record of that");

// --- round trip through the file --------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phi-active-"));
fs.mkdirSync(path.join(dir, STATE_DIR), { recursive: true });
const planFile = path.join(dir, STATE_DIR, "PLAN.md");
const write = (body) => fs.writeFileSync(planFile, `# Plan\n\n**Goal:** g\n\n${body}\n`);
const read = () => fs.readFileSync(planFile, "utf8");

const handlers = {};
plan({ on: (e, h) => ((handlers[e] ||= []).push(h)), registerCommand: () => {}, registerTool: () => {}, sendUserMessage: () => {} });
const edit = async (tool = "edit_block") => {
  let r;
  for (const h of handlers.tool_call ?? []) r = (await h({ toolName: tool, input: {} }, { cwd: dir })) ?? r;
  return r;
};

write("- [x] one\n- [ ] two\n- [ ] three");
await edit();
check("an edit marks the step it is working on", /- \[o\] two/.test(read()), read().split("\n").slice(-3).join(" | "));
check("and leaves the others as they were", /- \[x\] one/.test(read()) && /- \[ \] three/.test(read()));
check("the goal survives the rewrite", /\*\*Goal:\*\* g/.test(read()));

check("reading is not evidence of starting a step", await (async () => {
  write("- [ ] alpha");
  await edit("view_lines");
  return !/\[o\]/.test(read());
})(), "an edit is the clearest evidence, a read is not");

// The mark must not make a plan look finished, or the gate would fire on it.
write("- [o] halfway");
check("an in-progress step does not count as done", (await edit())?.block !== true,
  "otherwise the gate refuses the very edit that is doing the work");

// --- the briefing and the resume both have to see it ------------------------
write("- [x] done\n- [o] the interrupted one\n- [ ] later");
let brief;
for (const h of handlers.before_agent_start ?? []) brief = (await h({ systemPrompt: "BASE" }, { cwd: dir })) ?? brief;
check("the briefing names the in-progress step, not the next waiting one",
  /the interrupted one/.test(brief.systemPrompt) && !/do only this one:\*\*\nlater/.test(brief.systemPrompt),
  "naming the next one is the wrong answer at exactly the moment it matters");
// Named for what it measures. The mark comes from an edit landing while that
// step was current, which is evidence work happened near it, not proof it was
// on it: live, a step about index.html was marked during an unrelated rename in
// pang.js asked for in chat.
check("the briefing says where work last happened, not that the step is underway",
  /work last happened/.test(brief.systemPrompt) && !/in progress/.test(brief.systemPrompt),
  "claiming more than the evidence supports is how the next session gets misled");

const { default: handoff, resumeNote } = await import("../extensions/auto-handoff.ts");
const h2 = {};
handoff({ on: (e, h) => ((h2[e] ||= []).push(h)), registerCommand: () => {}, registerTool: () => {}, sendUserMessage: () => {} });
for (const h of h2.session_shutdown ?? []) await h({ reason: "quit" }, { cwd: dir, ui: { notify: () => {} } });
const written = fs.readFileSync(path.join(dir, STATE_DIR, "HANDOFF.md"), "utf8");
check("quitting reports the in-progress step", /the interrupted one/.test(written),
  written.split("\n").slice(0, 8).join(" | "));

// A revision must not silently forget which step was under way. The next edit
// would re-mark it, but an interruption inside that window is the exact case
// the mark exists for. Driven through plan_write, not asserted on a file this
// test wrote itself.
const tools = {};
plan({
  on: () => {},
  registerCommand: () => {},
  registerTool: (t) => (tools[t.name] = t),
  sendUserMessage: () => {},
});
write("- [x] a\n- [o] b\n- [ ] c");
await tools.plan_write.execute("id", { goal: "g", steps: ["a", "b", "c", "d"] }, undefined, undefined, {
  cwd: dir,
  ui: { notify: () => {} },
});
const revised = read();
check("a revision keeps the in-progress mark", /- \[o\] b/.test(revised), revised.split("\n").filter((l) => l.startsWith("-")).join(" | "));
check("and keeps completed steps completed", /- \[x\] a/.test(revised));
check("a newly added step starts as waiting", /- \[ \] d/.test(revised));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
