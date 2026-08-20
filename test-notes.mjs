import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import mod from "/Users/rcrd/AI/pi-local/extensions/plan-notes.ts";
import { narrationReason, trimNote, pruneExpiring, NOTE_MAX_CHARS } from "/Users/rcrd/AI/pi-local/lib/notes.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

// --- narration detection, using the REAL notes from the observed file -----
const realNarration = [
  "Starfield (step 1) done: renderBackground() paints vertical gradient + nebula radial glows",
  "Step 3 done: renderShip() now draws a sleek gradient-hull pod",
  "Step 5 done: test/run.html fully rewritten from Space-Invaders assertions to Pang semantics",
  "Professional redesign delivered across 6 steps: (1) THEME token system",
];
check("catches every narration note from the real file",
  realNarration.every((n) => narrationReason(n) !== undefined),
  realNarration.map((n) => `${narrationReason(n) ? "caught" : "MISSED"}: ${n.slice(0, 48)}`).join("\n"));

// --- and does NOT catch the genuine invariants from the same file ---------
const realInvariants = [
  "pang.js has wildly inconsistent indentation but is valid JS (whitespace-insensitive).",
  "In play(), the bomb movement/bounce/timer loop must run a SEPARATE split pass (reverse-indexed) AFTER the walk.",
  "Verification for visual work: I cannot view images in this session. Use test/shot.html instead.",
  "Clear-reseed MUST be gated on a flag (e.g. this.roundActive) set ONLY by startDrop().",
  "Combo scoring: this.combo (int) + this.comboTimer (ms). In killBomb, if comboTimer>0 increment combo.",
];
check("does not refuse genuine invariants",
  realInvariants.every((n) => narrationReason(n) === undefined),
  realInvariants.filter((n) => narrationReason(n)).map((n) => "FALSE POSITIVE: " + n.slice(0, 50)).join("\n") || "none refused");
check("a step mentioned in passing is not narration",
  narrationReason("The dropTimer trap bites when step 4 sets state='play' directly") === undefined);

// --- length cap -----------------------------------------------------------
const short = "Keys are more sensitive than values.";
check("short notes pass through", trimNote(short).text === short && !trimNote(short).trimmed);
const long = "First sentence explains the constraint clearly. " + "padding words that go on and on ".repeat(20);
const t = trimNote(long);
check("long notes are trimmed to the cap", t.text.length <= NOTE_MAX_CHARS && t.trimmed, `${long.length} -> ${t.text.length}`);
check("trimming prefers a sentence boundary", /\.$/.test(t.text) || /\.\.\.$/.test(t.text), t.text.slice(-40));
check("the first sentence survives", t.text.startsWith("First sentence explains the constraint clearly."));

// --- expiry ---------------------------------------------------------------
const notes = "# Notes\n\n## gotcha\n- durable one\n\n## state\n- 6 tests still FAIL\n- run.html is still the old suite\n\n## decision\n- chose X\n";
const pr = pruneExpiring(notes);
check("expiring notes are removed", pr.removed === 2 && !/tests still FAIL/.test(pr.text), `removed ${pr.removed}`);
check("durable notes survive expiry", /durable one/.test(pr.text) && /chose X/.test(pr.text), pr.text.trim());
check("no state section is a no-op", pruneExpiring("# Notes\n\n## gotcha\n- a\n").removed === 0);

// --- wired into the tools -------------------------------------------------
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "notes-"));
const tools = {};
mod({ registerTool: (t) => (tools[t.name] = t), registerCommand: () => {}, on: () => {} });
const ctx = { cwd: DIR, mode: "tui", ui: { notify: () => {}, confirm: async () => true } };
const notesFile = () => { try { return fs.readFileSync(path.join(DIR, ".pi", "NOTES.md"), "utf8"); } catch { return ""; } };

const refused = await tools.note_add.execute("1", { category: "technical", note: "Step 1 done: built the thing" }, undefined, undefined, ctx);
check("note_add refuses a step report", refused.isError === true, refused.content[0].text.slice(0, 80));
check("and points at plan_next instead", /plan_next/.test(refused.content[0].text));
check("nothing was written", notesFile() === "");

await tools.note_add.execute("2", { category: "gotcha", note: "edit_block re-indents cascading blocks; check syntax after." }, undefined, undefined, ctx);
check("a real gotcha is recorded", /re-indents cascading/.test(notesFile()));

const st = await tools.note_add.execute("3", { category: "state", note: "6 tests still fail, expected until step 6." }, undefined, undefined, ctx);
check("state notes say they will expire", /dropped at the next step boundary/.test(st.content[0].text), st.content[0].text);

await tools.plan_write.execute("4", { goal: "g", steps: ["one", "two"] }, undefined, undefined, ctx);
await tools.plan_next.execute("5", { summary: "did one" }, undefined, undefined, ctx);
check("the step boundary expires state notes", !/6 tests still fail/.test(notesFile()), notesFile().trim());
check("but keeps the gotcha", /re-indents cascading/.test(notesFile()));

fs.rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
