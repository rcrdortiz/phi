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
const ctx = { actions: { shutdown: () => { shutdowns++; } } };
const fire = async (text, images) => {
  let r;
  for (const h of handlers.input ?? []) r = await h({ type: "input", text, images, source: "user" }, ctx);
  return r;
};

check("the word shuts pi down and is not sent on",
  (await fire("exit")).action === "handled" && shutdowns === 1);

const before = shutdowns;
check("a sentence is passed through untouched",
  (await fire("exit the loop early")).action === "continue" && shutdowns === before,
  "the model still gets real questions about exiting");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
