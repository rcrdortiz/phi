import mod, { budgetChars, truncate, shrinkImage, looksLikeFileDump } from "/Users/rcrd/AI/pi-local/extensions/tool-budget.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + d : ""}`); };

// --- budget sizing -------------------------------------------------------
check("budget scales with the window", budgetChars(32768) < budgetChars(131072),
  `32K -> ${budgetChars(32768)}, 128K -> ${budgetChars(131072)}`);
check("budget has a floor for tiny windows", budgetChars(1000) >= 4000, String(budgetChars(1000)));
check("32K window budgets ~11.8K chars", Math.abs(budgetChars(32768) - 11796) < 50, String(budgetChars(32768)));

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
const shot = "/Users/rcrd/AI/pang-clone/shot_title.png";      // 800x600
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

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
