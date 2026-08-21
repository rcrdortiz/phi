import workingTimer, { elapsedLabel, phaseFor, detailFor } from "../extensions/working-timer.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

// --- formatting ------------------------------------------------------------
check("under a minute reads in seconds", elapsedLabel(45_000) === "Working... 45s");
check("a partial second does not round up", elapsedLabel(999) === "Working... 0s");
check("past a minute it splits, so nobody does arithmetic",
  elapsedLabel(185_000) === "Working... 3m 05s", "not \"185s\"");
check("the boundary is exact", elapsedLabel(59_999) === "Working... 59s" && elapsedLabel(60_000) === "Working... 1m 00s");
check("seconds stay two digits after the minute", elapsedLabel(65_000) === "Working... 1m 05s");
check("a negative reading is clamped rather than shown", elapsedLabel(-5000) === "Working... 0s");

// --- what it says it is doing ----------------------------------------------
// Derived from the tool call, which pi hands over for free. Asking the model
// would cost output tokens on every phase change and a round trip at 20 tok/s.
check("a read names the file, not its directory",
  phaseFor("view_lines", { path: "/Users/rcrd/AI/pang-clone/pang.js" }) === "Reading pang.js",
  "the directory is rarely the surprising part and it makes the line unreadable");
check("a bash call names the program, not the pipeline",
  phaseFor("bash", { command: "./verify.sh 2>&1 | tail -5" }) === "Running ./verify.sh");
check("a multi-line command uses its first line only",
  detailFor("bash", { command: "cd /x\nmake all" }) === "cd");
check("an edit names the symbol when there is no path",
  phaseFor("edit_symbol", { symbol: "play" }) === "Editing play");
check("a tool with nothing to add shows just the verb",
  phaseFor("plan_write", {}) === "Writing the plan");
check("an unknown tool falls back to its own name",
  phaseFor("some_new_tool", {}) === "some_new_tool",
  "better a name you can look up than a wrong guess");
check("a long detail is truncated rather than wrapping the line",
  phaseFor("view_lines", { path: "a".repeat(80) }).length < 45);
check("missing args never throw", phaseFor("view_lines") === "Reading" && detailFor("bash", undefined) === "");

check("the phase sits between the label and the clock",
  elapsedLabel(65_000, "Reading pang.js") === "Working... Reading pang.js 1m 05s");
check("no phase still reads correctly", elapsedLabel(5_000) === "Working... 5s");

// --- wiring ----------------------------------------------------------------
const handlers = {};
workingTimer({
  on: (e, h) => ((handlers[e] ||= []).push(h)),
  registerCommand: () => {},
  registerTool: () => {},
});
for (const e of ["agent_start", "agent_end", "agent_settled", "session_shutdown", "tool_execution_start", "tool_execution_end"]) {
  check(`hooks ${e}`, (handlers[e] ?? []).length === 1);
}
check("a turn that aborts still clears the counter",
  (handlers.agent_settled ?? []).length === 1,
  "agent_end does not fire on an abort, and a frozen count reads as still working");

let message = "unset";
const ctx = { mode: "tui", ui: { setWorkingMessage: (m) => { message = m; } } };
const fire = async (e, c = ctx) => { for (const h of handlers[e] ?? []) await h({}, c); };

await fire("agent_start");
check("the counter starts at zero, and says what it is doing",
  message === "Working... Thinking 0s", message);
const tool = async (event, name = "tool_execution_start") => {
  for (const h of handlers[name] ?? []) await h(event, ctx);
};
await tool({ toolName: "outline", args: { path: "x/pang.js" } });
check("a tool call repaints immediately, not on the next tick",
  message === "Working... Reading pang.js 0s", message,
  "a tool that returns in under a second would otherwise never be named");
await tool({}, "tool_execution_end");
check("the gap after a tool call reads as thinking",
  message === "Working... Thinking 0s", message,
  "otherwise a finished read still looks like it is reading");

await fire("agent_end");
check("finishing restores pi's own label", message === undefined,
  "otherwise the last count sits frozen on screen");

// A --print run has no indicator to write to.
message = "unset";
await fire("agent_start", { mode: "print", ui: {} });
check("a non-TUI run is left alone", message === "unset");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
