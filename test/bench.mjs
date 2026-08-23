// The benchmark grades the harnesses, so something has to grade the benchmark.
// A suite nobody has ever passed may simply be unpassable, and a suite that
// passes an empty directory measures nothing at all.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

const bench = new URL("../bench/", import.meta.url).pathname;
const verify = (dir) => JSON.parse(execFileSync(process.execPath, [path.join(bench, "tasks/tetris/verify.mjs"), dir], { encoding: "utf8" }));

// --- the suite must be failable ---------------------------------------------
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "bench-empty-"));
const none = verify(empty);
check("an empty directory scores nothing", none.passed === 0, `${none.passed}/${none.total}`);
check("and says why rather than crashing", /ENOENT|no such file/.test(JSON.stringify(none.results)));

fs.writeFileSync(path.join(empty, "tetris.js"), "globalThis.TETRIS = { Game: function () {} };");
const stub = verify(empty);
check("a stub that loads but does nothing scores near zero",
  stub.passed <= 2 && stub.total > 10,
  `${stub.passed}/${stub.total}`);
check("a broken file does not take the runner down with it", (() => {
  fs.writeFileSync(path.join(empty, "tetris.js"), "this is not javascript {{{");
  return verify(empty).passed === 0;
})());
check("an infinite loop cannot hang the grader", (() => {
  fs.writeFileSync(path.join(empty, "tetris.js"), "while (true) {}");
  const t = Date.now();
  const r = verify(empty);
  return r.passed === 0 && Date.now() - t < 20_000;
})(), "the sandbox has a timeout, or one bad run stalls the whole benchmark");
fs.rmSync(empty, { recursive: true, force: true });

// --- and it must be passable ------------------------------------------------
// Against a reference implementation written to the contract in PROMPT.md. If
// this ever fails, the suite has drifted from the task and every score it has
// produced is suspect.
const ref = new URL("../bench/tasks/tetris/reference.js", import.meta.url).pathname;
if (fs.existsSync(ref)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-ref-"));
  fs.copyFileSync(ref, path.join(dir, "tetris.js"));
  const got = verify(dir);
  check("a correct implementation passes every check", got.passed === got.total,
    got.results.filter((r) => !r.pass).map((r) => `${r.name}: ${r.detail}`).join("; ") || `${got.passed}/${got.total}`);
  fs.rmSync(dir, { recursive: true, force: true });
} else {
  check("a reference implementation is kept to prove the suite passable", false, `missing ${ref}`);
}

// --- the prompt and the suite have to describe the same thing ---------------
const prompt = fs.readFileSync(path.join(bench, "tasks/tetris/PROMPT.md"), "utf8");
for (const method of ["spawn", "move", "rotate", "step", "drop", "snapshot"]) {
  check(`the prompt specifies ${method}()`, prompt.includes(`\`${method}(`) || prompt.includes(`${method}(`));
}
check("the prompt does not ask for tests", !/write .*tests|add tests/i.test(prompt),
  "an agent that writes its own tests grades its own homework");
check("the runner exists and parses", fs.existsSync(path.join(bench, "run.mjs")));

// The effort sweep. Four levels, because Ollama's reasoning_effort takes
// none/low/medium/high and pi's xhigh and max map onto high: sweeping all seven
// would measure the same thing three times under different names.
const runner = fs.readFileSync(path.join(bench, "run.mjs"), "utf8");
check("thinking level is a sweepable dimension", /--thinking/.test(runner) && /EFFORTS/.test(runner));
check("no effort means each harness uses its own default",
  /EFFORTS\.length \?/.test(runner),
  "that is what comparing phi against pi means, settings included");
check("the summary reports tokens per check passed", /tok\/check/.test(runner),
  "score alone says thinking won, tokens alone say it lost, and neither is the question");
check("the run cost is stated before it starts", /if \(totalRuns > 6\)/.test(runner),
  "24 runs at 45 minutes is not something to discover halfway through");
check("each record carries its effort level", /effort: effort \?\? "default"/.test(runner));

// The compaction thinking level is its own dimension. Summarising a transcript
// may need no deliberation at all, and at twenty tokens a second deliberation
// is the whole cost. What is not obvious is whether a cheaper summary is a
// worse one, and a worse summary costs the next session more than it saved.
check("compaction thinking is sweepable", /COMPACT_EFFORTS/.test(runner) && /PI_COMPACT_THINKING/.test(runner));
check("it is swept on phi only",
  /h === "phi"/.test(runner),
  "plain pi has no such setting, so a sweep there is one config under several names");
check("it reaches both phases of a two-phase task",
  (runner.match(/PI_COMPACT_THINKING: compactThinking/g) ?? []).length === 2,
  "phase two compacts too, and an unset second phase would mix configurations");
check("each record carries it", /compactThinking: compactThinking \?\? "default"/.test(runner));

// --- the two-phase architecture task ---------------------------------------
// Build, then extend in a fresh session, and see what the extension cost.
const exporter = path.join(bench, "tasks/exporter");
const grade = (suite, dir) => JSON.parse(execFileSync(process.execPath, [path.join(exporter, suite), dir], { encoding: "utf8" }));
const stage = (src) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bench-exp-"));
  fs.copyFileSync(src, path.join(d, "exporter.js"));
  return d;
};

check("the phase-two prompt is a separate file",
  fs.existsSync(path.join(exporter, "PHASE1.md")) && fs.existsSync(path.join(exporter, "PHASE2.md")),
  "a task that reveals what is coming measures hint-following, not design");
check("phase one's prompt does not mention the second format",
  !/jsonl|json lines/i.test(fs.readFileSync(path.join(exporter, "PHASE1.md"), "utf8")),
  "anticipating it is exactly what must not be rewarded");

// Both references must pass phase one, or the task is not the discriminator,
// the suite is.
for (const kind of ["seams", "tangle"]) {
  const d = stage(path.join(exporter, "reference", kind, "v1.js"));
  const r = grade("verify1.mjs", d);
  check(`the ${kind} reference passes phase one`, r.passed === r.total,
    r.results.filter((x) => !x.pass).map((x) => x.name).join("; ") || `${r.passed}/${r.total}`);
  fs.rmSync(d, { recursive: true, force: true });
}

// And phase two must re-run phase one's suite, which is the half that matters.
{
  const d = stage(path.join(exporter, "reference", "seams", "v2.js"));
  const r = grade("verify2.mjs", d);
  check("phase two grades the new format and the old one together",
    r.total > 20 && r.results.some((x) => x.name.startsWith("csv still:")),
    `${r.passed}/${r.total}`);
  check("a clean extension reports no regressions", r.regressed === 0);
  fs.rmSync(d, { recursive: true, force: true });
}
{
  // A v2 that broke CSV must be caught, since that is the whole measurement.
  const d = stage(path.join(exporter, "reference", "seams", "v2.js"));
  fs.writeFileSync(path.join(d, "exporter.js"),
    fs.readFileSync(path.join(d, "exporter.js"), "utf8").replace('lines.push(options.columns.join(","))', "void 0"));
  const r = grade("verify2.mjs", d);
  check("breaking the old format is reported as a regression", r.regressed > 0, `regressed ${r.regressed}`);
  fs.rmSync(d, { recursive: true, force: true });
}

// The honest caveat, kept as an assertion so it cannot quietly stop being true.
check("the runner records the phase-two diff", /diffStat/.test(fs.readFileSync(path.join(bench, "run.mjs"), "utf8")));
check("and the README says diff size did not discriminate at this size",
  /did not discriminate|too small/.test(fs.readFileSync(path.join(bench, "README.md"), "utf8")),
  "a metric that failed its own validation must not be quietly presented as one that works");

// --- the seeded bug-hunt task ----------------------------------------------
// Sized to force compaction, which is most of what separates phi from pi. The
// exporter task never reaches the trigger, so comparing harnesses on it would
// mostly measure the model.
const ledger = path.join(bench, "tasks/ledger");
const gradeLedger = (dir) => JSON.parse(execFileSync(process.execPath, [path.join(ledger, "verify.mjs"), dir], { encoding: "utf8" }));

check("the seeded repo's visible suite passes as shipped", (() => {
  try {
    execFileSync(process.execPath, ["test/run.js"], { cwd: path.join(ledger, "repo"), encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
})(), "a failing test tells you where to look, and the looking is the task");

const seeded = gradeLedger(path.join(ledger, "repo"));
check("and the hidden suite finds defects it does not", seeded.passed < seeded.total,
  `${seeded.passed}/${seeded.total}`);
check("the defects span several files", (() => {
  const failing = seeded.results.filter((r) => !r.pass).map((r) => r.name).join(" ");
  return ["allocate", "tier", "quote", "refund", "group"].filter((k) => failing.includes(k)).length >= 4;
})(), "one file would be a puzzle, not a codebase");

const fixed = gradeLedger(path.join(ledger, "reference"));
check("the reference passes every check", fixed.passed === fixed.total,
  fixed.results.filter((r) => !r.pass).map((r) => `${r.name}: ${r.detail}`).join("; ") || `${fixed.passed}/${fixed.total}`);

check("editing the tests is caught", (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bench-ledger-"));
  fs.cpSync(path.join(ledger, "reference"), d, { recursive: true });
  fs.appendFileSync(path.join(d, "test/run.js"), "\n// touched\n");
  const r = gradeLedger(d);
  fs.rmSync(d, { recursive: true, force: true });
  return r.results.some((x) => !x.pass && /not modified/.test(x.name));
})(), "editing the tests into agreement is the obvious way to score without fixing");

check("the runner copies a task's seed repo", /fs.cpSync\(seed, cwd/.test(fs.readFileSync(path.join(bench, "run.mjs"), "utf8")),
  "one run must not hand the next a half-fixed codebase");

// --- quill: one session, three phases, four languages ----------------------
// Every earlier task finished without compacting once, which made them useless
// for comparing harnesses: compaction is most of what separates phi from pi.
// This one runs its phases in a single session so context accumulates.
const quill = path.join(bench, "tasks/quill");
const gradeQuill = (n, dir) =>
  JSON.parse(execFileSync(process.execPath, [path.join(quill, `verify${n}.mjs`), dir],
    { encoding: "utf8", timeout: 300000, stdio: ["ignore", "pipe", "ignore"] }));

check("quill has three phases", [1, 2, 3].every((n) => fs.existsSync(path.join(quill, `PHASE${n}.md`))));
check("and a suite for each", [1, 2, 3].every((n) => fs.existsSync(path.join(quill, `verify${n}.mjs`))));
check("its phases share one session", (() => {
  const meta = JSON.parse(fs.readFileSync(path.join(quill, "task.json"), "utf8"));
  return meta.sameSession === true;
})(), "context has to accumulate, or nothing ever compacts");
check("the exporter keeps its fresh-session design",
  JSON.parse(fs.readFileSync(path.join(bench, "tasks/exporter/task.json"), "utf8")).sameSession === false,
  "it measures whether a design survives being handed to a stranger");

// Four languages, and a codebase big enough that reading it costs something.
const counts = {};
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else counts[path.extname(e.name)] = (counts[path.extname(e.name)] ?? 0) + 1;
  }
};
walk(path.join(quill, "repo"));
check("the codebase spans php, ts, html, css and sql",
  [".php", ".ts", ".html", ".css", ".sql"].every((e) => (counts[e] ?? 0) > 0),
  JSON.stringify(counts));
check("it is large enough to be worth reading",
  Object.values(counts).reduce((a, b) => a + b, 0) >= 70,
  `${Object.values(counts).reduce((a, b) => a + b, 0)} files`);

// The visible suites pass as shipped; the hidden ones do not.
check("both visible suites pass on the seeded repo", (() => {
  const dir = path.join(quill, "repo");
  try {
    execFileSync("php", ["test/run.php"], { cwd: dir, stdio: "ignore" });
    execFileSync(process.execPath, ["--experimental-strip-types", "test/run.ts"], { cwd: dir, stdio: "ignore" });
    return true;
  } catch { return false; }
})(), "a failing test says where to look, and looking is the task");

const seeded1 = gradeQuill(1, path.join(quill, "repo"));
check("the hidden suite finds what the visible ones miss", seeded1.passed < seeded1.total, `${seeded1.passed}/${seeded1.total}`);
check("the defects span php and typescript", (() => {
  const failing = seeded1.results.filter((r) => !r.pass).map((r) => r.name).join(" ");
  return /listing|page|offset/.test(failing) && /newestFirst/.test(failing);
})());

// And the reference passes all three, which is what proves them passable.
for (const n of [1, 2, 3]) {
  const r = gradeQuill(n, path.join(quill, "reference"));
  check(`the reference passes phase ${n}`, r.passed === r.total,
    r.results.filter((x) => !x.pass).map((x) => `${x.name}: ${x.detail}`).join("; ") || `${r.passed}/${r.total}`);
  // Without a baseline there is nothing to compare against, and the honest
  // answer is null. It used to return 0 here, which looked like proof of no
  // regressions and was really just "total minus passed" on a perfect tree.
  if (n > 1) check(`phase ${n} reports regressions as unknown with no baseline`,
    r.regressed === null, String(r.regressed));
}

// --- a timed-out run is reported, not discarded ---------------------------
// Phases are separate processes, so a timed-out phase does not stop the next
// one: it runs against a half-finished repo. Its score is a lower bound, so it
// stays out of the median, but discarding it threw away the most interesting
// run in a batch: pi's first quill run was cut off at the cap and had still
// scored 12/14 and 22/24 on the phases it finished.
{
  const src = fs.readFileSync(path.join(bench, "run.mjs"), "utf8");
  check("a timeout in any phase is detected",
    /timedOutAnywhere = firstTimedOut \|\| laterPhases\.some\(\(p\) => p\.timedOut\)/.test(src));
  check("the record says so explicitly, and says the score is a lower bound",
    /\btimedOutAnywhere,/.test(src) && /timeoutNote/.test(src) && /lower bound/.test(src));
  check("truncated runs stay out of the median",
    /const rs = armRuns\.filter\(\(r\) => !wasCut\(r\) && r\.output > 0\)/.test(src),
    "a lower bound averaged with completed runs is neither");
  check("but their scores are printed, not just their count",
    /timed out: \$\{scoreLine\(r\)\}/.test(src),
    "a count alone hides whether the work was any good");
  check("scoreLine reports every phase, not just the first",
    /r\.phases \|\| \[\]\)\.map\(\(p, i\) =>/.test(src));
  check("an arm with nothing but truncated runs still reports",
    /no completed runs; \$\{cut\.length\} timed out/.test(src),
    "silently omitting the arm would read as if it was never run");
  check("records written by the older build still read correctly",
    /r\.timedOutAnywhere \|\| r\.void/.test(src),
    "results.jsonl already holds records using the previous field name");
}


// --- with a baseline, a regression is detected and a non-regression is not ---
// The counting bug: every failing earlier check was reported as a regression,
// so a defect that was never fixed read as damage this phase caused. A tree at
// 12/14 reported 2 regressions before anything had been edited.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phi-regress-"));
  fs.cpSync(path.join(quill, "reference"), tmp, { recursive: true });

  const base = gradeQuill(1, tmp);
  fs.writeFileSync(path.join(tmp, ".bench-baseline-1.json"), JSON.stringify(base.results));
  check("a clean tree with a baseline reports zero regressions",
    gradeQuill(2, tmp).regressed === 0, String(gradeQuill(2, tmp).regressed));

  // Now claim the baseline had something passing that is failing now.
  const faked = base.results.map((r) => ({ ...r, pass: true }));
  fs.writeFileSync(path.join(tmp, ".bench-baseline-1.json"), JSON.stringify(faked));
  const broken = path.join(tmp, "src/Query/Paginator.php");
  fs.writeFileSync(broken, fs.readFileSync(broken, "utf8").replace("($this->page - 1)", "$this->page"));
  const after = gradeQuill(2, tmp);
  check("breaking earlier work is counted as a regression", after.regressed > 0, String(after.regressed));
  check("and it counts only what actually stopped passing",
    after.regressed <= base.total, `${after.regressed} of ${base.total}`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- the diff walker has to survive a real directory tree ------------------
// It read the top level only and called readFileSync on whatever it found, so
// the first nested codebase killed the run with EISDIR, halfway through an
// overnight batch, at the phase boundary.
{
  const src = fs.readFileSync(path.join(bench, "run.mjs"), "utf8");
  const snapshotOf = new Function("fs", "path",
    "return " + src.match(/const snapshotOf = \(dir\) => \{[\s\S]*?\n\};/)[0].replace("const snapshotOf = ", ""))(fs, path);
  const diffStat = new Function("fs", "path", "snapshotOf",
    src.match(/function diffStat\(dir, snapshot\) \{[\s\S]*?\n\}/)[0] + "; return diffStat;")(fs, path, snapshotOf);

  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bench-walk-"));
  fs.mkdirSync(path.join(d, "src/Deep/Deeper"), { recursive: true });
  fs.mkdirSync(path.join(d, ".phi"), { recursive: true });
  fs.writeFileSync(path.join(d, "top.txt"), "one\n");
  fs.writeFileSync(path.join(d, "src/Deep/Deeper/x.php"), "a\nb\n");
  fs.writeFileSync(path.join(d, ".phi/NOTES.md"), "agent state\n");

  const before = snapshotOf(d);
  check("the snapshot reaches nested files", before.has("src/Deep/Deeper/x.php"));
  check("and does not choke on directories", before.has("top.txt"),
    "a flat readdir plus readFileSync throws EISDIR on the first subdirectory");
  check("agent state is not counted as the work", !before.has(".phi/NOTES.md"));

  fs.writeFileSync(path.join(d, "src/Deep/Deeper/x.php"), "a\nb\nc\n");
  fs.writeFileSync(path.join(d, "src/Deep/new.ts"), "n1\nn2\n");
  const stat = diffStat(d, before);
  check("an edit deep in the tree is counted", stat.added >= 1 && stat.filesTouched >= 2, JSON.stringify(stat));
  check("a wholly new nested file counts as added", stat.added >= 3, JSON.stringify(stat));
  check("an unchanged tree reports nothing", (() => {
    const s2 = diffStat(d, snapshotOf(d));
    return s2.added === 0 && s2.removed === 0 && s2.filesTouched === 0;
  })());
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
