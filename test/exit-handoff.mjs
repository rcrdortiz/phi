// Ctrl+C stops the work. The next session should be told where it stopped,
// without paying for a model call on the way out: the one thing someone
// pressing ctrl+c has said is that they want out now.
process.env.PI_COMPACT_MIN_GAP_MS = "0";
process.env.PI_KEEP_RECENT_TOKENS = "9800";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const { default: mod, resumeNote, mergeHandoff } = await import("../extensions/auto-handoff.ts");
const { STATE_DIR } = await import("../lib/state-dir.ts");

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

// --- the note ---------------------------------------------------------------
const note = resumeNote({
  step: "Phase A1: make #game fill the viewport",
  inFlight: [{ tool: "bash", detail: "verify.sh", seconds: 12 }],
  recent: [{ tool: "edit_block", detail: "run.html" }],
  touched: ["index.html"],
});
check("the note names the step work last happened on", /Phase A1/.test(note));
check("it says what was cut off mid-call", /Interrupted mid-call/.test(note) && /verify\.sh \(12s in\)/.test(note),
  "an aborted test run looks like a completed one otherwise");
check("it lists what was changed", /index\.html/.test(note));
check("it lists recent actions newest first", /edit_block run\.html/.test(note));

const bare = resumeNote({ inFlight: [], recent: [], touched: [] });
check("with no plan it says so rather than implying one", /No plan step/.test(bare));
check("and claims nothing it cannot know", !/Interrupted|changed this session/.test(bare));

// --- merging ----------------------------------------------------------------
const merged = mergeHandoff("# Handoff\n\n_older_\n\nA summary the model wrote.", note, "2026-08-22 01:40");
check("the exit note goes on top", merged.indexOf("Where this stopped") < merged.indexOf("Before that"));
check("the previous summary is kept",
  /A summary the model wrote/.test(merged),
  "a model-written account is better material than this and an exit is no reason to lose it");
check("there is one title", (merged.match(/^# Handoff$/gm) ?? []).length === 1);
check("an empty file merges cleanly",
  !/Before that/.test(mergeHandoff("", note, "x")) && /Where this stopped/.test(mergeHandoff("", note, "x")));

// --- wiring -----------------------------------------------------------------
const handlers = {};
mod({
  on: (e, h) => ((handlers[e] ||= []).push(h)),
  registerCommand: () => {}, registerTool: () => {}, sendUserMessage: () => {},
});
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phi-exit-"));
fs.mkdirSync(path.join(dir, STATE_DIR), { recursive: true });
fs.writeFileSync(path.join(dir, STATE_DIR, "PLAN.md"), "# Plan\n\n- [x] one\n- [ ] two the pending one\n");
const ctx = { cwd: dir, ui: { notify: () => {} } };
const fire = async (e, ev = {}) => { for (const h of handlers[e] ?? []) await h(ev, ctx); };
const handoff = () => { try { return fs.readFileSync(path.join(dir, STATE_DIR, "HANDOFF.md"), "utf8"); } catch { return ""; } };

await fire("tool_execution_start", { toolCallId: "1", toolName: "edit_block", args: { file: "index.html" } });
await fire("tool_execution_end", { toolCallId: "1" });
await fire("tool_execution_start", { toolCallId: "2", toolName: "bash", args: { command: "bash verify.sh" } });
await fire("session_shutdown", { reason: "quit" });

const out = handoff();
check("quitting writes the note", /Where this stopped/.test(out), out.split("\n").slice(0, 6).join(" | "));
check("the unfinished plan step is named", /two the pending one/.test(out));
check("the call still running is reported as interrupted", /bash bash verify\.sh/.test(out), out);
// Only the section, not the rest of the file: edit_block legitimately appears
// further down under recent actions, and a greedy match spans to it.
const interrupted = (out.split("Interrupted mid-call")[1] ?? "").split("\n\n")[0];
check("a call that finished is not reported as interrupted",
  !/edit_block/.test(interrupted), interrupted.trim());
check("the edited file is listed", /index\.html/.test(out));

// A session that did nothing should not overwrite a real summary with a stub.
fs.writeFileSync(path.join(dir, STATE_DIR, "HANDOFF.md"), "# Handoff\n\nreal summary\n");
const h2 = {};
mod({ on: (e, h) => ((h2[e] ||= []).push(h)), registerCommand: () => {}, registerTool: () => {}, sendUserMessage: () => {} });
fs.writeFileSync(path.join(dir, STATE_DIR, "PLAN.md"), "# Plan\n\n- [x] all done\n");
for (const h of h2.session_shutdown ?? []) await h({ reason: "quit" }, ctx);
check("a session with nothing to resume leaves the summary alone",
  handoff() === "# Handoff\n\nreal summary\n",
  "a stub that says nothing is worse than the summary it replaced");

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
