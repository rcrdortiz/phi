import mod from "/Users/rcrd/AI/pi-local/extensions/thinking-level.ts";
import { MODELS, toPiModel } from "/Users/rcrd/AI/pi-local/lib/ollama-models.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d.split("\n").join(" / ") : ""}`); };

// 1. The map is what turns pi's scale into Ollama's reasoning_effort.
const fast = toPiModel(MODELS.find((m) => m.id === "qwen3.8-4MLX"));
check("models expose a thinkingLevelMap", !!fast.thinkingLevelMap, JSON.stringify(fast.thinkingLevelMap));
check('"off" maps to Ollama\'s "none"', fast.thinkingLevelMap.off === "none");
// pi gates the whole control on `reasoning`: getSupportedThinkingLevels returns
// only ["off"] when it is false, so Shift+Tab is a no-op, /effort clamps to off
// and thinkingLevelMap is never consulted. Both qwen3.8 quantisations are the
// same thinking-capable base, so both must declare it.
for (const m of MODELS) {
  check(`${m.id} declares reasoning support`, m.reasoning === true);
}
// Sampling is no longer baked per variant — it is derived from the level, and
// defaults to the model's own starting level.
check("sampling matches the model's default level",
  fast.samplingParams?.temperature === 0.7 && fast.samplingParams?.presence_penalty === 1.5,
  JSON.stringify(fast.samplingParams));
// Built here rather than looked up in the roster: this asserts that sampling
// follows the LEVEL, which must hold for any model, not just whichever entry
// happens to default to high today.
const reasoning = toPiModel({ ...MODELS[0], id: "synthetic-high", defaultThinking: "high" });
check("a thinking-default model gets thinking sampling",
  reasoning.samplingParams?.temperature === 1.0, JSON.stringify(reasoning.samplingParams));
check("and an instruct-default one does not",
  toPiModel({ ...MODELS[0], defaultThinking: "off" }).samplingParams?.temperature === 0.7);

// 2. Selecting a model applies that tier's default.
const handlers = {}, notes = [];
let level = "high";
let registered = [];
mod({
  on: (e, h) => (handlers[e] = h),
  registerCommand: (n, o) => (handlers["/" + n] = o.handler),
  getThinkingLevel: () => level,
  setThinkingLevel: (l) => (level = l),
  registerProvider: (_n, cfg) => registered.push(cfg),
});
const ctx = { ui: { notify: (t) => notes.push(t) }, model: { id: "qwen3.8-4MLX" } };

await handlers["model_select"]({ model: { id: "qwen3.8-4MLX" } }, ctx);
check("selecting fast turns thinking off", level === "off", `level=${level}`);

// A model with no roster entry must not clobber the current level: the map is
// a per-model DEFAULT, not a reset.
level = "medium";
await handlers["model_select"]({ model: { id: "some-other-provider-model" } }, ctx);
check("an unknown model leaves the level alone", level === "medium", `level=${level}`);

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

// 4. Sampling must follow the level: thinking at instruct temperatures is the
// documented cause of repetition loops in Qwen models.
registered = [];
await handlers["thinking_level_select"]({ level: "off" }, ctx);
const instruct = registered.at(-1)?.models?.[0]?.samplingParams;
check("thinking off uses instruct sampling", instruct?.temperature === 0.7 && instruct?.presence_penalty === 1.5,
  JSON.stringify(instruct));

registered = [];
await handlers["thinking_level_select"]({ level: "high" }, ctx);
const thinking = registered.at(-1)?.models?.[0]?.samplingParams;
check("thinking on uses thinking sampling", thinking?.temperature === 1.0 && thinking?.top_p === 0.95,
  JSON.stringify(thinking));

registered = [];
await handlers["thinking_level_select"]({ level: "high" }, ctx);
check("no redundant re-registration for the same level", registered.length === 0);

// 5. Only three models remain: 4-bit, 4-bit MoE coder, and 8-bit.
check("the medium variant is gone", !MODELS.some((m) => m.id === "qwen3.8-medium"),
  MODELS.map((m) => m.id).join(", "));

// 6. Cycling with Shift+Tab reports through the same path.
notes.length = 0;
await handlers["thinking_level_select"]({ level: "high" }, ctx);
check("cycling reports the new level", /Thinking: high/.test(notes.join(" ")), notes.join(" ").split("/")[0]);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
