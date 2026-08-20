import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import mod from "/Users/rcrd/AI/pi-local/extensions/smart-edit.ts";
import { findSymbol, stripNonCode, supportsSymbols } from "/Users/rcrd/AI/pi-local/lib/symbols.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sym-"));
const tools = {};
mod({ registerTool: (t) => (tools[t.name] = t), registerCommand: () => {}, on: () => {}, getAllTools: () => [], setActiveTools: () => {} });
const ctx = { cwd: DIR, ui: { notify: () => {} } };
const F = path.join(DIR, "g.js");
const SRC = [
  "class Game {",
  "  play(dt) {",
  "    for (var i = 0; i < 3; i++) {",
  "      if (x) { y(); }",
  "    }",
  "  }",
  "",
  "  currentBombSpeed() {",
  "    return 1;",
  "  }",
  "}",
].join("\n");
const write = () => fs.writeFileSync(F, SRC);
const read = () => fs.readFileSync(F, "utf8");
const parses = () => { try { execFileSync("node", ["--check", F], { stdio: "pipe" }); return true; } catch { return false; } };
const call = (a) => tools.edit_symbol.execute("1", { file: F, ...a }, undefined, undefined, ctx);

// --- the exact edit that broke pang.js ------------------------------------
// "add combo decay at the end of play()". Done by line number it landed at
// class-body scope and left an unbalanced brace with no revert.
write();
const r = await call({ symbol: "play", action: "append", text: "if (this.comboTimer > 0) {\n  this.comboTimer -= dt;\n}" });
check("append lands INSIDE the method", !r.isError && /play\(dt\)[\s\S]*comboTimer[\s\S]*currentBombSpeed/.test(read()), read());
check("and the file still parses", parses(), read());
check("the appended block keeps its nesting",
  /\n\s{6}this\.comboTimer -= dt;/.test(read()), read().split("\n").find((l) => l.includes("comboTimer -=")));
check("it is inside play, not after it", read().indexOf("comboTimer") < read().indexOf("currentBombSpeed"));

// --- the other actions ----------------------------------------------------
write();
await call({ symbol: "currentBombSpeed", action: "replace", text: "currentBombSpeed() {\n  return 2;\n}" });
check("replace swaps the whole symbol", /return 2;/.test(read()) && !/return 1;/.test(read()) && parses());

write();
await call({ symbol: "play", action: "prepend", text: "this.frame++;" });
check("prepend goes to the top of the body",
  read().split("\n")[2].includes("this.frame++") && parses(), read().split("\n").slice(1, 4).join(" / "));

write();
await call({ symbol: "currentBombSpeed", action: "after", text: "newMethod() {\n  return 3;\n}" });
check("after inserts a sibling outside the symbol", /newMethod/.test(read()) && parses(), read());

write();
await call({ symbol: "currentBombSpeed", action: "before", text: "// a note" });
check("before inserts above the declaration",
  /\/\/ a note\n\s*currentBombSpeed/.test(read()) && parses());

// --- safety ---------------------------------------------------------------
write();
const broke = await call({ symbol: "play", action: "append", text: "if (x) {" });
check("a syntax-breaking edit is reverted", broke.isError === true && read() === SRC,
  "the file is byte-identical to before");

const missing = await call({ symbol: "nope", action: "append", text: "x;" });
check("an unknown symbol errors", missing.isError === true);
check("and names what IS in the file", /currentBombSpeed/.test(missing.content[0].text),
  "so the next call needs no round trip through outline");

const badAction = await call({ symbol: "play", action: "sideways", text: "x;" });
check("an unknown action errors clearly", badAction.isError === true && /Use replace, append/.test(badAction.content[0].text));

// --- disambiguation -------------------------------------------------------
fs.writeFileSync(F, ["class A {", "  run() { return 1; }", "}", "class B {", "  run() { return 2; }", "}"].join("\n"));
const amb = await call({ symbol: "run", action: "append", text: "x;" });
check("a duplicated name reports ambiguity", amb.isError === true && /appears 2 times/.test(amb.content[0].text), amb.content[0].text);
const qualified = await call({ symbol: "B.run", action: "replace", text: "run() { return 9; }" });
check("Class.method disambiguates", !qualified.isError && /return 9/.test(read()) && /return 1/.test(read()), read());

// --- brace counting must ignore strings and comments ----------------------
fs.writeFileSync(F, ["class C {", "  f() {", '    var s = "}";      // a brace in a string', "    /* } */", "    return s;", "  }", "  g() { return 2; }", "}"].join("\n"));
const tricky = findSymbol(fs.readFileSync(F, "utf8").split("\n"), "f");
check("braces inside strings and comments do not close a block",
  tricky && tricky.start === 2 && tricky.end === 6, JSON.stringify(tricky));
const st = { inBlockComment: false, inTemplate: false };
check("stripNonCode removes string and comment content",
  stripNonCode('var s = "}"; // }', st).includes("var s =") && !stripNonCode('var s = "}"; // }', { inBlockComment: false, inTemplate: false }).includes("}"));

// --- honest refusal on indentation-scoped languages -----------------------
check("python is refused rather than half-handled", !supportsSymbols("a.py") && supportsSymbols("a.js"));
const py = path.join(DIR, "x.py");
fs.writeFileSync(py, "def f():\n    return 1\n");
const pyr = await tools.edit_symbol.execute("2", { file: py, symbol: "f", action: "append", text: "pass" }, undefined, undefined, ctx);
check("and it says what to use instead", pyr.isError === true && /replace_lines/.test(pyr.content[0].text), pyr.content[0].text);

fs.rmSync(DIR, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
