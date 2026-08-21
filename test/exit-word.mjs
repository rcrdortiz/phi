import exitWord, { isExitWord } from "../extensions/exit-word.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

// --- what counts as the word ----------------------------------------------
for (const w of ["exit", "quit", "EXIT", "  Quit  ", ":q", ":q!", ":wq"]) {
  check(`"${w}" quits`, isExitWord(w));
}
for (const w of ["exit the loop early", "exiting", "why does quit hang?", "exit()", "", "   "]) {
  check(`"${w}" is a prompt, not a command`, !isExitWord(w));
}
check("an attached image means it is a prompt", !isExitWord("exit", true),
  "nobody attaches a screenshot to a quit command");

// --- wiring ----------------------------------------------------------------
const handlers = {};
exitWord({
  on: (e, h) => ((handlers[e] ||= []).push(h)),
  registerCommand: () => {},
  registerTool: () => {},
});
check("hooks input", (handlers.input ?? []).length === 1);

let shutdowns = 0;
// pi hands the input event the plain extension context, where shutdown() sits
// at the top level. Command contexts keep it under .actions. Reaching for the
// wrong one throws inside pi's handler loop and the word is neither quit nor
// sent on: it prints a stack trace instead.
const ctx = { shutdown: () => { shutdowns++; } };
const fire = async (text, images, c = ctx) => {
  let r;
  for (const h of handlers.input ?? []) r = await h({ type: "input", text, images, source: "user" }, c);
  return r;
};

check("the word shuts pi down and is not sent on",
  (await fire("exit")).action === "handled" && shutdowns === 1);

const before = shutdowns;
check("a sentence is passed through untouched",
  (await fire("exit the loop early")).action === "continue" && shutdowns === before,
  "the model still gets real questions about exiting");

let nested = 0;
check("shutdown under .actions also works",
  (await fire("exit", undefined, { actions: { shutdown: () => { nested++; } } })).action === "handled" && nested === 1,
  "command contexts keep it there");

check("a context with neither passes the word on rather than throwing",
  (await fire("exit", undefined, {})).action === "continue",
  "a stack trace is worse than sending one stray word to the model");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
