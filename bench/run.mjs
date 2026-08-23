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
/**
 * How many phases of a multi-phase task to run. 0 means all of them.
 *
 * A full quill run is an hour or more, which makes it useless for any question
 * that needs repetition. Phase 1 alone is about ten minutes, and phase 1 is
 * where the spread is worst: phi scored 7, 7 and pi 12 on the same fourteen
 * checks. Ten cheap samples answer whether that gap is real; one expensive
 * sample of everything does not.
 *
 * Compaction is not exercised at this depth, so a phase-limited batch cannot
 * speak to compaction or regressions. It is a variance instrument, not a
 * replacement for the full task.
 */
const MAX_PHASES = Number(arg("phases", 0));
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
  /**
   * Claude Code, as a ceiling rather than a competitor.
   *
   * phi and pi are the same binary against the same local model, so their
   * numbers are directly comparable. This one is a hosted frontier model with a
   * much larger window, so it will not compact and its score says what the task
   * is worth to a strong model, not whether a harness helps. Read it as the
   * ceiling the local setup is trading away, and keep it out of the phi-vs-pi
   * median.
   *
   * It also costs real money per run, where the others cost electricity. pi's
   * first quill phase alone read 552,238 input tokens.
   */
  claude: {
    cmd: "claude",
    agentDir: path.join(os.homedir(), ".claude"),
    sessionsDir: "projects",
    metered: true,
    env: {},
    args: (prompt, sessionId, effort, isResume) => {
      const a = ["-p", prompt, "--dangerously-skip-permissions"];
      if (sessionId) a.push(isResume ? "--resume" : "--session-id", sessionId);
      if (effort) a.push("--model", effort);
      return a;
    },
  },
};

/** The executable and argv for one phase of a run. */
function invocation(spec, prompt, sessionId, effort, isResume) {
  if (spec.args) return { cmd: spec.cmd, argv: spec.args(prompt, sessionId, effort, isResume) };
  const argv = ["--print", prompt, "--approve"];
  if (sessionId) argv.push(isResume ? "--session" : "--session-id", sessionId);
  if (effort) argv.push("--thinking", effort);
  return { cmd: "pi", argv };
}

/** Tokens and turns, read from the session file the run wrote. */
function readSession(agentDir, cwd, startedAt, sub = "sessions") {
  const dirName = cwd.replace(/\//g, "-");
  const sessions = path.join(agentDir, sub);
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
      // Two schemas: pi writes camelCase, Claude Code writes snake_case, and a
      // run whose tokens all read zero is indistinguishable from a run that
      // produced nothing, which the summary treats as cut short.
      input += Number(u.input ?? u.inputTokens ?? u.input_tokens ?? 0) +
        Number(u.cacheRead ?? u.cache_read_input_tokens ?? 0) +
        Number(u.cacheWrite ?? u.cache_creation_input_tokens ?? 0);
      output += Number(u.output ?? u.outputTokens ?? u.output_tokens ?? 0);
    }
    if (e?.message?.role === "assistant") turns++;
    if (e?.type === "compaction" || e?.compactionEntry || e?.isCompactSummary) compactions++;
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
    if (MAX_PHASES > 0 && phases.length >= MAX_PHASES) break;
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

  // Only passed when sweeping. Without it each harness runs at its own
  // configured default, which is part of what "phi versus pi" means.
  const first = invocation(spec, prompt, sessionId, effort, false);
  const argv = first.argv;

  const r = spawnSync(first.cmd, argv, {
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
  const usage = readSession(spec.agentDir, cwd, startedAt, spec.sessionsDir);

  // Later phases, each graded by its own suite, each re-running the earlier ones
  // as a regression check. They share the first phase's session, which is the
  // point: context accumulates across the phases, and that is the only way a
  // benchmark run gets deep enough to compact.
  const laterPhases = [];
  for (let i = 1; i < phases.length; i++) {
    // What the earlier suite had working BEFORE this phase runs. Without it a
    // check that was never fixed reads as a regression the new work caused: a
    // tree at 12/14 reported 2 regressions before anything had been edited, and
    // every REGRESSED number in the ledger up to now was inflated by whatever
    // the earlier phase had left unfixed.
    try {
      const prior = JSON.parse(execFileSync(process.execPath,
        [path.join(TASK_DIR, `verify${i}.mjs`), cwd], { encoding: "utf8", timeout: 300000 }));
      fs.writeFileSync(path.join(cwd, `.bench-baseline-${i}.json`), JSON.stringify(prior.results));
    } catch {
      /* no baseline is honest: the suite reports unknown rather than a number */
    }
    const snapshot = snapshotOf(cwd);
    const startedPhase = Date.now();
    const later = invocation(spec, fs.readFileSync(phases[i], "utf8"), sessionId, effort, true);
    const argvN = later.argv;
    const rN = spawnSync(later.cmd, argvN, {
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
    const uN = readSession(spec.agentDir, cwd, startedPhase, spec.sessionsDir);
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
     * A run where ANY phase hit the timeout is reported, not discarded.
     *
     * It used to be marked void and dropped from every statistic. That threw
     * away the most interesting run in the batch: pi's first quill run climbed
     * to 61,373 tokens without compacting, got killed at the 40 minute cap, and
     * still scored 12/14 and 22/24 on the phases it had finished. "Void" said
     * only that it was cut off, and hid that the work was good.
     *
     * So the score is kept and the truncation is stated. It stays out of the
     * median, because a truncated run's score is a lower bound and averaging a
     * lower bound with completed runs produces a number that is neither, but it
     * is printed on its own line where it cannot be missed.
     */
    timedOutAnywhere,
    ...(timedOutAnywhere ? { timeoutNote: "a phase hit the wall-clock cap; scores are a lower bound" } : {}),
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
            `${p.regressed === null || p.regressed === undefined ? "regressions unknown" : p.regressed ? `${p.regressed} REGRESSED` : "no regressions"}`)
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
    `${RUNS} run(s) each = ${totalRuns} runs, ${TIMEOUT_MIN}min cap` +
      (MAX_PHASES > 0 ? `, PHASE 1-${MAX_PHASES} ONLY (no compaction, no regression data)` : ""),
);
if (totalRuns > 6) {
  console.log(`That is up to ${Math.round((totalRuns * TIMEOUT_MIN) / 60)}h if every run hits the cap.`);
}
console.log();
const all = [];
// Alternate rather than running all of one arm then all of the next, so a warm
// cache or a busy machine does not land entirely on one side.
for (let i = 1; i <= RUNS; i++) for (const [h, e, c] of arms) all.push(runOnce(h, i, e, c));

/** One line of scores for a run, used where a median would mislead. */
function scoreLine(r) {
	const phases = (r.phases || []).map((p, i) => `phase ${i + 2}: ${p.passed}/${p.total}`).join("  ");
	return `${r.passed}/${r.total}  ${phases}  ${r.seconds}s`.trim();
}

console.log("\narm            passed      time        output tok   turns   tok/check   cut short");
for (const arm of arms) {
	const [h, e, c] = arm;
	const armRuns = all.filter(
		(r) => r.harness === h && (e ? r.effort === e : true) && (c ? r.compactThinking === c : true),
	);
	// Truncated runs stay out of the median and are reported underneath it with
	// their actual scores. A run cut off at the cap tells you the task did not
	// fit in the time, which is worth knowing on its own; averaging its score in
	// would blend a lower bound with completed runs and mean neither.
	// `r.void` is the old field name for the same thing, kept so records written
	// by an earlier build still read correctly out of results.jsonl.
	const wasCut = (r) => r.timedOutAnywhere || r.void || r.output === 0;
	const cut = armRuns.filter(wasCut);
	const rs = armRuns.filter((r) => !wasCut(r) && r.output > 0);
	if (!rs.length) {
		if (cut.length) {
			console.log(`${armName(arm).padEnd(15)}no completed runs; ${cut.length} timed out`);
			for (const r of cut) console.log(`    timed out: ${scoreLine(r)}`);
		}
		continue;
	}
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
			`${cut.length} timed out`,
	);
	for (const r of cut) console.log(`    timed out: ${scoreLine(r)}`);
}
console.log(`\nMedian and range across ${RUNS} run(s). One run is noise; treat a single number as a hint, not a result.`);
if (EFFORTS.length) {
	console.log("tok/check is output tokens per check passed: the column that says whether thinking earned its cost.");
}
console.log(`Raw records: ${OUT}`);
