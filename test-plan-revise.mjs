import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import mod from "/Users/rcrd/AI/pi-local/extensions/plan-notes.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "revise-"));
const tools = {};
mod({ registerTool: (t) => (tools[t.name] = t), registerCommand: () => {}, on: () => {} });

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d.replace(/\n/g, "\n        ") : ""}`); };

let asked = null, answer = true;
const ctx = (mode = "tui") => ({
  cwd: DIR, mode,
  ui: {
    notify: () => {},
    confirm: async (title, message) => { asked = { title, message }; return answer; },
  },
});
const plan = () => fs.readFileSync(path.join(DIR, ".pi", "PLAN.md"), "utf8");
const write = (goal, steps, c = ctx()) => tools.plan_write.execute("1", { goal, steps }, undefined, undefined, c);

// Baseline plan, first step completed.
await write("build a game", ["render the ship", "add enemies", "add sound"]);
await tools.plan_next.execute("2", { summary: "done" }, undefined, undefined, ctx());
check("baseline plan has one completed step", /- \[x\] render the ship/.test(plan()));

// 1. A revision that drops work must explain and ask.
asked = null; answer = true;
await write("build a game", ["render the ship", "add power-ups", "add music"]);
check("asks before dropping steps", asked !== null, asked?.message);
check("names what is being dropped", /No longer doing:[\s\S]*add enemies/.test(asked?.message ?? ""));
check("names what is being added", /Adding:[\s\S]*\+ add power-ups/.test(asked?.message ?? ""));
check('ends with "Is that correct?"', /Is that correct\?$/.test((asked?.message ?? "").trim()));

// 2. Completed work survives a revision that keeps the step.
check("keeps completed state for surviving steps", /- \[x\] render the ship/.test(plan()), plan().trim());

// 3. Declining leaves the plan untouched and tells the model why.
const beforeDecline = plan();
asked = null; answer = false;
const r = await write("pivot", ["something else entirely"]);
check("declining leaves the plan unchanged", plan() === beforeDecline);
check("declining returns an error the model can act on", r.isError === true && /did not accept/.test(r.content[0].text), r.content[0].text.slice(0, 80));

// 4. Pure additions do not interrupt.
asked = null; answer = true;
await write("build a game", ["render the ship", "add power-ups", "add music", "add a scoreboard"]);
check("pure additions do not ask", asked === null);

// 5. Non-interactive runs are not blocked by a prompt that cannot be answered.
asked = null;
await write("scripted", ["only this"], ctx("print"));
check("print mode applies without prompting", asked === null && /only this/.test(plan()));

fs.rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
