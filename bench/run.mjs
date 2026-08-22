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
/**
 * Thinking levels for the summarisation call, swept separately.
 *
 * A different question from the agent's own effort. Summarising a transcript is
 * reading something that exists and writing down what mattered, which may need
 * no deliberation at all, and at twenty tokens a second the deliberation is the
 * whole cost: a compaction was measured at 79s of prefill and 380s of
 * generation. What is not obvious is whether a cheaper summary is a worse one,
 * and a worse summary costs the next session more than it saved.
 *
 * phi only. Plain pi has no such setting, so a sweep of it there would run the
 * same configuration under several names.
 */
const COMPACT_EFFORTS = arg("compact-thinking", "").split(",").filter(Boolean);
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

/** Lines added and removed between two states of the project. */
function diffStat(dir, snapshot) {
	let added = 0, removed = 0, files = 0;
	for (const [rel, before] of snapshot) {
		let after = "";
		try { after = fs.readFileSync(path.join(dir, rel), "utf8"); } catch { /* deleted */ }
		if (after === before) continue;
		files++;
		const b = before.split("\n"), a = after.split("\n");
		const common = new Set(b);
		added += a.filter((l) => l.trim() && !common.has(l)).length;
		const now = new Set(a);
		removed += b.filter((l) => l.trim() && !now.has(l)).length;
	}
	// Files that did not exist before are wholly new.
	for (const f of fs.readdirSync(dir)) {
		if (snapshot.has(f) || f.startsWith(".")) continue;
		files++;
		added += fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => l.trim()).length;
	}
	return { added, removed, filesTouched: files };
}

const snapshotOf = (dir) => {
	const m = new Map();
	for (const f of fs.readdirSync(dir)) {
		if (f.startsWith(".")) continue;
		try { m.set(f, fs.readFileSync(path.join(dir, f), "utf8")); } catch { /* directory */ }
	}
	return m;
};

function runOnce(harness, index, effort, compactThinking) {
  const spec = HARNESS[harness];
  if (!spec) throw new Error(`unknown harness: ${harness}`);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${TASK}-${harness}-`));
  // A task can ship a starting repo. Copied fresh per run, so one run cannot
  // leave the next a half-fixed codebase.
  const seed = path.join(TASK_DIR, "repo");
  if (fs.existsSync(seed)) fs.cpSync(seed, cwd, { recursive: true });
  // A two-phase task builds, then extends in a fresh session that has no memory
  // of building it. The second prompt is never present during the first: a task
  // that reveals what is coming measures whether the model can follow a hint,
  // not whether it leaves seams by default.
  const twoPhase = fs.existsSync(path.join(TASK_DIR, "PHASE1.md"));
  const prompt = fs.readFileSync(path.join(TASK_DIR, twoPhase ? "PHASE1.md" : "PROMPT.md"), "utf8");
  const startedAt = Date.now();

  const argv = ["--print", prompt, "--approve"];
  // Only passed when sweeping. Without it each harness runs at its own
  // configured default, which is part of what "phi versus pi" means.
  if (effort) argv.push("--thinking", effort);

  const r = spawnSync("pi", argv, {
    cwd,
    encoding: "utf8",
    timeout: TIMEOUT_MIN * 60_000,
    env: {
      ...process.env,
      ...spec.env,
      PI_CODING_AGENT_DIR: spec.agentDir,
      ...(compactThinking ? { PI_COMPACT_THINKING: compactThinking } : {}),
    },
  });
  const seconds = Math.round((Date.now() - startedAt) / 1000);

  // Graded from a pristine copy of the suite, run outside the project, so
  // nothing the agent wrote can influence its own score.
  const grade = (suite) => {
    try {
      return JSON.parse(execFileSync(process.execPath, [path.join(TASK_DIR, suite), cwd], { encoding: "utf8" }));
    } catch (e) {
      return { passed: 0, total: 0, results: [], error: (e && e.message) || String(e) };
    }
  };
  let verdict = grade(twoPhase ? "verify1.mjs" : "verify.mjs");
  const usage = readSession(spec.agentDir, cwd, startedAt);

  let phase2;
  if (twoPhase) {
    const snapshot = snapshotOf(cwd);
    const startedAt2 = Date.now();
    const argv2 = ["--print", fs.readFileSync(path.join(TASK_DIR, "PHASE2.md"), "utf8"), "--approve"];
    if (effort) argv2.push("--thinking", effort);
    const r2 = spawnSync("pi", argv2, {
      cwd,
      encoding: "utf8",
      timeout: TIMEOUT_MIN * 60_000,
      env: {
        ...process.env,
        ...spec.env,
        PI_CODING_AGENT_DIR: spec.agentDir,
        ...(compactThinking ? { PI_COMPACT_THINKING: compactThinking } : {}),
      },
    });
    const v2 = grade("verify2.mjs");
    const u2 = readSession(spec.agentDir, cwd, startedAt2);
    phase2 = {
      seconds: Math.round((Date.now() - startedAt2) / 1000),
      timedOut: r2.error?.code === "ETIMEDOUT" || r2.signal === "SIGTERM",
      passed: v2.passed,
      total: v2.total,
      // The half that matters: adding a format is easy, not breaking the one
      // already there is what separates a design with seams from one without.
      regressed: v2.regressed ?? 0,
      ...diffStat(cwd, snapshot),
      output: u2.output,
      turns: u2.turns,
    };
  }
  const record = {
    at: new Date().toISOString(),
    task: TASK,
    harness,
    effort: effort ?? "default",
    compactThinking: compactThinking ?? "default",
    run: index,
    seconds,
    timedOut: r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM",
    exit: r.status,
    passed: verdict.passed,
    total: verdict.total,
    failures: (verdict.results ?? []).filter((x) => !x.pass).map((x) => x.name),
    ...usage,
    ...(phase2 ? { phase2 } : {}),
    cwd,
  };
  fs.appendFileSync(OUT, `${JSON.stringify(record)}\n`);
  const score = record.total ? `${record.passed}/${record.total}` : "no artifact";
  console.log(
    `  ${harness.padEnd(4)} ${String(record.effort).padEnd(8)} run ${index}: ${score.padEnd(7)} ${record.seconds}s  ` +
      `${record.output} out / ${record.input} in  ${record.turns} turns` +
      `${record.timedOut ? "  TIMED OUT" : ""}` +
      (phase2
        ? `\n       phase 2: ${phase2.passed}/${phase2.total}  ${phase2.seconds}s  ` +
          `+${phase2.added}/-${phase2.removed} in ${phase2.filesTouched} file(s)  ` +
          `${phase2.regressed ? `${phase2.regressed} REGRESSED` : "no regressions"}`
        : ""),
  );
  return record;
}

const median = (ns) => {
  if (!ns.length) return 0;
  const s = [...ns].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const efforts = EFFORTS.length ? EFFORTS : [undefined];
const compactEfforts = COMPACT_EFFORTS.length ? COMPACT_EFFORTS : [undefined];
const arms = HARNESSES.flatMap((h) =>
  efforts.flatMap((e) =>
    compactEfforts
      // Only phi reads PI_COMPACT_THINKING. Sweeping it on pi would run one
      // configuration under several names and report the spread as a finding.
      .filter((c) => !c || h === "phi")
      .map((c) => [h, e, c]),
  ),
);
const armName = ([h, e, c]) => `${h}${e ? `/${e}` : ""}${c ? `/c:${c}` : ""}`;
const totalRuns = arms.length * RUNS;
console.log(
  `${TASK}: ${arms.map(armName).join(" vs ")}, ` +
    `${RUNS} run(s) each = ${totalRuns} runs, ${TIMEOUT_MIN}min cap`,
);
if (totalRuns > 6) {
  console.log(`That is up to ${Math.round((totalRuns * TIMEOUT_MIN) / 60)}h if every run hits the cap.`);
}
console.log();
const all = [];
// Alternate rather than running all of one arm then all of the next, so a warm
// cache or a busy machine does not land entirely on one side.
for (let i = 1; i <= RUNS; i++) for (const [h, e, c] of arms) all.push(runOnce(h, i, e, c));

console.log("\narm            passed      time        output tok   turns   tok/check   timeouts");
for (const arm of arms) {
	const [h, e, c] = arm;
	const rs = all.filter(
		(r) => r.harness === h && (e ? r.effort === e : true) && (c ? r.compactThinking === c : true),
	);
	if (!rs.length) continue;
	const range = (ns) => (Math.min(...ns) === Math.max(...ns) ? `${median(ns)}` : `${median(ns)} (${Math.min(...ns)}-${Math.max(...ns)})`);
	// Output tokens per check passed. Thinking tokens count as output, so a
	// level that thinks twice as hard for one more check is visible here and
	// nowhere else: the score alone says it won, the token count alone says it
	// lost, and neither is the question being asked.
	const perCheck = rs.map((r) => (r.passed ? Math.round(r.output / r.passed) : 0)).filter(Boolean);
	console.log(
		armName(arm).padEnd(15) +
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
