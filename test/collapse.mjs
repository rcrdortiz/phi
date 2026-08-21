import { collapsedLines, resultText, collapsedRenderer } from "../lib/collapse.ts";
import * as fs from "node:fs";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

const outline = "pang.js (1143 lines, 43 declarations)\n 71| class Game {\n 72| constructor(cfg) {\n 80| reset() {";

// --- what gets shown -------------------------------------------------------
check("collapsed keeps the summary line and says what is hidden",
  collapsedLines(outline, false).join("\n") ===
    "pang.js (1143 lines, 43 declarations)\n... (3 more lines, ctrl+o to expand)");
check("expanded shows everything", collapsedLines(outline, true).length === 4);
check("the hint names the key, because that is the whole point",
  /ctrl\+o/.test(collapsedLines(outline, false)[1]));

// Hiding one line behind a hint that costs one line is not a saving.
check("a result one line over the limit is left alone",
  collapsedLines("a\nb", false).join("\n") === "a\nb",
  "\"1 more line, press a key\" reads worse than the line");
check("a single line is left alone", collapsedLines("only", false).join("\n") === "only");
check("an empty result does not produce a hint", collapsedLines("", false).join("") === "");
check("trailing blank lines do not count as hidden content",
  collapsedLines("a\nb\n\n\n", false).join("\n") === "a\nb");

// --- reading the result ----------------------------------------------------
check("text parts are joined", resultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }) === "a\nb");
check("non-text parts are ignored", resultText({ content: [{ type: "image" }, { type: "text", text: "a" }] }) === "a");
check("a malformed result yields nothing rather than throwing", resultText(undefined) === "" && resultText({}) === "");

// --- the renderer ----------------------------------------------------------
const theme = { fg: (role, s) => `<${role}>${s}` };
const component = collapsedRenderer()({ content: [{ type: "text", text: outline }] }, { expanded: false }, theme);
const painted = component.render(80);
check("the renderer returns a component with render()", Array.isArray(painted) && painted.length === 2);
check("the hint is dimmed and the content is not",
  painted[0].startsWith("<toolOutput>") && painted[1].startsWith("<muted>"),
  painted.join(" | "));

// --- wiring ----------------------------------------------------------------
// The point of this is the tools that print a screenful. Attaching it is easy
// to forget when a new one is added, so check the noisy ones by name.
const src = fs.readFileSync(new URL("../extensions/smart-edit.ts", import.meta.url), "utf8");
for (const tool of ["view_lines", "outline", "edit_block", "replace_lines", "edit_symbol"]) {
  const at = src.indexOf(`name: "${tool}"`);
  check(`${tool} collapses`, at !== -1 && src.slice(at, at + 200).includes("collapsedRenderer()"));
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
