// A health check that invents a diagnosis is worse than one that says it cannot
// tell. These are mostly tests that it refuses to guess.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recentEvictions, verdict, parallelSlots } from "../lib/health.ts";
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


// --- contention, the cause the capacity story missed -------------------------
const thrash = { evictions: 8, evictionWindowMinutes: 30, headroom: 16.2e9, contextLength: 40960, modelBytes: 26.6e9, wiredLimit: 42.8e9, notes: [] };
const contended = verdict({ ...thrash, otherSessions: 1, parallelSlots: 1 });
const alone = verdict({ ...thrash, otherSessions: 0, parallelSlots: 1 });

check("a second session sharing one slot is named as the cause",
  /cache slot/.test(contended.advice.join(" ")) && /other agent session/.test(contended.advice.join(" ")),
  contended.advice.join(" | "));

check("contention is surfaced in the summary, not buried in advice",
  /sharing/.test(contended.summary), contended.summary);

check("the num_ctx advice is withheld when contention explains it",
  !/num_ctx/.test(contended.advice.join(" ")),
  "lowering the window does not help two sessions share one slot, and we measured that it did not");

check("with no other session the capacity advice still stands",
  /num_ctx/.test(alone.advice.join(" ")), alone.advice.join(" | "));

check("one session in one slot is not contention",
  !/cache slot/.test(alone.summary), alone.summary);

check("unknown session count never invents contention",
  !/cache slot/.test(verdict({ ...thrash, otherSessions: undefined, parallelSlots: 1 }).advice.join(" ")),
  "an unreadable process list must not become a confident diagnosis");

check("more slots than sessions is not contention",
  !/cache slot/.test(verdict({ ...thrash, otherSessions: 1, parallelSlots: 4 }).advice.join(" ")),
  "two conversations across four slots do not evict each other");

const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "phi-slots-"));
const slotLog = path.join(dir2, "slots.log");
fs.writeFileSync(slotLog, `time=${stamp(1)} level=INFO msg="system memory" OLLAMA_NUM_PARALLEL:1 x=1\n`);
check("slots are read from the log Ollama actually wrote", parallelSlots(slotLog) === 1, parallelSlots(slotLog));

const bareLog = path.join(dir2, "bare.log");
fs.writeFileSync(bareLog, "time=x msg=\"cache hit\" total=100\n");
check("a log without the line gives undefined, not a default dressed as a reading",
  parallelSlots(bareLog) === undefined, parallelSlots(bareLog));

const slotLog4 = path.join(dir2, "slots4.log");
fs.writeFileSync(slotLog4, `OLLAMA_NUM_PARALLEL:1\nOLLAMA_NUM_PARALLEL:4\n`);
check("the most recent slot count wins", parallelSlots(slotLog4) === 4, parallelSlots(slotLog4));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
