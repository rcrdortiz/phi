// Where the tokens go. Every improvement in this repo so far started from a
// measurement taken after something had already gone wrong; this collects the
// same evidence continuously.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import usageLog, { detailOf } from "../extensions/usage-log.ts";
import { formatSummary, readUsage, record, summarise, usagePath, worstCalls } from "../lib/usage.ts";

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
await fire("tool_execution_end", { toolCallId: "a", toolName: "bash", result: { content: [{ type: "text", text: "z".repeat(2000) }] }, isError: true });

const written = readUsage(dir);
check("interleaved calls are attributed to the right tool",
  written.find((r) => r.detail === "pang.js")?.tool === "view_lines" &&
    written.find((r) => r.detail === "sleep")?.tool === "bash",
  JSON.stringify(written.map((r) => `${r.tool}:${r.detail}`)));
check("shell output is estimated denser than source",
  written.find((r) => r.tool === "bash").tokens === 1000 &&
    written.find((r) => r.tool === "view_lines").tokens === 1000,
  "2000 chars of shell and 3400 of source are both ~1000 tokens");
check("a failed call is marked", written.find((r) => r.tool === "bash").error === true);

check("detail names the program, not the pipeline", detailOf("bash", { command: "./verify.sh | tail" }) === "./verify.sh");
check("detail names the file, not its directory", detailOf("view_lines", { file: "/a/b/c.js" }) === "c.js");
check("no args is not an error", detailOf("outline", undefined) === "");

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
