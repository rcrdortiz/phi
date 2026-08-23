import mod, { budgetChars, charsPerToken, truncate, shrinkImage, looksLikeFileDump, looksLikeBulkRead } from "../extensions/tool-budget.ts";
import { alreadyInContext } from "../lib/read-lean.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

// --- budget sizing -------------------------------------------------------
check("budget scales with the window", budgetChars(32768) < budgetChars(131072),
  `32K -> ${budgetChars(32768)}, 128K -> ${budgetChars(131072)}`);
check("budget has a floor for tiny windows", budgetChars(1000) >= 4000, String(budgetChars(1000)));
// The budget is a token share expressed in characters, so the conversion has
// to match what the tool actually returns. Measured against the model's own
// tokenizer: source and markdown ~3.4 chars/token, but command output and JSON
// ~2.0. A single 3.6 sized a bash result as though it cost 45% of what it
// really cost, which is exactly what this extension exists to prevent.
check("a source-shaped result converts at ~3.4 chars per token",
  Math.abs(budgetChars(32768, "view_lines") - Math.round(32768 * 0.1 * 3.4)) < 50,
  String(budgetChars(32768, "view_lines")));
check("shell output is budgeted denser than source",
  budgetChars(32768, "bash") / (32768 * 0.04) < budgetChars(32768, "view_lines") / (32768 * 0.1),
  `bash ${charsPerToken("bash")} vs source ${charsPerToken("view_lines")} chars/token`);
check("ls, grep and find count as shell output too",
  ["ls", "grep", "find"].every((t) => charsPerToken(t) === charsPerToken("bash")),
  "a directory listing tokenises like a log, not like prose");
check("an unknown tool gets the source figure, not the dense one",
  charsPerToken("some_new_tool") === charsPerToken("view_lines"));

// --- truncation ----------------------------------------------------------
const small = "line one\nline two\n";
check("short results pass through untouched", truncate(small, 5000, "read") === small);

// The real failure: 35,716 chars from a call that asked for 3,466.
const big = Array.from({ length: 1200 }, (_, i) => `line ${i} ${"x".repeat(25)}`).join("\n");
const cut = truncate(big, budgetChars(32768), "view_lines");
check("oversized results are cut to budget", cut.length <= budgetChars(32768),
  `${big.length} -> ${cut.length} (limit ${budgetChars(32768)})`);
check("keeps the head", cut.startsWith("line 0 "));
check("keeps the tail", cut.trimEnd().endsWith("x".repeat(25)));
check("says how much was dropped", /removed from the middle/.test(cut) && /view_lines/.test(cut));
check("says it is not the end of the data", /not the end of the data/.test(cut));
check("does not leave a half line at the cut", !/\nline \d+ x{1,24}\.\.\./.test(cut));

// Degenerate: budget smaller than the marker itself.
const tiny = truncate(big, 50, "read");
check("a budget below the marker keeps the marker", /tool-budget/.test(tiny), `${tiny.length} chars`);

// --- images --------------------------------------------------------------
const fs = await import("node:fs");
const shot = new URL("fixtures/large.png", import.meta.url);   // 512x512
const b64 = fs.readFileSync(shot).toString("base64");
const shrunkBig = shrinkImage(b64, "image/png", 256);
check("downscales an image past the cap", shrunkBig !== null && shrunkBig.length < b64.length,
  shrunkBig ? `${b64.length} -> ${shrunkBig.length} base64 chars` : "returned null");
check("leaves an already-small image alone", shrinkImage(b64, "image/png", 2048) === null);
check("bad image data fails soft, not loud", shrinkImage("not-an-image", "image/png", 256) === null);

// --- wiring --------------------------------------------------------------
const handlers = {}, cmds = [], notes = [];
mod({
  on: (e, h) => (handlers[e] = h),
  registerCommand: (n, o) => { cmds.push(n); handlers["/" + n] = o.handler; },
  registerTool: () => {},
});
check("hooks tool_result", typeof handlers["tool_result"] === "function");
check("registers /budget", cmds.includes("budget"));

const ctx = {
  ui: { notify: (t) => notes.push(t) },
  getContextUsage: () => ({ tokens: 5000, contextWindow: 32768 }),
};

const passed = await handlers["tool_result"]({ toolName: "read", content: [{ type: "text", text: small }] }, ctx);
check("a small result is returned unmodified", passed === undefined);

const trimmedRes = await handlers["tool_result"]({ toolName: "view_lines", content: [{ type: "text", text: big }] }, ctx);
check("a large result comes back trimmed", trimmedRes?.content?.[0]?.text.length <= budgetChars(32768),
  `${big.length} -> ${trimmedRes?.content?.[0]?.text.length}`);
check("the trim is announced", notes.some((n) => /tool-budget: trimmed/.test(n)), notes[0] ?? "(silent)");

notes.length = 0;
await handlers["/budget"]("", ctx);
check("/budget reports the limit", /Per-result budget/.test(notes.join(" ")), notes.join(" ").split("\n")[0]);

// --- bash gets a tighter budget ------------------------------------------
check("bash is capped harder than other tools", budgetChars(51200, "bash") < budgetChars(51200),
  `bash ${budgetChars(51200, "bash")} vs ${budgetChars(51200)}`);
check("the bash cap still clears normal bash output", budgetChars(51200, "bash") > 2000,
  `${budgetChars(51200, "bash")} chars; only 26 of 371 logged calls exceeded 2,000`);

// --- file dumps through the shell ----------------------------------------
// Recorded live: `cat .phi/PLAN-DONE.md 2>/dev/null || echo "NO PLAN-DONE"`
// cost 898 tokens on a file the briefing already injects every turn, and walked
// past this guard because `2>/dev/null` and `||` contain the characters it was
// using to detect a pipeline.
check("stderr redirection is not filtering",
  looksLikeFileDump("cat verify.sh 2>/dev/null") === "verify.sh",
  "the whole of stdout still reaches the context");
check("a fallback branch is not a pipe",
  looksLikeFileDump('cat .phi/PLAN-DONE.md 2>/dev/null || echo "none"') === ".phi/PLAN-DONE.md");
check("2>&1 is caught too", looksLikeFileDump("cat pang.js 2>&1") === "pang.js");
check("a dump inside an exploration bundle is found",
  looksLikeFileDump('echo "== v =="; cat verify.sh; echo; ls -la test/') === "verify.sh",
  "bundling several reads into one bash call is how the guard gets bypassed");

// The cases it must still let through, or steering makes things worse.
check("a real pipeline is left alone", looksLikeFileDump("cat a.js | grep x") === undefined);
check("output redirected to a file is left alone", looksLikeFileDump("cat a.js > out.txt") === undefined);

check("catches cat of a path", looksLikeFileDump("cat .pi/NOTES.md") === ".pi/NOTES.md");
check("catches the awk line-numbering trick", looksLikeFileDump(`awk '{printf "%3d| %s\n", NR, $0}' pang.js`) === "pang.js",
  "its awk program contains a pipe, which naive detection treats as a pipeline");
check("catches sed ranges", looksLikeFileDump("sed -n '1,60p' test/run.html") === "test/run.html");
check("catches head/tail", looksLikeFileDump("head -20 pang.js") === "pang.js");
check("leaves real pipelines alone", looksLikeFileDump("cat x.js | grep foo") === undefined);
check("leaves redirects alone", looksLikeFileDump("cat a.js > b.js") === undefined);
check("ignores non-read commands", looksLikeFileDump("ls -la") === undefined && looksLikeFileDump("git log --oneline") === undefined);
check("ignores unresolvable targets", looksLikeFileDump("cat $FILE") === undefined);

const bigDump = "x".repeat(9000);
const steered = await handlers["tool_result"](
  { toolName: "bash", input: { command: "cat .pi/NOTES.md" }, content: [{ type: "text", text: bigDump }] }, ctx);
check("a shell file-dump is steered to outline/view_lines", /outline \.pi\/NOTES\.md/.test(steered?.content?.[0]?.text ?? ""),
  (steered?.content?.[0]?.text ?? "").slice(-90));
const quiet = await handlers["tool_result"](
  { toolName: "bash", input: { command: "cat tiny.txt" }, content: [{ type: "text", text: "two\nlines" }] }, ctx);
check("a small shell read is not nagged", quiet === undefined);

// --- an unbounded bash call is a stalled session --------------------------
// Observed: 1,334 seconds inside one headless-Chrome loop, because pi applies
// no timeout of its own when the model omits one.
const noTimeout = { toolName: "bash", input: { command: "sleep 9999" } };
await handlers["tool_call"](noTimeout, ctx);
check("a bash call with no timeout gets one", noTimeout.input.timeout > 0, `timeout=${noTimeout.input.timeout}s`);

const explicit = { toolName: "bash", input: { command: "npm ci", timeout: 1800 } };
await handlers["tool_call"](explicit, ctx);
check("an explicit timeout is respected", explicit.input.timeout === 1800,
  "a call that genuinely needs longer can still ask");

const notBash = { toolName: "view_lines", input: { file: "x.js" } };
await handlers["tool_call"](notBash, ctx);
check("other tools are untouched", notBash.input.timeout === undefined);

// --- the in-context note has to survive the state directory moving ---------
// It was a regex hardcoded to `.pi/`. State moved to `.phi/` in 0.6.0 and the
// note went quietly dead for six versions: a `cat .phi/PLAN-DONE.md` went
// through at 974 tokens with no pushback. It now asks the same list view_lines
// uses.
check("the injected files are recognised at their real path",
  alreadyInContext(".phi/PLAN.md") !== undefined && alreadyInContext(".phi/NOTES.md") !== undefined,
  "a check anchored on the old directory is a check that does nothing");
check("and by bare name, however the read was reached",
  alreadyInContext("PLAN.md") !== undefined && alreadyInContext("/x/y/.phi/NOTES.md") !== undefined);
check("the pre-0.6.0 path still matches", alreadyInContext(".pi/PLAN.md") !== undefined,
  "a project that never migrated still reads from there");
check("ordinary files are not claimed to be in context", alreadyInContext("pang.js") === undefined);
check("the archive is not claimed to be injected, because it is not",
  alreadyInContext(".phi/PLAN-DONE.md") === undefined,
  "the briefing names it and tells the model to read it before replanning");

const failed = results.filter((r) => !r).length;

// --- steering a shell bulk read toward the list form -----------------------
// 224 bash calls across 47 sessions shaped `for f in a b c; do cat "$f"; done`,
// none of them steered, because looksLikeFileDump recognises one file and a
// loop names many. outline shows why the tool existing is not enough: it was
// available throughout and called 8 times in 47 sessions. The hints that landed
// attach to a result the model already receives.
check("a loop over named files is recognised",
  JSON.stringify(looksLikeBulkRead('for f in src/A.php src/B.php; do cat "$f"; done')) === '["src/A.php","src/B.php"]',
  JSON.stringify(looksLikeBulkRead('for f in src/A.php src/B.php; do cat "$f"; done')));
check("a glob names many files in one token",
  JSON.stringify(looksLikeBulkRead('for f in src/Domain/*.php; do cat "$f"; done')) === '["src/Domain/*.php"]',
  "seen in a live run");
check("a filtered loop is left alone",
  looksLikeBulkRead('for f in a b; do cat $f; done | grep x') === undefined,
  "filtered output is not the problem this steers");
check("a single cat is not a bulk read",
  looksLikeBulkRead("cat one.php") === undefined,
  "looksLikeFileDump already covers that one");
check("a loop that reads nothing is not a bulk read",
  looksLikeBulkRead('for f in a.php b.php; do echo "$f"; done') === undefined);
check("at most twelve files are named back",
  (looksLikeBulkRead("for f in " + Array.from({length:20},(_,i)=>`f${i}.php`).join(" ") + '; do cat "$f"; done') || []).length === 12);

console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
