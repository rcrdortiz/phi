import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import mod from "../extensions/model-install.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

const handlers = {}, cmds = [], notes = [];
mod({
  on: (e, h) => ((handlers[e] ||= []).push(h)),
  registerCommand: (n, o) => { cmds.push(n); handlers["/" + n] = [o.handler]; },
  registerTool: () => {},
});
const fire = async (e, ev = {}, c) => { let r; for (const h of handlers[e] ?? []) { const x = await h(ev, c); if (x !== undefined) r = x; } return r; };

check("registers /model-install", cmds.includes("model-install"));
check("reconciles at session start", (handlers["session_start"] ?? []).length > 0);

// A --print run must not stop to rebuild models.
notes.length = 0;
await fire("session_start", {}, { mode: "print", ui: { notify: (m) => notes.push(m) } });
check("a --print run reconciles nothing", notes.length === 0);

// Unknown model name is refused rather than guessed at.
notes.length = 0;
await fire("/model-install", "not-a-real-model", {
  ui: { notify: (m, l) => notes.push(`${l}:${m}`), select: async () => undefined, confirm: async () => false },
});
check("an unknown model name is reported, not swallowed by the picker",
  notes.some((n) => /No preconfigured model named/.test(n)), notes.join(" | "));

// The modelfile the command builds from must exist and pin a context window,
// because the roster's contextWindow has to match it.
const mf = new URL("../modelfiles/qwen3.8-4MLX.modelfile", import.meta.url);
check("the preconfigured modelfile ships with the package", fs.existsSync(mf));
const body = fs.readFileSync(mf, "utf8");
const ctxLen = /num_ctx\s+(\d+)/.exec(body)?.[1];
check("it pins num_ctx", ctxLen !== undefined, `num_ctx ${ctxLen}`);

const roster = fs.readFileSync(new URL("../lib/ollama-models.ts", import.meta.url), "utf8");
const rosterCtx = /contextWindow:\s*(\d+)/.exec(roster)?.[1];
check("the roster agrees with the modelfile", rosterCtx === ctxLen,
  `roster ${rosterCtx} vs modelfile ${ctxLen} — drift here means pi sends more context than the model was loaded with`);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
