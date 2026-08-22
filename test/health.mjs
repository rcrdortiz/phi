// A health check that invents a diagnosis is worse than one that says it cannot
// tell. These are mostly tests that it refuses to guess.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recentEvictions, verdict } from "../lib/health.ts";
import { report } from "../extensions/doctor.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

// --- reading the log --------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phi-health-"));
const log = path.join(dir, "server.log");
const now = Date.now();
const stamp = (minsAgo) => new Date(now - minsAgo * 60_000).toISOString();
fs.writeFileSync(log, [
  `time=${stamp(5)} level=INFO msg="failed to restore cache, freeing all caches" offset=3646`,
  `time=${stamp(10)} level=INFO msg="cache hit" total=100 matched=90`,
  `time=${stamp(20)} level=INFO msg="failed to restore cache, freeing all caches" offset=8191`,
  `time=${stamp(90)} level=INFO msg="failed to restore cache, freeing all caches" offset=3646`,
].join("\n"));

check("evictions inside the window are counted", recentEvictions(30, log) === 2,
  String(recentEvictions(30, log)));
check("older ones are not", recentEvictions(30, log) < recentEvictions(240, log));
check("ordinary lines are ignored", recentEvictions(240, log) === 3, String(recentEvictions(240, log)));
check("a missing log is unknown, not zero", recentEvictions(30, path.join(dir, "nope.log")) === undefined,
  "zero would read as healthy, which is the opposite of what is known");
fs.rmSync(dir, { recursive: true, force: true });

// --- the verdict ------------------------------------------------------------
const base = { wiredLimit: 40e9, modelBytes: 26e9, headroom: 14e9, contextLength: 40960, evictionWindowMinutes: 30, notes: [] };
check("no eviction data means no verdict", verdict({ ...base, evictions: undefined, notes: ["log unreadable"] }).level === "unknown",
  "partial data must not produce a confident answer");
check("a clean window is healthy", verdict({ ...base, evictions: 0 }).level === "ok");
check("one eviction is a warning, not a crisis", verdict({ ...base, evictions: 1 }).level === "warn");
check("frequent evictions are called thrashing", verdict({ ...base, evictions: 8 }).level === "bad",
  "eight in thirty minutes is a turn re-reading everything every few minutes");
check("the advice names the lever", /num_ctx/.test(verdict({ ...base, evictions: 8 }).advice.join(" ")));
check("healthy output does not nag", verdict({ ...base, evictions: 0 }).advice.every((a) => !/num_ctx/.test(a)));

// --- the report -------------------------------------------------------------
const text = report({ ...base, evictions: 8, modelName: "m" });
check("the report leads with the verdict", text.split("\n")[0].startsWith("bad:"));
check("it shows the numbers it judged on", /resident/.test(text) && /headroom/.test(text) && /evictions/.test(text));
check("an unknown field prints as unknown rather than zero",
  /window\s+\?/.test(report({ evictions: 0, evictionWindowMinutes: 30, notes: [] })),
  "a missing window must not read as a window of nothing");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
