import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import mod from "/Users/rcrd/AI/pi-local/extensions/plan-notes.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "revise-"));
const tools = {};
mod({ registerTool: (t) => (tools[t.name] = t), registerCommand: () => {}, on: () => {} });

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d.replace(/\n/g, "\n        ") : ""}`); };

let asked = null, notes = [];
const ctx = (mode = "tui") => ({
  cwd: DIR, mode,
  ui: {
    notify: (m) => notes.push(m),
    // Still provided, so a test failure here means the code called it, not that
    // it was unavailable. Removing the stub would hide a regression.
    confirm: async (title, message) => { asked = { title, message }; return true; },
  },
});
const plan = () => fs.readFileSync(path.join(DIR, ".pi", "PLAN.md"), "utf8");
const write = (goal, steps, c = ctx()) => tools.plan_write.execute("1", { goal, steps }, undefined, undefined, c);

await write("build a game", ["render the ship", "add enemies", "add sound"]);
await tools.plan_next.execute("2", { summary: "done" }, undefined, undefined, ctx());
check("baseline plan has one completed step", /- \[x\] render the ship/.test(plan()));

// 1. A revision that drops work applies without asking. Blocking on a dialog
//    defeats plan_next, which exists so the agent can run unattended.
asked = null; notes = [];
await write("build a game", ["render the ship", "add power-ups", "add music"]);
check("a revision that drops work is NOT blocked on a prompt", asked === null);
check("the revision actually applied", /add power-ups/.test(plan()) && !/add enemies/.test(plan()), plan().trim());

// 2. It is announced, because silence is the real failure mode, not the
//    absence of a prompt.
check("the change is announced", notes.some((n) => /Plan revised/.test(n)), notes.join(" | "));
check("the announcement says what was dropped", notes.some((n) => /dropping 2 pending/.test(n)), "both `add enemies` and `add sound` are gone: " + notes.join(" | "));
check("the announcement says what was added", notes.some((n) => /adding 2/.test(n)), notes.join(" | "));

// 3. Completed work survives a revision that keeps the step.
check("keeps completed state for surviving steps", /- \[x\] render the ship/.test(plan()), plan().trim());

// 4. A full pivot applies too, and does not error.
notes = [];
const r = await write("pivot", ["something else entirely"]);
check("a full pivot applies", /something else entirely/.test(plan()));
check("and is not reported as an error", !r.isError, r.content[0].text.slice(0, 70));

// 5. Pure additions are not announced: nothing was lost, so there is nothing
//    to draw attention to.
notes = [];
await write("pivot", ["something else entirely", "and another"]);
check("pure additions are not announced", !notes.some((n) => /Plan revised/.test(n)), notes.join(" | "));

// 6. Non-interactive runs behave identically.
asked = null;
await write("scripted", ["only this"], ctx("print"));
check("print mode applies without prompting", asked === null && /only this/.test(plan()));

fs.rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
