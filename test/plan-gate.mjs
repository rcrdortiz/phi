// New work must not start against a plan whose steps are all finished.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import plan, { planIsSpent } from "../extensions/plan-notes.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

// --- the predicate ---------------------------------------------------------
check("a plan with every step done is spent", planIsSpent([{ done: true, text: "a" }, { done: true, text: "b" }]));
check("one unfinished step means work is still in progress",
  !planIsSpent([{ done: true, text: "a" }, { done: false, text: "b" }]));
check("no plan at all is not a spent plan", !planIsSpent([]),
  "a session that never planned may be answering a one-line request");

// --- the gate --------------------------------------------------------------
const handlers = {};
plan({
  on: (e, h) => ((handlers[e] ||= []).push(h)),
  registerCommand: () => {},
  registerTool: () => {},
  sendUserMessage: () => {},
});

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "phi-plan-gate-"));
fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
const writePlan = (body) => fs.writeFileSync(path.join(cwd, ".pi", "PLAN.md"), `# Plan\n\n${body}\n`);
const call = async (toolName) => {
  let r;
  for (const h of handlers.tool_call ?? []) r = (await h({ toolName, input: {} }, { cwd })) ?? r;
  return r;
};

writePlan("- [x] one\n- [x] two");
const blocked = await call("edit_symbol");
check("an edit against a finished plan is refused", blocked?.block === true);
check("the refusal says what to do instead", /plan_write/.test(blocked?.reason ?? ""),
  blocked?.reason);

check("reading is never gated", (await call("view_lines"))?.block !== true,
  "the model has to be able to look before it can plan");
check("plan_write itself is not gated", (await call("plan_write"))?.block !== true,
  "gating the escape hatch would deadlock the session");

writePlan("- [x] one\n- [ ] two");
check("an edit with work outstanding goes through", (await call("edit_symbol"))?.block !== true);

fs.rmSync(path.join(cwd, ".pi", "PLAN.md"));
check("a session with no plan is left alone", (await call("edit_symbol"))?.block !== true,
  "otherwise every one-line request has to be planned first");

// --- the briefing on a finished plan --------------------------------------
// A spent plan used to brief nothing at all: no goal, no findings, not even the
// fact that a plan file exists. The model then began the next task with no idea
// it was expected to plan, which is why HANDOFF.md filled with work PLAN.md
// never mentioned.
const brief = async (planBody, notes) => {
  fs.writeFileSync(path.join(cwd, ".pi", "PLAN.md"), `# Plan\n\n**Goal:** ship the thing\n\n${planBody}\n`);
  if (notes === undefined) fs.rmSync(path.join(cwd, ".pi", "NOTES.md"), { force: true });
  else fs.writeFileSync(path.join(cwd, ".pi", "NOTES.md"), notes);
  let out;
  for (const h of handlers.before_agent_start ?? []) out = (await h({ systemPrompt: "BASE" }, { cwd })) ?? out;
  return out?.systemPrompt ?? "BASE";
};

const spent = await brief("- [x] one\n- [x] two", "- the renderer is in pang.js");
check("a finished plan says so rather than saying nothing",
  /complete/i.test(spent) && spent !== "BASE");
check("and names what was finished", /ship the thing/.test(spent));
check("and asks for a plan before the next edit", /plan_write/.test(spent));
check("and says the refusal is not negotiable",
  /refused|not optional/i.test(spent), "otherwise it reads as a suggestion");
check("findings survive the plan finishing",
  /the renderer is in pang\.js/.test(spent),
  "notes used to disappear from the brief the moment the last step was ticked");

const active = await brief("- [x] one\n- [ ] two", undefined);
check("an unfinished plan still briefs the current step",
  /do only this one/i.test(active) && !/is complete/.test(active));

// brief() writes the file, so a genuine "no plan" case has to call the handler
// directly with nothing on disk. Going through brief() would have tested a plan
// file with no steps, which is a different thing wearing the same label.
fs.rmSync(path.join(cwd, ".pi", "PLAN.md"), { force: true });
fs.rmSync(path.join(cwd, ".pi", "NOTES.md"), { force: true });
let none;
for (const h of handlers.before_agent_start ?? []) none = (await h({ systemPrompt: "BASE" }, { cwd })) ?? none;
check("a session with no plan at all is briefed nothing", none === undefined,
  "a one-line request does not need a plan, and saying so every turn costs context");

fs.rmSync(cwd, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
