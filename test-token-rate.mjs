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
