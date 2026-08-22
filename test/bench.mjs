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

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
