// Compare coding harnesses on the same task, on this machine, with this model.
//
//   node bench/run.mjs --harness phi,pi --runs 3 --task tetris
//
// What this is careful about, because a benchmark that is not careful about
// these is worse than no benchmark:
//
//   The suite is ours.       The agent never sees verify.mjs and does not grade
//                            itself. "It said it was done" is not a measurement.
//   Runs are repeated.       One run of a local model is noise. Median and range
//                            are reported, never a single number.
//   Order is alternated.     Ollama's prefix cache and keep-alive make the second
//                            run of anything cheaper. Alternating harnesses
//                            spreads that instead of giving it all to one.
//   Failure is a result.     A run that times out or crashes is recorded with
//                            whatever it produced, not dropped for spoiling the
//                            average.
//
// What it cannot control, and so reports instead: what else the machine was
// doing. Run it on an idle laptop or the timings mean little.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const HARNESSES = arg("harness", "phi,pi").split(",");
/**
 * Thinking levels to sweep.
 *
 * Ollama's reasoning_effort takes none/low/medium/high, so pi's xhigh and max
 * map onto high and would measure the same thing three times under different
 * names. Sweeping these four answers the question worth asking: whether
 * thinking earns the tokens and the minutes it costs, which on a local model at
 * fifteen tokens a second is not obvious in either direction.
 */
const EFFORTS = arg("effort", "").split(",").filter(Boolean);
const RUNS = Number(arg("runs", 3));
const TASK = arg("task", "tetris");
const TIMEOUT_MIN = Number(arg("timeout", 45));
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const TASK_DIR = path.join(ROOT, "bench", "tasks", TASK);
const OUT = path.join(ROOT, "bench", "results.jsonl");

/**
 * How to invoke each harness.
 *
 * phi and pi are the same binary pointed at different agent directories, which
 * is exactly the thing under test: phi is a configuration and a set of
 * extensions, and comparing it against pi means comparing against pi's own
 * defaults rather than against a hobbled version of it.
 */
const HARNESS = {
  phi: { agentDir: path.join(os.homedir(), ".phi"), env: {} },
  pi: { agentDir: path.join(os.homedir(), ".pi"), env: { PI_CODING_AGENT_DIR: path.join(os.homedir(), ".pi") } },
};

/** Tokens and turns, read from the session file the run wrote. */
function readSession(agentDir, cwd, startedAt) {
  const dirName = cwd.replace(/\//g, "-");
  const sessions = path.join(agentDir, "sessions");
  let best;
  try {
    for (const project of fs.readdirSync(sessions)) {
      if (!project.includes(path.basename(cwd))) continue;
      for (const f of fs.readdirSync(path.join(sessions, project))) {
        const p = path.join(sessions, project, f);
        const st = fs.statSync(p);
        if (st.mtimeMs >= startedAt && (!best || st.mtimeMs > best.mtimeMs)) best = { p, mtimeMs: st.mtimeMs };
      }
    }
  } catch {
    /* no sessions directory is a legitimate outcome for a run that died early */
  }
  if (!best) return { input: 0, output: 0, turns: 0, compactions: 0, sessionFile: null };
  let input = 0, output = 0, turns = 0, compactions = 0;
  for (const line of fs.readFileSync(best.p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const u = e?.message?.usage ?? e?.usage;
    if (u) {
      input += Number(u.input ?? u.inputTokens ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0);
      output += Number(u.output ?? u.outputTokens ?? 0);
    }
    if (e?.message?.role === "assistant") turns++;
    if (e?.type === "compaction" || e?.compactionEntry) compactions++;
  }
  return { input, output, turns, compactions, sessionFile: best.p };
}

function runOnce(harness, index, effort) {
  const spec = HARNESS[harness];
  if (!spec) throw new Error(`unknown harness: ${harness}`);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${TASK}-${harness}-`));
  const prompt = fs.readFileSync(path.join(TASK_DIR, "PROMPT.md"), "utf8");
  const startedAt = Date.now();

  const argv = ["--print", prompt, "--approve"];
  // Only passed when sweeping. Without it each harness runs at its own
  // configured default, which is part of what "phi versus pi" means.
  if (effort) argv.push("--thinking", effort);

  const r = spawnSync("pi", argv, {
    cwd,
    encoding: "utf8",
    timeout: TIMEOUT_MIN * 60_000,
    env: { ...process.env, ...spec.env, PI_CODING_AGENT_DIR: spec.agentDir },
  });
  const seconds = Math.round((Date.now() - startedAt) / 1000);

  // Graded from a pristine copy of the suite, run outside the project, so
  // nothing the agent wrote can influence its own score.
  let verdict = { passed: 0, total: 0, results: [] };
  try {
    verdict = JSON.parse(execFileSync(process.execPath, [path.join(TASK_DIR, "verify.mjs"), cwd], { encoding: "utf8" }));
  } catch (e) {
    verdict.error = (e && e.message) || String(e);
  }

  const usage = readSession(spec.agentDir, cwd, startedAt);
  const record = {
    at: new Date().toISOString(),
    task: TASK,
    harness,
    effort: effort ?? "default",
    run: index,
    seconds,
    timedOut: r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM",
    exit: r.status,
    passed: verdict.passed,
    total: verdict.total,
    failures: (verdict.results ?? []).filter((x) => !x.pass).map((x) => x.name),
    ...usage,
    cwd,
  };
  fs.appendFileSync(OUT, `${JSON.stringify(record)}\n`);
  const score = record.total ? `${record.passed}/${record.total}` : "no artifact";
  console.log(
    `  ${harness.padEnd(4)} ${String(record.effort).padEnd(8)} run ${index}: ${score.padEnd(7)} ${record.seconds}s  ` +
      `${record.output} out / ${record.input} in  ${record.turns} turns` +
      `${record.timedOut ? "  TIMED OUT" : ""}`,
  );
  return record;
}

const median = (ns) => {
  if (!ns.length) return 0;
  const s = [...ns].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const arms = EFFORTS.length ? HARNESSES.flatMap((h) => EFFORTS.map((e) => [h, e])) : HARNESSES.map((h) => [h, undefined]);
const totalRuns = arms.length * RUNS;
console.log(
  `${TASK}: ${arms.map(([h, e]) => (e ? `${h}/${e}` : h)).join(" vs ")}, ` +
    `${RUNS} run(s) each = ${totalRuns} runs, ${TIMEOUT_MIN}min cap`,
);
if (totalRuns > 6) {
  console.log(`That is up to ${Math.round((totalRuns * TIMEOUT_MIN) / 60)}h if every run hits the cap.`);
}
console.log();
const all = [];
// Alternate rather than running all of one arm then all of the next, so a warm
// cache or a busy machine does not land entirely on one side.
for (let i = 1; i <= RUNS; i++) for (const [h, e] of arms) all.push(runOnce(h, i, e));

console.log("\narm            passed      time        output tok   turns   tok/check   timeouts");
for (const [h, e] of arms) {
	const rs = all.filter((r) => r.harness === h && (e ? r.effort === e : true));
	if (!rs.length) continue;
	const range = (ns) => (Math.min(...ns) === Math.max(...ns) ? `${median(ns)}` : `${median(ns)} (${Math.min(...ns)}-${Math.max(...ns)})`);
	// Output tokens per check passed. Thinking tokens count as output, so a
	// level that thinks twice as hard for one more check is visible here and
	// nowhere else: the score alone says it won, the token count alone says it
	// lost, and neither is the question being asked.
	const perCheck = rs.map((r) => (r.passed ? Math.round(r.output / r.passed) : 0)).filter(Boolean);
	console.log(
		`${h}${e ? `/${e}` : ""}`.padEnd(15) +
			`${range(rs.map((r) => r.passed))}/${rs[0].total}`.padEnd(12) +
			`${range(rs.map((r) => r.seconds))}s`.padEnd(12) +
			range(rs.map((r) => r.output)).padEnd(13) +
			range(rs.map((r) => r.turns)).padEnd(8) +
			(perCheck.length ? range(perCheck) : "-").padEnd(12) +
			rs.filter((r) => r.timedOut).length,
	);
}
console.log(`\nMedian and range across ${RUNS} run(s). One run is noise; treat a single number as a hint, not a result.`);
if (EFFORTS.length) {
	console.log("tok/check is output tokens per check passed: the column that says whether thinking earned its cost.");
}
console.log(`Raw records: ${OUT}`);
