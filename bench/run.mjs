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
import { randomUUID } from "node:crypto";
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

/**
 * Every file in the project, keyed by its path relative to the root.
 *
 * Recursive, because a real codebase has directories. A flat listing worked for
 * the one-file exporter task and crashed on the first nested one with EISDIR,
 * halfway through a batch, which is a cheap bug to have written and an
 * expensive one to have shipped into an overnight run.
 */
const snapshotOf = (dir) => {
	const out = new Map();
	const walk = (abs, rel) => {
		let entries = [];
		try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			// Skip agent state and version control: neither is the work.
			if (e.name.startsWith(".") || e.name === "node_modules") continue;
			const child = path.join(abs, e.name);
			const key = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(child, key);
			else {
				try { out.set(key, fs.readFileSync(child, "utf8")); } catch { /* binary or unreadable */ }
			}
		}
	};
	walk(dir, "");
	return out;
};

/** Lines added and removed between two states of the project. */
function diffStat(dir, snapshot) {
	const now = snapshotOf(dir);
	let added = 0, removed = 0, files = 0;

	for (const [rel, before] of snapshot) {
		const after = now.get(rel) ?? "";
		if (after === before) continue;
		files++;
		const b = before.split("\n"), a = after.split("\n");
		const wasThere = new Set(b);
		added += a.filter((l) => l.trim() && !wasThere.has(l)).length;
		const stillThere = new Set(a);
		removed += b.filter((l) => l.trim() && !stillThere.has(l)).length;
	}

	// Files that did not exist before are wholly new. Counted separately rather
	// than diffed, since there is nothing to diff against.
	for (const [rel, text] of now) {
		if (snapshot.has(rel)) continue;
		files++;
		added += text.split("\n").filter((l) => l.trim()).length;
	}

	return { added, removed, filesTouched: files };
}

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
  // Phases, in order. A task with PHASE1..N runs them as sequential prompts.
  const phases = [];
  for (let n = 1; n <= 9; n++) {
    const f = path.join(TASK_DIR, `PHASE${n}.md`);
    if (fs.existsSync(f)) phases.push(f);
  }
  const multi = phases.length > 0;
  const prompt = fs.readFileSync(multi ? phases[0] : path.join(TASK_DIR, "PROMPT.md"), "utf8");

  /**
   * Whether later phases share the first phase's session.
   *
   * `sameSession` is the point of a multi-phase task: context accumulates across
   * the phases, which is the only way a benchmark run ever gets deep enough to
   * compact. A task that wants each phase to start clean, to measure whether the
   * design survives being handed to someone with no memory of building it, opts
   * out with SAME_SESSION=false in its meta.
   */
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(TASK_DIR, "task.json"), "utf8")); } catch { /* defaults */ }
  const sameSession = meta.sameSession !== false;
  const sessionId = sameSession ? randomUUID() : undefined;
  const startedAt = Date.now();

  const argv = ["--print", prompt, "--approve"];
  if (sessionId) argv.push("--session-id", sessionId);
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
  let verdict = grade(multi ? "verify1.mjs" : "verify.mjs");
  const usage = readSession(spec.agentDir, cwd, startedAt);

  // Later phases, each graded by its own suite, each re-running the earlier ones
  // as a regression check. They share the first phase's session, which is the
  // point: context accumulates across the phases, and that is the only way a
  // benchmark run gets deep enough to compact.
  const laterPhases = [];
  for (let i = 1; i < phases.length; i++) {
    const snapshot = snapshotOf(cwd);
    const startedPhase = Date.now();
    const argvN = ["--print", fs.readFileSync(phases[i], "utf8"), "--approve"];
    if (sessionId) argvN.push("--session", sessionId);
    if (effort) argvN.push("--thinking", effort);
    const rN = spawnSync("pi", argvN, {
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
    const vN = grade(`verify${i + 1}.mjs`);
    const uN = readSession(spec.agentDir, cwd, startedPhase);
    laterPhases.push({
      phase: i + 1,
      seconds: Math.round((Date.now() - startedPhase) / 1000),
      timedOut: rN.error?.code === "ETIMEDOUT" || rN.signal === "SIGTERM",
      passed: vN.passed,
      total: vN.total,
      regressed: vN.regressed ?? 0,
      ...diffStat(cwd, snapshot),
      output: uN.output,
      turns: uN.turns,
      compactions: uN.compactions,
    });
  }

  const firstTimedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
  const timedOutAnywhere = firstTimedOut || laterPhases.some((p) => p.timedOut);

  const record = {
    at: new Date().toISOString(),
    task: TASK,
    harness,
    effort: effort ?? "default",
    compactThinking: compactThinking ?? "default",
    run: index,
    seconds,
    timedOut: firstTimedOut,
    exit: r.status,
    passed: verdict.passed,
    total: verdict.total,
    failures: (verdict.results ?? []).filter((x) => !x.pass).map((x) => x.name),
    ...usage,
    ...(laterPhases.length ? { phases: laterPhases } : {}),
    /**
     * A run where ANY phase hit the timeout is void, not a low score.
     *
     * The phases are separate processes, so a timed-out phase does not stop the
     * next one: it runs against a half-finished repo and produces numbers that
     * look valid. Averaging those in reads as "the harness scored badly" when
     * what happened is that it was cut off. Marked here rather than left to
     * whoever reads the file, because the one void record in the last batch had
     * to be spotted by hand.
     */
    void: timedOutAnywhere,
    ...(timedOutAnywhere ? { voidReason: "a phase hit the timeout" } : {}),
    cwd,
  };
  fs.appendFileSync(OUT, `${JSON.stringify(record)}\n`);
  const score = record.total ? `${record.passed}/${record.total}` : "no artifact";
  console.log(
    `  ${harness.padEnd(4)} ${String(record.effort).padEnd(8)} run ${index}: ${score.padEnd(7)} ${record.seconds}s  ` +
      `${record.output} out / ${record.input} in  ${record.turns} turns` +
      `${record.timedOut ? "  TIMED OUT" : ""}` +
      laterPhases
        .map((p) =>
          `\n       phase ${p.phase}: ${p.passed}/${p.total}  ${p.seconds}s  ` +
            `+${p.added}/-${p.removed} in ${p.filesTouched} file(s)  ${p.compactions} compaction(s)  ` +
            `${p.regressed ? `${p.regressed} REGRESSED` : "no regressions"}`)
        .join(""),
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

console.log("\narm            passed      time        output tok   turns   tok/check   void");
for (const arm of arms) {
	const [h, e, c] = arm;
	const armRuns = all.filter(
		(r) => r.harness === h && (e ? r.effort === e : true) && (c ? r.compactThinking === c : true),
	);
	// Void runs are excluded from every statistic and counted separately. A
	// timed-out run tells you the task did not fit, which is worth knowing, and
	// averaging its score in would tell you something false instead.
	const voided = armRuns.filter((r) => r.void || r.output === 0);
	const rs = armRuns.filter((r) => !r.void && r.output > 0);
	if (!rs.length) { if (voided.length) console.log(`${armName(arm).padEnd(15)}all ${voided.length} run(s) void`); continue; }
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
			`${voided.length} void`,
	);
}
console.log(`\nMedian and range across ${RUNS} run(s). One run is noise; treat a single number as a hint, not a result.`);
if (EFFORTS.length) {
	console.log("tok/check is output tokens per check passed: the column that says whether thinking earned its cost.");
}
console.log(`Raw records: ${OUT}`);
