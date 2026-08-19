import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import planNotes from "/Users/rcrd/AI/pi-local/extensions/plan-notes.ts";
import autoHandoff from "/Users/rcrd/AI/pi-local/extensions/auto-handoff.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"));
const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

// Both extensions, as pi would load them: separate modules, shared lib.
const tools = {}, planH = {}, handoffH = {};
planNotes({ registerTool: (t) => (tools[t.name] = t), registerCommand: () => {}, on: (e, h) => (planH[e] = h) });
autoHandoff({ registerTool: () => {}, registerCommand: () => {}, on: (e, h) => (handoffH[e] = h) });

let compactCalls = 0, notes = [], tokens = 60_000, completeFns = [];
const ctx = {
  cwd: DIR,
  ui: { notify: (t) => notes.push(t) },
  getContextUsage: () => ({ tokens, contextWindow: 65_536, percent: (tokens / 65_536) * 100 }),
  compact: (o) => { compactCalls++; completeFns.push(o.onComplete); },   // stays in flight
};

await tools.plan_write.execute("1", { goal: "g", steps: ["one", "two"] }, undefined, undefined, ctx);
await tools.plan_next.execute("2", {}, undefined, undefined, ctx);

// Both handlers fire on the same turn_end — the collision that produced
// "aborted" + "Nothing to compact (session too small)".
await planH["turn_end"]({}, ctx);
await handoffH["turn_end"]({}, ctx);
check("only one compaction runs when both extensions want one", compactCalls === 1, `compact() called ${compactCalls}x`);
check("no misleading 'cannot start a fresh one' message", !notes.some((n) => /fresh one/.test(n)), notes.join(" | "));

// A second request while one is in flight is refused, not queued.
await handoffH["turn_end"]({}, ctx);
check("in-flight compaction blocks a second request", compactCalls === 1);

// After completion, a benign error must not surface to the user.
completeFns[0]?.({ summary: "S", tokensBefore: tokens });
notes = [];
tokens = 64_000;
await handoffH["turn_end"]({}, ctx);   // within the cooldown window
check("cooldown prevents an immediate re-compaction", compactCalls === 1, `calls=${compactCalls}`);
check("no error text shown to the user", !notes.some((n) => /failed|aborted|too small/i.test(n)), notes.join(" | "));

fs.rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
