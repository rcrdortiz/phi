import * as fs from "node:fs";
import * as path from "node:path";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
import mod from "../extensions/thinking-level.ts";
import { MODELS, toPiModel } from "../lib/ollama-models.ts";

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
  fast.samplingParams?.temperature === 1.0 && fast.samplingParams?.top_p === 0.95,
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

level = "off";
await handlers["model_select"]({ model: { id: "qwen3.8-4MLX" } }, ctx);
check("selecting the model applies its roster default", level === MODELS[0].defaultThinking,
  `level=${level}, roster=${MODELS[0].defaultThinking}`);

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

// model_select does not fire for the model a session OPENS with, so a machine
// whose settings name a default model started at pi's own default, "medium",
// whatever the roster asked for. The footer said "medium" on a fresh install.
{
  let lvl = "medium";
  const h = {};
  mod({
    on: (e, fn) => ((h[e] ||= []).push(fn)),
    registerCommand: () => {},
    getThinkingLevel: () => lvl,
    setThinkingLevel: (l) => (lvl = l),
    registerProvider: () => {},
  });
  check("session_start is hooked", (h["session_start"] ?? []).length > 0);
  await h["session_start"][0]({}, { ui: { notify: () => {} }, model: { id: "qwen3.8-4MLX" } });
  check("a session opens at the model's own default", lvl === MODELS[0].defaultThinking, `level=${lvl}`);

  // A model with no roster entry must not be forced anywhere. Set to something
  // that is NOT the roster default, or this passes whatever the code does.
  const other = MODELS[0].defaultThinking === "medium" ? "high" : "medium";
  lvl = other;
  await h["session_start"][0]({}, { ui: { notify: () => {} }, model: { id: "some-other-model" } });
  check("an unknown model is left alone", lvl === other, `level=${lvl}`);
}

// "high" is the top of the scale this model actually has. Mapping pi's xhigh
// and max would add levels indistinguishable from high.
{
  const top = toPiModel(MODELS[0]);
  const mapped = Object.keys(top.thinkingLevelMap ?? {});
  check("the map stops at high", mapped.includes("high") && !mapped.includes("xhigh") && !mapped.includes("max"),
    mapped.join(", "));
  // Not the top of the scale. A sweep of off/low/medium/high scored 18-20 of 23
  // at every level, inside a +-2 noise floor, and output tokens did not track
  // the level (r = +0.17, n = 11). Nothing distinguished them, so the default is
  // the cheap end until something does. It still has to BE on the scale.
  check("the roster default is a level the map offers",
    mapped.includes(MODELS[0].defaultThinking), `${MODELS[0].defaultThinking} vs ${mapped.join(", ")}`);
}

const failed = results.filter((r) => !r).length;

// --- draft_num_predict stays, the DFlash2 provider does not ---------------
// The second provider was removed after measuring: MTP produces 3.12 tokens per
// forward pass against DFlash2's 2.22, counted by the runtime over 146,357
// iterations, so it does not depend on this machine's timing. But the option
// itself matters: Ollama zeroes it when a model has no separate DraftPath,
// which is the case for a drafter baked in by `ollama create`, and then
// speculation is off with nothing saying so.
{
  const roster = fs.readFileSync(path.join(root, "lib/ollama-models.ts"), "utf8");
  check("draft_num_predict is in the sampling params",
    /draft_num_predict: DRAFT_TOKENS/.test(roster));
  check("both sampling modes carry it",
    (roster.match(/draft_num_predict: DRAFT_TOKENS/g) || []).length === 2,
    "switching thinking level re-registers the provider and would otherwise drop it");
  check("no DFlash provider is left behind",
    !/DFLASH_PROVIDER|DFLASH_URL/.test(roster),
    "a provider pointing at a server nobody is running is a model you cannot load");
}


// --- a model must carry its own server, not the default one ---------------
// toPiModel hardcoded PROVIDER and BASE_URL, so a model registered under
// ollama-dflash was still sent to 11434. The released build shares
// ~/.ollama/models, so it saw the model, tried to load it, and rejected
// DFlash2DraftModel. It read as a broken model rather than a misrouted request,
// and the footer showed the right provider the whole time.
{
  const m = MODELS[0];
  const dflt = toPiModel(m);
  const other = toPiModel(m, undefined, { provider: "ollama-dflash", baseUrl: "http://localhost:11435/v1" });
  check("a model defaults to the main provider and URL",
    dflt.provider === "ollama-local" && /11434/.test(dflt.baseUrl), `${dflt.provider} ${dflt.baseUrl}`);
  check("and takes an override for both",
    other.provider === "ollama-dflash" && /11435/.test(other.baseUrl), `${other.provider} ${other.baseUrl}`);
  check("the override changes nothing else",
    other.id === dflt.id && other.contextWindow === dflt.contextWindow);
}

console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
