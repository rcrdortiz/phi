// Regressions for the failure chain observed in a real pi session:
// two replace_lines safety failures -> a refused re-read -> a broken edit ->
// a shell heredoc that corrupted the file with no revert.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import mod from "/Users/rcrd/AI/pi-local/extensions/smart-edit.ts";
import budget, { looksLikeSourceWrite } from "/Users/rcrd/AI/pi-local/extensions/tool-budget.ts";
import { ReadCache, CACHE_MIN_LINES } from "/Users/rcrd/AI/pi-local/lib/read-lean.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "editloop-"));
const tools = {};
mod({ registerTool: (t) => (tools[t.name] = t), registerCommand: () => {}, on: () => {}, getAllTools: () => [], setActiveTools: () => {} });
const ctx = { cwd: DIR, ui: { notify: () => {} } };
const F = path.join(DIR, "g.js");
const write = (t) => fs.writeFileSync(F, t);
const read = () => fs.readFileSync(F, "utf8");

// ---- 1. re-indent must not flatten nesting -------------------------------
// edit_block is the tool that re-indents; replace_lines inserts verbatim.
write(["class G {", "  play(dt) {", "    const a = 1;", "  }", "}"].join("\n"));
await tools.edit_block.execute("1", {
  file: F,
  old_text: "const a = 1;",
  // Supplied with NO leading indent, which is what made the old reindent
  // treat `own` as "" and flatten every line onto baseIndent.
  new_text: ["if (this.t > 0) {", "  this.t -= dt;", "}"].join("\n"),
}, undefined, undefined, ctx);
const out = read().split("\n");
const body = out.find((l) => l.includes("this.t -= dt"));
const close = out.find((l, i) => l.trim() === "}" && out[i - 1]?.includes("this.t -= dt"));
check("re-indent keeps the body deeper than its if", /^\s{6,}this\.t/.test(body), JSON.stringify(body));
check("re-indent keeps the closing brace at the if's level",
  close !== undefined && close.length < body.length, JSON.stringify(close));
check("the file still parses after re-indent", (() => {
  try { execFileSync("node", ["--check", F], { stdio: "pipe" }); return true; } catch { return false; }
})(), read());

// ---- 2. a failed `expect` must be self-correcting ------------------------
write(["class G {", "  play() {", "    const a = 1;", "    const b = 2;", "  }", "}"].join("\n"));
const bad = await tools.replace_lines.execute("2", {
  file: F, start_line: 3, end_line: 3, expect: "const b = 2;", new_text: "const a = 9;",
}, undefined, undefined, ctx);
check("failed expect returns an error", bad.isError === true);
check("failed expect shows NUMBERED lines", /^\s*3\|/m.test(bad.content[0].text), bad.content[0].text);
check("failed expect locates the text elsewhere", /line 4, outside 3-3/.test(bad.content[0].text), bad.content[0].text);
check("failed expect explains the rule", /must appear INSIDE the range/.test(bad.content[0].text));

// ---- 3. the read cache must not block a cheap re-read --------------------
const cache = new ReadCache();
const stamp = { size: 1, mtimeMs: 1 };
cache.record("f.js", stamp, 295, 340);                     // a wide read, as observed
check("a small re-read inside a wide one is still served",
  !cache.covered("f.js", stamp, 308, 316),
  `9 lines <= ${CACHE_MIN_LINES}-line floor, so it is served rather than refused`);
cache.record("f.js", stamp, 1, 400);
check("a genuinely large re-read is still suppressed", cache.covered("f.js", stamp, 1, 200));

// ---- 4. shell writes to source must be flagged --------------------------
check("detects a python heredoc writing source",
  looksLikeSourceWrite('python3 - <<PY\nopen("pang.js","w").write(x)\nPY') === "pang.js");
check("detects sed -i", looksLikeSourceWrite("sed -i.bak s/a/b/ pang.js") === "pang.js");
check("ignores reads", looksLikeSourceWrite("cat pang.js") === undefined && looksLikeSourceWrite("grep x pang.js") === undefined);

const handlers = {};
budget({ on: (e, h) => (handlers[e] = h), registerCommand: () => {}, registerTool: () => {} });
const bctx = { ui: { notify: () => {} }, getContextUsage: () => ({ tokens: 100, contextWindow: 51200 }) };
const steered = await handlers["tool_result"]({
  toolName: "bash",
  input: { command: 'python3 - <<PY\nopen("pang.js","w").write(x)\nPY' },
  content: [{ type: "text", text: "inserted before line 330" }],
}, bctx);
check("a shell source-write is warned about",
  /skips the syntax check/.test(steered?.content?.[0]?.text ?? ""), (steered?.content?.[0]?.text ?? "").slice(-120));

fs.rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
