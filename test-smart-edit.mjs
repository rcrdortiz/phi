import * as fs from "node:fs";
import mod from "/Users/rcrd/AI/pi-local/extensions/smart-edit.ts";

const DIR = "/private/tmp/claude-501/-Users-rcrd-AI/e8ea8186-91cd-40f5-bdea-c71eea252575/scratchpad/edit-test";
const FILE = `${DIR}/game.js`;
const ORIGINAL = fs.readFileSync(FILE, "utf8");

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
check("view_lines shows numbered lines", /1\| const CONFIG/.test(r.content[0].text));

fs.writeFileSync(FILE, ORIGINAL);
const failed = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
