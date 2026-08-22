// Where the tokens go. Every improvement in this repo so far started from a
// measurement taken after something had already gone wrong; this collects the
// same evidence continuously.
// Recording is opt-in: it appends on every tool call and a project should not
// accumulate a log nobody asked for. Set before the import, since ESM hoists.
// Awaited imports, not static ones: ESM hoists a static import above this
// assignment, so the module would read the flag before it was set. The same
// trap is documented in compaction-baseline.mjs.
process.env.PHI_USAGE_LOG = "1";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const { default: usageLog, commandOf, detailOf } = await import("../extensions/usage-log.ts");
const { COMMAND_MAX, formatSummary, readUsage, record, summarise, summariseCommands, usagePath, worstCalls } =
  await import("../lib/usage.ts");

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

const rec = (tool, tokens, detail = "", extra = {}) =>
  ({ at: "2026-08-22T00:00:00Z", tool, detail, chars: tokens * 3, tokens, ms: 100, ...extra });

// --- the summary answers the question it is for ----------------------------
const sample = [
  rec("bash", 10_000, "verify.sh"), rec("bash", 300, "ls"),
  rec("view_lines", 2000, "a.js"), rec("view_lines", 2400, "b.js"),
  rec("outline", 300, "a.js", { error: true }),
];
const rows = summarise(sample);
check("tools are ordered by what they cost", rows[0].tool === "bash", rows.map((r) => r.tool).join(" > "));
check("shares add up to the whole", Math.abs(rows.reduce((a, r) => a + r.share, 0) - 1) < 0.001);
check("errors are counted separately", rows.find((r) => r.tool === "outline").errors === 1);

// Total and median answer different questions, which is why both are reported.
check("median is reported next to the total",
  rows.find((r) => r.tool === "view_lines").median === 2200,
  "a high total with a low median is a tool called often, not an expensive one");
check("the worst single call is kept",
  rows.find((r) => r.tool === "bash").worst === 10_000,
  "the outlier is usually where the fix is");
check("the biggest calls are listed by name",
  worstCalls(sample, 2).map((r) => r.detail).join(",") === "verify.sh,b.js");

check("an empty log says so rather than printing an empty table",
  /No tool calls recorded/.test(formatSummary([])));

// --- the file ---------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phi-usage-"));
record(dir, rec("bash", 500, "ls"));
record(dir, rec("view_lines", 900, "x.js"));
check("records land under the state directory", /\.phi\/usage\.jsonl$/.test(usagePath(dir)));
check("and read back", readUsage(dir).length === 2);

fs.appendFileSync(usagePath(dir), "this is not json\n");
check("a corrupt line is skipped, not fatal", readUsage(dir).length === 2,
  "a log that throws on read is worse than one with a gap");
check("a project with no log reads as empty", readUsage(path.join(dir, "nope")).length === 0);

// --- wiring -----------------------------------------------------------------
const handlers = {}, cmds = [];
usageLog({
  on: (e, h) => ((handlers[e] ||= []).push(h)),
  registerCommand: (n) => cmds.push(n),
  registerTool: () => {},
});
check("registers /usage", cmds.includes("usage"));

const fire = async (e, ev) => { for (const h of handlers[e] ?? []) await h(ev, { cwd: dir }); };
fs.rmSync(usagePath(dir));

// Calls interleave, so a single "current call" would bill one tool's output to
// another's timer.
await fire("tool_execution_start", { toolCallId: "a", toolName: "bash", args: { command: "sleep 1" } });
await fire("tool_execution_start", { toolCallId: "b", toolName: "view_lines", args: { file: "/x/pang.js" } });
await fire("tool_execution_end", { toolCallId: "b", toolName: "view_lines", result: { content: [{ type: "text", text: "y".repeat(3400) }] } });
await fire("tool_execution_end", { toolCallId: "a", toolName: "bash", result: { content: [{ type: "text", text: "boom: no such file\n".repeat(40) }] }, isError: true });

const written = readUsage(dir);
check("interleaved calls are attributed to the right tool",
  written.find((r) => r.detail === "pang.js")?.tool === "view_lines" &&
    written.find((r) => r.detail === "sleep")?.tool === "bash",
  JSON.stringify(written.map((r) => `${r.tool}:${r.detail}`)));
check("shell output is estimated denser than source",
  written.find((r) => r.tool === "bash").tokens > 0 &&
    written.find((r) => r.tool === "view_lines").tokens === 1000,
  "3400 chars of source is ~1000 tokens at 3.4 chars each");
const failed = written.find((r) => r.tool === "bash");
check("a failed call is marked", failed.error === true);
check("and records why, capped and on one line",
  /^boom: no such file/.test(failed.detailError) && failed.detailError.length <= 200 && !/\n/.test(failed.detailError),
  failed.detailError);
check("a successful call records no failure text",
  written.find((r) => r.tool === "view_lines").detailError === undefined);

check("detail names the program, not the pipeline", detailOf("bash", { command: "./verify.sh | tail" }) === "./verify.sh");
check("detail names the file, not its directory", detailOf("view_lines", { file: "/a/b/c.js" }) === "c.js");
// Six reads of one file are six wasted reads if they cover the same lines and
// ordinary exploration if they do not. Without the range the log cannot tell
// the difference, and live it could not: the question was unanswerable.
check("a read records its range", detailOf("view_lines", { file: "/a/run.html", start_line: 120, end_line: 340 }) === "run.html:120-340");
check("an open-ended read says so", detailOf("view_lines", { file: "/a/x.js", start_line: 40 }) === "x.js:40+");
check("a read with no range is still named", detailOf("view_lines", { file: "/a/x.js" }) === "x.js");
check("no args is not an error", detailOf("outline", undefined) === "");

// --- failures ---------------------------------------------------------------
// Failures are where the waste is. A session lost five minutes to six edits and
// two failed runs of one shell script, and the log could say only that they
// failed, which is the least useful half of the fact.
const failRecs = [
  rec("bash", 100, "run", { error: true, detailError: "chrome: command not found" }),
  rec("bash", 100, "run", { error: true, detailError: "chrome: command not found" }),
  rec("bash", 100, "run", { error: true, detailError: "chrome: command not found" }),
  rec("edit_block", 40, "a.js", { error: true, detailError: "no match for the search text" }),
  rec("view_lines", 900, "a.js"),
];
const report = formatSummary(failRecs);
check("failures get their own section", /Failed calls \(4\)/.test(report), report.split("\n\n")[2]);
check("the same failure three times is shown as one row with a count",
  /^\s*3\s+bash\s+chrome: command not found/m.test(report),
  "three of one failure is a loop; three different ones are three problems");
check("a distinct failure is not folded in with it", /no match for the search text/.test(report));
check("successful calls are not listed as failures", !/view_lines/.test(report.split("Failed calls")[1].split("Biggest")[0]));
check("a failure with no text still counts",
  /Failed calls \(1\)/.test(formatSummary([rec("bash", 10, "x", { error: true })])),
  "no detail is still a failure");

// --- shell commands ---------------------------------------------------------
// The program alone groups `ls` with `ls -laR /`, which cost wildly different
// amounts, so grouping on it would hide exactly what the report is for.
check("the whole command is kept, not just the program",
  commandOf({ command: "./verify.sh 2>&1 | tail -5" }) === "./verify.sh 2>&1 | tail -5");
check("newlines collapse so one record stays one line",
  commandOf({ command: "cd /x\n  make all" }) === "cd /x make all");
check("a heredoc does not end up in the log",
  (commandOf({ command: "x".repeat(500) }) ?? "").length === COMMAND_MAX);
check("a non-bash call has no command", commandOf({ file: "a.js" }) === undefined && commandOf(undefined) === undefined);

const cmdRecs = [
  rec("bash", 9000, "verify.sh", { command: "./verify.sh" }),
  ...Array.from({ length: 3 }, () => rec("bash", 800, "ls", { command: "ls -la ." })),
  rec("view_lines", 2400, "a.js"),
];
const cmdRows = summariseCommands(cmdRecs);
check("commands are grouped by their text", cmdRows.length === 2, cmdRows.map((c) => c.command).join(" | "));
check("a cheap command run often is one expensive row",
  cmdRows.find((c) => c.command === "ls -la .").tokens === 2400,
  "forty cheap calls of the same thing is the shape worth finding");
check("commands are ordered by total cost", cmdRows[0].command === "./verify.sh");
check("non-shell calls are not counted as commands",
  !cmdRows.some((c) => c.command.includes("a.js")));
check("the report lists them", /Shell commands by total cost/.test(formatSummary(cmdRecs)));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
