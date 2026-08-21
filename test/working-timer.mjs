import workingTimer, { elapsedLabel } from "../extensions/working-timer.ts";

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

// --- wiring ----------------------------------------------------------------
const handlers = {};
workingTimer({
  on: (e, h) => ((handlers[e] ||= []).push(h)),
  registerCommand: () => {},
  registerTool: () => {},
});
for (const e of ["agent_start", "agent_end", "agent_settled", "session_shutdown"]) {
  check(`hooks ${e}`, (handlers[e] ?? []).length === 1);
}
check("a turn that aborts still clears the counter",
  (handlers.agent_settled ?? []).length === 1,
  "agent_end does not fire on an abort, and a frozen count reads as still working");

let message = "unset";
const ctx = { mode: "tui", ui: { setWorkingMessage: (m) => { message = m; } } };
const fire = async (e, c = ctx) => { for (const h of handlers[e] ?? []) await h({}, c); };

await fire("agent_start");
check("the counter starts at zero, not blank", message === "Working... 0s");
await fire("agent_end");
check("finishing restores pi's own label", message === undefined,
  "otherwise the last count sits frozen on screen");

// A --print run has no indicator to write to.
message = "unset";
await fire("agent_start", { mode: "print", ui: {} });
check("a non-TUI run is left alone", message === "unset");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
