import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import mod from "/Users/rcrd/AI/pi-local/extensions/auto-handoff.ts";
import { resetCompactionState } from "/Users/rcrd/AI/pi-local/lib/compaction.ts";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"));
const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

resetCompactionState();
const handlers = {}, cmds = [], notes = [];
let compactCalls = 0;
mod({
  on: (e, h) => (handlers[e] = h),
  registerCommand: (n, o) => { cmds.push(n); handlers["/" + n] = o.handler; },
  registerTool: () => {},
});
const ctx = {
  cwd: DIR,
  ui: { notify: (t) => notes.push(t) },
  getContextUsage: () => ({ tokens: 40_000, contextWindow: 65_536, percent: 61 }),
  compact: (o) => { compactCalls++; o.onComplete?.({ summary: "state summary", tokensBefore: 40_000 }); },
};

// 1. turn_end IS hooked again, as a mid-run watchdog. pi checks for
//    auto-compaction only at agent_end and before prompt submission, so during
//    one long agentic run nothing watches the window: observed at 96.3% of 51K.
check("hooks turn_end as a mid-run watchdog", typeof handlers["turn_end"] === "function",
  Object.keys(handlers).filter((k) => !k.startsWith("/")).join(", "));

// It must stay quiet well below pi's trigger, so it does not pre-empt pi
// between runs, where pi genuinely does act.
compactCalls = 0;
await handlers["turn_end"]({}, { ...ctx, getContextUsage: () => ({ tokens: 20_000, contextWindow: 65_536 }) });
check("the watchdog stays quiet below the trigger", compactCalls === 0, "20k of 64k");

resetCompactionState();
compactCalls = 0;
await handlers["turn_end"]({}, { ...ctx, getContextUsage: () => ({ tokens: 63_000, contextWindow: 65_536 }) });
check("the watchdog fires above the trigger", compactCalls === 1, "96% of 64k, mid-run");

// 2. pi's own compaction still lands on disk.
await handlers["session_compact"]({ compactionEntry: { summary: "pi's summary", tokensBefore: 54_784 } }, ctx);
const hp = path.join(DIR, ".pi", "HANDOFF.md");
check("records pi's compaction to disk", fs.existsSync(hp) && /pi's summary/.test(fs.readFileSync(hp, "utf8")),
  fs.existsSync(hp) ? fs.readFileSync(hp, "utf8").split("\n")[2] : "missing");

// 3. /handoff still compacts on demand, with our instructions.
resetCompactionState();
compactCalls = 0;                 // the watchdog checks above ran their own
await handlers["/handoff"]("", ctx);
check("/handoff compacts on demand", compactCalls === 1);
check("/handoff writes its own summary", /state summary/.test(fs.readFileSync(hp, "utf8")));

// 4. /context reports pi's trigger, not ours.
notes.length = 0;
await handlers["/context"]("", ctx);
check("/context reports pi's compaction point", /pi compacts above 75%/.test(notes.join(" ")), notes.join(" ").split("\n")[1]);

fs.rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
