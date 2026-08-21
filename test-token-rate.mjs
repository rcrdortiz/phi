import mod, { RateTracker, format } from "/Users/rcrd/AI/pi-local/extensions/token-rate.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

// --- rate maths -----------------------------------------------------------
const t = new RateTracker();
t.begin(0);
check("computes tokens per second", Math.round(t.end(1000, 30)) === 30, "30 tokens in 1000ms");
t.begin(0);
check("a trivial reply is not sampled", t.end(10, 3) === undefined, "3 tokens times its own scheduling, not the model");
check("end without begin is safe", t.end(1000, 50) === undefined);

// --- prefill is excluded from the decode rate -----------------------------
// The whole point: a blended number cannot distinguish "deep context" from
// "the prefix cache missed", and those have opposite fixes.
const sp = new RateTracker();
sp.begin(0);
sp.firstToken(9000);          // 9s of prompt processing
const decode = sp.end(10000, 40);   // then 40 tokens in 1s
check("decode excludes the wait for the first token", Math.round(decode) === 40,
  `40 tok/s decoding, not the 4 tok/s a blended window would report`);
check("the prefill wait is reported separately", Math.round(sp.prefillSeconds()) === 9, `${sp.prefillSeconds()}s`);

const noStream = new RateTracker();
noStream.begin(0);
const blended = noStream.end(1000, 20);   // never streamed text
check("with no streamed token, the whole window counts as decode", Math.round(blended) === 20,
  "no boundary is invented when none was observed");

// A tool-calling turn: usage.output counts the toolCall tokens, so the boundary
// must be the first output of ANY kind. Anchoring on text alone reported
// 385 tok/s on hardware that decodes at 15-45.
const toolTurn = {};
mod({ on: (e, h) => (toolTurn[e] = h), registerCommand: () => {}, registerTool: () => {} });
const tctx = { ui: { setStatus: (k, v) => (toolTurn._s = v), notify: () => {} } };
await toolTurn["message_start"]({}, tctx);
await toolTurn["message_update"]({ message: { content: [{ type: "toolCall", name: "view_lines" }] } }, tctx);
await new Promise((r) => setTimeout(r, 40));
await toolTurn["message_end"]({ message: { role: "assistant", usage: { output: 60 } } }, tctx);
const reported = Number(String(toolTurn._s ?? "").match(/[\d.]+/)?.[0] ?? 0);
check("a tool call starts the decode window, not the text after it", reported < 5000 && reported > 0,
  `${toolTurn._s} — measured across the whole generation, not the sliver after text appeared`);

// With thinking on `high` the reasoning pass is most of a turn, and
// usage.output counts those tokens. Anchoring on visible text alone reported
// an average of 155 tok/s on hardware that peaks at 47.
const thinkTurn = {};
mod({ on: (e, h) => (thinkTurn[e] = h), registerCommand: () => {}, registerTool: () => {} });
const thctx = { ui: { setStatus: (k, v) => (thinkTurn._s = v), notify: () => {} } };
await thinkTurn["message_start"]({}, thctx);
await thinkTurn["message_update"]({ message: { content: [{ type: "thinking", thinking: "considering..." }] } }, thctx);
await new Promise((r) => setTimeout(r, 40));
await thinkTurn["message_end"]({ message: { role: "assistant", usage: { output: 80 } } }, thctx);
const thRate = Number(String(thinkTurn._s ?? "").match(/[\d.]+/)?.[0] ?? 0);
check("thinking starts the decode window", thRate > 0 && thRate < 5000,
  `${thinkTurn._s} — measured across the reasoning pass, not the sliver after it`);

const late = new RateTracker();
late.begin(0);
late.firstToken(500); late.firstToken(800);   // only the first one counts
check("only the first streamed token sets the boundary", Math.round(late.end(1500, 10)) === 10, "boundary stays at 500ms");

// Token-weighted, so one short fast reply cannot skew the picture.
const w = new RateTracker();
w.begin(0); w.end(1000, 10);      // 10 tok/s
w.begin(0); w.end(1000, 30);      // 30 tok/s
check("average is token-weighted, not per-message", Math.round(w.average()) === 20,
  `40 tokens over 2000ms = 20 tok/s, not the 20 a naive mean would coincidentally give`);
const w2 = new RateTracker();
w2.begin(0); w2.end(100, 10);     // 100 tok/s, tiny
w2.begin(0); w2.end(10000, 100);  // 10 tok/s, the real work
check("a fast tiny sample does not dominate", Math.round(w2.average()) === 11,
  `110 tokens / 10100ms = 11 tok/s; a per-message mean would say 55`);

// --- rolling window -------------------------------------------------------
const r = new RateTracker();
for (let i = 0; i < 30; i++) { r.begin(0); r.end(1000, 20); }
check("keeps a bounded window of samples", Math.round(r.average()) === 20);
r.reset();
check("reset clears the average", r.average() === undefined);

// --- formatting -----------------------------------------------------------
check("shows one number when the average agrees", format(30, 30.2) === "30 tok/s", format(30, 30.2));
check("shows the average when it differs", /avg/.test(format(30, 12)), format(30, 12));
check("keeps a decimal when slow", format(4.2, 4.2) === "4.2 tok/s", format(4.2, 4.2));
check("drops the decimal when fast", format(31.7, 31.7) === "32 tok/s", format(31.7, 31.7));

// --- wiring ---------------------------------------------------------------
const handlers = {}, cmds = [], status = {}, notes = [];
mod({ on: (e, h) => (handlers[e] = h), registerCommand: (n, o) => { cmds.push(n); handlers["/" + n] = o.handler; }, registerTool: () => {} });
const ctx = { ui: { setStatus: (k, v) => (status[k] = v), notify: (m) => notes.push(m) } };

check("hooks message_start and message_end", typeof handlers["message_start"] === "function" && typeof handlers["message_end"] === "function");
check("registers /speed", cmds.includes("speed"));

await handlers["message_start"]({}, ctx);
await new Promise((r) => setTimeout(r, 30));
await handlers["message_end"]({ message: { role: "assistant", usage: { output: 40 } } }, ctx);
check("publishes a rate to the footer", /tok\/s/.test(status.tokrate ?? ""), status.tokrate);

await handlers["message_start"]({}, ctx);
await handlers["message_end"]({ message: { role: "user" } }, ctx);
check("user messages are not timed", /tok\/s/.test(status.tokrate ?? ""), "unchanged: " + status.tokrate);

await handlers["model_select"]({}, ctx);
check("switching model clears the stale rate", status.tokrate === undefined);

await handlers["/speed"]("", ctx);
check("/speed reports when nothing is sampled", /No generation sampled/.test(notes.join(" ")), notes.join(" "));

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
