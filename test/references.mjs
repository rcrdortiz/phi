// The feature exists to stop phi regressing work it cannot see. These tests are
// mostly about the two ways it could fail quietly: hiding a hint that mattered,
// and drowning a real hint in noise.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callersNote, declarationCount, enclosingSymbol, findCallers, symbolName, MAX_DECLARATIONS } from "../lib/references.ts";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

// --- naming ----------------------------------------------------------------
check("a php method yields its own name, not the keyword",
  symbolName("    public function renderTag($t) {") === "renderTag");
check("an exported ts function", symbolName("export function findCallers(a) {") === "findCallers");
check("an arrow assigned to a const", symbolName("const Paginator = (x) => {") === "Paginator");
check("a class", symbolName("class RowMapper {") === "RowMapper");
check("a control structure declares nothing", symbolName("for (let i = 0; i < n; i++) {") === undefined,
  "a loop matched as a declaration is how outline once reported 79 of them");

// --- a real tree -----------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phi-refs-"));
fs.mkdirSync(path.join(dir, "src/Query"), { recursive: true });
fs.mkdirSync(path.join(dir, "src/Http"), { recursive: true });
fs.writeFileSync(path.join(dir, "src/Query/Paginator.php"),
  "<?php\nclass Paginator {\n  public function offset(): int { return $this->page * $this->per; }\n  public function limit(): int { return $this->per; }\n}\n");
fs.writeFileSync(path.join(dir, "src/Query/QueryBuilder.php"),
  "<?php\nclass QueryBuilder {\n  private ?int $offset = null;\n  public function apply($p) { $this->offset = $p->offset(); }\n}\n");
fs.writeFileSync(path.join(dir, "src/Http/Controller.php"),
  "<?php\n// offset is mentioned in this comment only\nclass Controller {}\n");

const callers = findCallers(dir, "offset", "src/Query/Paginator.php");
check("finds a reference in another file", callers.some((c) => c.file.endsWith("QueryBuilder.php")),
  JSON.stringify(callers));
check("does not report the file being edited",
  !callers.some((c) => c.file.endsWith("Paginator.php")), JSON.stringify(callers));
check("a comment-only mention is not a caller",
  !callers.some((c) => c.file.endsWith("Controller.php")), JSON.stringify(callers));
check("the actual call ranks above a property of the same name",
  /\$p->offset\(\)/.test(callers[0]?.text ?? ""), callers.map((c) => c.text).join(" | "));

const lines = fs.readFileSync(path.join(dir, "src/Query/Paginator.php"), "utf8").split("\n");
check("a line inside a method is anchored to that method",
  enclosingSymbol(lines, "Paginator.php", 3)?.name === "offset",
  JSON.stringify(enclosingSymbol(lines, "Paginator.php", 3)));
check("a later line anchors to the later method",
  enclosingSymbol(lines, "Paginator.php", 4)?.name === "limit",
  JSON.stringify(enclosingSymbol(lines, "Paginator.php", 4)));

// --- what gets suppressed --------------------------------------------------
check("a magic method is suppressed however many hits it has",
  callersNote([{ file: "a.php", line: 1, text: "new Thing()" }], "__construct", 1) === undefined,
  "32 unrelated constructors is the noise that trains you to skip the hint");
check("an interface method with several implementations is NOT suppressed",
  callersNote([{ file: "a.php", line: 1, text: "$r->render($a)" }], "render", 5) !== undefined,
  "render is declared 5 times in quill and is the phase 3 task; hiding it hides the answer");
check("the backstop still fires for something genuinely ubiquitous",
  callersNote([{ file: "a.php", line: 1, text: "x()" }], "whatever", MAX_DECLARATIONS) === undefined);
check("nothing to say stays quiet", callersNote([], "offset", 1) === undefined,
  "an edit with no callers should not grow a section saying so");

const note = callersNote([{ file: "src/Query/QueryBuilder.php", line: 35, text: "$this->offset = $p->offset();" }], "offset", 1);
check("the note says what to do, not just what exists", /Check these still hold/.test(note ?? ""), note);
check("the note carries file and line", /QueryBuilder\.php:35/.test(note ?? ""), note);

check("declarationCount counts declarations, not mentions",
  declarationCount(dir, "Paginator") === 1, String(declarationCount(dir, "Paginator")));

// A symbol too short or odd to be worth searching must not run a repo-wide grep
// whose every hit would be a false positive.
check("a one-letter name is not searched", findCallers(dir, "x").length === 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
