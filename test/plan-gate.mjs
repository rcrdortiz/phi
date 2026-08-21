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

fs.rmSync(cwd, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
