import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
import mod, { resetReadRun, stripEchoedGutter } from "../extensions/smart-edit.ts";

// The fixture is written here rather than read from disk, and its irregular
// indentation IS the test: 2, 3 and 5 spaces, with a closing brace at 2. That
// shape is what defeated the built-in edit tool, so it has to be exact.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "smart-edit-"));
const FILE = `${DIR}/game.js`;
const ORIGINAL = [
	"const CONFIG = {",
	"  WIDTH: 800,",
	"   HEIGHT: 600,",
	"     SPEED: 5,",
	"  };",
	"",
	"function start() {",
	"      return CONFIG.SPEED;",
	"}",
	"",
].join("\n");
fs.writeFileSync(FILE, ORIGINAL);

const tools = {};
mod({ registerTool: (t) => (tools[t.name] = t), registerCommand: () => {}, on: () => {} });
const ctx = { cwd: DIR, ui: { notify: () => {} } };
const call = (name, params) => tools[name].execute("id", params, undefined, undefined, ctx);

const results = [];
const check = (label, pass, detail = "") => {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? "\n        " + detail : ""}`);
};

// 1. Match despite wrong indentation — the exact failure that defeated the built-in edit tool.
fs.writeFileSync(FILE, ORIGINAL);
let r = await call("edit_block", {
	file: "game.js",
	old_text: "        SPEED: 5,\n        };", // model guesses 8 spaces; file has 5 and 2
	new_text: "SPEED: 9,\n};",
});
let after = fs.readFileSync(FILE, "utf8");
check(
	"edit_block matches despite wrong indentation",
	!r.isError && after.includes("SPEED: 9"),
	r.content?.[0]?.text?.slice(0, 110),
);

// 2. Replacement is re-indented to the file, not to whatever the model sent.
check(
	"replacement re-indented to the file's own indentation",
	/\n {5}SPEED: 9,/.test(after),
	JSON.stringify(after.split("\n").slice(3, 5)),
);

// 3. A syntactically broken edit is reverted rather than saved.
fs.writeFileSync(FILE, ORIGINAL);
r = await call("edit_block", {
	file: "game.js",
	old_text: "function start() {",
	new_text: "function start( {", // deliberately broken
});
after = fs.readFileSync(FILE, "utf8");
check(
	"syntax-breaking edit is reverted",
	r.isError === true && after === ORIGINAL,
	(r.content?.[0]?.text || "").split("\n")[0],
);

// 4. A miss reports nearby candidates instead of failing blankly.
fs.writeFileSync(FILE, ORIGINAL);
r = await call("edit_block", { file: "game.js", old_text: "WIDTH: 1024,", new_text: "WIDTH: 2048," });
check(
	"unmatched block suggests the closest lines",
	r.isError === true && /Closest lines/.test(r.content[0].text),
	r.content[0].text.split("\n").slice(1, 3).join(" | "),
);

// 5. Ambiguity is refused rather than guessed at.
fs.writeFileSync(FILE, "a();\nx();\na();\n");
r = await call("edit_block", { file: "game.js", old_text: "a();", new_text: "b();" });
check("ambiguous match refused with line numbers", r.isError === true && /appears 2 times/.test(r.content[0].text));

// 6. replace_lines guard catches a stale line number.
fs.writeFileSync(FILE, ORIGINAL);
r = await call("replace_lines", {
	file: "game.js",
	start_line: 2,
	end_line: 2,
	new_text: "  WIDTH: 1024,",
	expect: "HEIGHT",
});
check("replace_lines refuses when `expect` is absent", r.isError === true && fs.readFileSync(FILE, "utf8") === ORIGINAL);

// 7. replace_lines works when the guard matches.
r = await call("replace_lines", {
	file: "game.js",
	start_line: 2,
	end_line: 2,
	new_text: "  WIDTH: 1024,",
	expect: "WIDTH",
});
check("replace_lines applies with a correct guard", !r.isError && fs.readFileSync(FILE, "utf8").includes("WIDTH: 1024"));

// 8. view_lines numbers correctly.
r = await call("view_lines", { file: "game.js", start_line: 1, end_line: 3 });
check("view_lines shows numbered lines", /^1\|const CONFIG/m.test(r.content[0].text),
  r.content[0].text.split("\n")[1]);
// The gutter is 23% of a file read, so its shape is worth pinning. Measured on
// 160 lines of source: right-alignment padding costs ~1 token per line and buys
// nothing, since nothing here is read as a column.
check("the gutter carries no alignment padding",
  !/^\s+\d+\|/m.test(r.content[0].text),
  "a leading space per line is a token per line");
check("the bar is kept", /^\d+\|/m.test(r.content[0].text),
  "it disambiguates the number from a line of code that starts with a digit");

// The retirement of the built-in read and edit tools is silent now. That makes
// it exactly the kind of behaviour that regresses unnoticed, so assert it.
{
	const active = [];
	mod({
		registerTool: () => {}, registerCommand: () => {},
		on: (e, h) => { if (e === "before_agent_start") h(); },
		getAllTools: () => [{ name: "bash" }, { name: "read" }, { name: "edit" }, { name: "write" }],
		setActiveTools: (l) => active.push(...l),
	});
	check("read and edit are still retired", !active.includes("read") && !active.includes("edit"), active.join(", "));
	check("other built-ins are left alone", active.includes("bash") && active.includes("write"));
}

fs.writeFileSync(FILE, ORIGINAL);

// --- an echoed view_lines gutter must not reach the file -------------------
// view_lines renders "12|code". The model pastes it back into new_text, and on
// a syntax-checked file the check reverted it, but markdown and text have no
// check: "2|some text" was written and reported as a successful replace.
{
  const g = (t, start) => stripEchoedGutter(t, start);
  check("strips a gutter matching the replaced range",
    g("2|const b = 99;", 2).text === "const b = 99;" && g("2|x", 2).stripped);
  check("strips a multi-line gutter", g("5|a\n6|b\n7|c", 5).text === "a\nb\nc");
  check("leaves text with no gutter alone", !g("const b = 99;", 2).stripped);
  check("leaves a gutter starting at the wrong line alone",
    !g("9|const b = 99;", 2).stripped,
    "numbers that do not match the range being replaced are content, not a gutter");
  check("leaves non-consecutive numbers alone", !g("2|a\n7|b", 2).stripped,
    "a gutter is always consecutive");
  check("leaves a markdown table alone", !g("| a | b |\n| c | d |", 1).stripped);
  // The honest limit: a pipe-delimited file whose first column is consecutive
  // row numbers is indistinguishable from a gutter, which is why the result
  // message says when it stripped.
  check("a consecutive-numbered CSV is the known false positive",
    g("1|alpha\n2|beta", 1).stripped,
    "reported in the tool result so it is recoverable");
}

// --- the line-free experiment ---------------------------------------------
// replace_lines is the only tool that needs a gutter: 727 reads paid for it
// across 47 sessions, 40 replace_lines calls used it, against 174 edit_block
// and 34 edit_symbol which match on content and on a name.
{
  const src = fs.readFileSync(path.join(root, "extensions/smart-edit.ts"), "utf8");
  check("the flag withholds replace_lines",
    /if \(!LINE_FREE\) pi\.registerTool\(\{\s*\n\s*name: "replace_lines"/.test(src),
    "the tool and the gutter go together; neither is useful without the other");
  check("and strips the gutter with it",
    /LINE_FREE \? l : `\$\{s \+ i\}\|\$\{l\}`/.test(src));
  check("it is off unless asked for",
    /process\.env\.PI_DROP_REPLACE_LINES === "1"/.test(src),
    "an experiment must not change behaviour for anyone who did not opt in");
  check("edit_block and edit_symbol are untouched by it",
    !/if \(!LINE_FREE\) pi\.registerTool\(\{\s*\n\s*name: "(edit_block|edit_symbol|view_lines)"/.test(src),
    "they are what the experiment expects the model to use instead");
}


// --- reading several files in one call -------------------------------------
// 727 view_lines calls across 47 sessions, and 368 reads that went through bash
// instead, 224 of them `for f in a b c; do cat "$f"; done`. A third of all
// reading bypassed this tool because it took one file, and every bypass lost
// the read cache, the line cap, the budget and the anchor.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phi-batch-"));
  const big = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1} of content here`).join("\n");
  fs.writeFileSync(path.join(dir, "a.ts"), big(80));
  fs.writeFileSync(path.join(dir, "b.ts"), big(80));
  fs.writeFileSync(path.join(dir, "c.ts"), big(80));

  const tools = {};
  mod({ registerTool: (t) => (tools[t.name] = t), registerCommand: () => {}, on: () => {} });
  const ctx = { cwd: dir };
  const run = (files, refresh) => tools.view_lines.execute("x", { file: files, refresh }, null, null, ctx);

  const first = await run(["a.ts", "b.ts", "c.ts"]);
  const t1 = first.content[0].text;
  check("a list reads every file in one call", (t1.match(/^===== /gm) || []).length === 3, String((t1.match(/^===== /gm) || []).length));
  check("each file is labelled with its name and length", /===== a\.ts \(80 lines\) =====/.test(t1));
  check("the gutter is the same one view_lines uses", /\n1\|line 1 of content/.test(t1));

  const second = await run(["a.ts", "b.ts", "c.ts"]);
  check("a re-read is suppressed by the cache, not repeated",
    second.content[0].text.length < t1.length / 5,
    `${second.content[0].text.length} vs ${t1.length} chars`);
  check("and it says which files it skipped", /not repeated: a\.ts/.test(second.content[0].text));

  const forced = await run(["a.ts"], true);
  check("refresh overrides the cache", /===== a\.ts/.test(forced.content[0].text));

  const missing = await run(["a.ts", "nope.ts"], true);
  check("a missing file does not fail the batch",
    /nope\.ts: no such file/.test(missing.content[0].text) && /===== a\.ts/.test(missing.content[0].text),
    "one bad path must not cost the other five files");

  // Both caps. A batch cap alone would divide a twelve-file request into
  // twelfths, which is useless, and the model would go back to bash.
  const many = Array.from({ length: 20 }, (_, i) => `f${i}.ts`);
  many.forEach((f) => fs.writeFileSync(path.join(dir, f), big(80)));
  const capped = await run(many, true);
  const shown = (capped.content[0].text.match(/^===== /gm) || []).length;
  check("a huge batch is capped by file count", shown <= 12, String(shown));
  check("and says what it did not read", /not read: at most/.test(capped.content[0].text) || /stopped at/.test(capped.content[0].text),
    "a silently shortened batch is how a model concludes a file does not exist");

  fs.rmSync(dir, { recursive: true, force: true });
}


// --- nudging a run of single-file reads ------------------------------------
// The bash steer covers 224 shell loops but misses the other half: one run made
// 70 single-file view_lines calls and 4 bash calls, so nothing fired at all.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phi-nudge-"));
  for (const f of ["a.ts", "b.ts", "c.ts", "d.ts"]) fs.writeFileSync(path.join(dir, f), "x\ny\nz\n");
  const tools = {};
  mod({ registerTool: (t) => (tools[t.name] = t), registerCommand: () => {}, on: () => {} });
  const ctx = { cwd: dir };
  const read = (f) => tools.view_lines.execute("x", { file: f }, null, null, ctx);
  const nudged = (r) => /That is \d+ single-file reads in a row/.test(r.content[0].text);

  resetReadRun();
  check("one read is not nagged", !nudged(await read("a.ts")));
  check("two reads are not nagged", !nudged(await read("b.ts")));
  const third = await read("c.ts");
  check("a run of three is nudged", nudged(third), third.content[0].text.split("\n")[1] || "");
  check("the nudge names the files it would batch",
    /"a\.ts", "b\.ts", "c\.ts"/.test(third.content[0].text),
    "a suggestion the model has to compose itself is one it will not take");
  check("it does not nag on every call after that", !nudged(await read("d.ts")),
    "a message repeated every call is one the model learns to skip");

  // Using the list is what the nudge asks for, so it must reset the run.
  resetReadRun();
  await read("a.ts"); await read("b.ts");
  await tools.view_lines.execute("x", { file: ["c.ts", "d.ts"], refresh: true }, null, null, ctx);
  check("a batch read resets the run", !nudged(await read("a.ts")),
    "otherwise doing the right thing still earns a telling-off");

  fs.rmSync(dir, { recursive: true, force: true });
}

// --- the unseen hint and the compaction-cleared cache -----------------------
// A no-match on a file the model has never seen at its current bytes means
// old_text was reconstructed from memory or a compaction summary. And the
// cache's "already shown above, scroll up" is only true while the conversation
// still holds the lines: a compaction rewrites the conversation, so it must
// also reset the cache, or the refusal itself sends the model back to guessing.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phi-unseen-"));
  fs.writeFileSync(path.join(dir, "long.js"), Array.from({ length: 100 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n"));

  const tools = {};
  const handlers = {};
  mod({
    registerTool: (t) => (tools[t.name] = t),
    registerCommand: () => {},
    on: (e, h) => (handlers[e] ??= []).push(h),
  });
  const ctx = { cwd: dir, ui: { notify: () => {} } };
  const miss = () => tools.edit_block.execute("x", { file: "long.js", old_text: "nothing like this exists", new_text: "y" }, null, null, ctx);
  const view = () => tools.view_lines.execute("x", { file: "long.js", start_line: 1, end_line: 100 }, null, null, ctx);

  resetReadRun();
  let r = await miss();
  check("a miss on an unread file says to read, not to retry",
    r.isError === true && /not viewed this file/.test(r.content[0].text),
    "the matched text can only have come from memory or a summary");

  await view();
  r = await miss();
  check("after a read the same miss is a near-miss, not a guess",
    r.isError === true && !/not viewed this file/.test(r.content[0].text),
    "the hint must name one specific failure or it becomes noise");

  r = await view();
  check("a large re-read is suppressed while the context still holds it",
    /already shown above/.test(r.content[0].text));

  for (const h of handlers.session_compact ?? []) await h({}, ctx);
  r = await view();
  check("session_compact clears the cache so the re-read is served",
    /^1\|const v1/m.test(r.content[0].text),
    "after a compaction 'scroll up' points at text that is no longer there");
  check("the extension hooks session_compact and session_start",
    (handlers.session_compact ?? []).length > 0 && (handlers.session_start ?? []).length > 0);

  fs.rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

