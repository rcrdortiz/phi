import mod from "/Users/rcrd/AI/pi-local/extensions/thinking-level.ts";
import { MODELS, toPiModel } from "/Users/rcrd/AI/pi-local/lib/ollama-models.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d.split("\n").join(" / ") : ""}`); };

// 1. The map is what turns pi's scale into Ollama's reasoning_effort.
const fast = toPiModel(MODELS.find((m) => m.id === "qwen3.8-fast"));
check("models expose a thinkingLevelMap", !!fast.thinkingLevelMap, JSON.stringify(fast.thinkingLevelMap));
check('"off" maps to Ollama\'s "none"', fast.thinkingLevelMap.off === "none");
check("no stale hardcoded samplingParams", fast.samplingParams === undefined, JSON.stringify(fast.samplingParams));

// 2. Selecting a model applies that tier's default.
const handlers = {}, notes = [];
let level = "high";
mod({
  on: (e, h) => (handlers[e] = h),
  registerCommand: (n, o) => (handlers["/" + n] = o.handler),
  getThinkingLevel: () => level,
  setThinkingLevel: (l) => (level = l),
});
const ctx = { ui: { notify: (t) => notes.push(t) }, model: { id: "qwen3.8-fast" } };

await handlers["model_select"]({ model: { id: "qwen3.8-fast" } }, ctx);
check("selecting fast turns thinking off", level === "off", `level=${level}`);

await handlers["model_select"]({ model: { id: "qwen3.8-medium" } }, ctx);
check("selecting medium uses low", level === "low", `level=${level}`);

await handlers["model_select"]({ model: { id: "qwen3.8-reasoning" } }, ctx);
check("selecting reasoning uses high", level === "high", `level=${level}`);

// 3. /effort sets and reports.
notes.length = 0;
await handlers["/effort"]("low", ctx);
check("/effort sets the level", level === "low", notes.join(" "));
check("/effort explains the cost", /tokens/.test(notes.join(" ")), notes.join(" "));

notes.length = 0;
await handlers["/effort"]("", ctx);
check("/effort with no argument reports", /Thinking: low/.test(notes.join(" ")), notes.join(" ").split("/")[0]);

notes.length = 0;
await handlers["/effort"]("wild", ctx);
check("/effort rejects an unknown level", /Unknown level/.test(notes.join(" ")) && level === "low");

// 4. Cycling with Shift+Tab reports through the same path.
notes.length = 0;
await handlers["thinking_level_select"]({ level: "high" }, ctx);
check("cycling reports the new level", /Thinking: high/.test(notes.join(" ")), notes.join(" ").split("/")[0]);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
