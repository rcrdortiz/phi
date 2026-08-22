// Phase two acceptance: the new format, and the old one still intact.
//
// Two halves, deliberately. Adding a format is the easy half. Not breaking the
// one that was there is the half that separates a design with seams from one
// without, and it is why phase one's suite is re-run here rather than retired.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const dir = process.argv[2] ?? ".";
const here = path.dirname(new URL(import.meta.url).pathname);
const results = [];
const check = (name, fn) => {
  try {
    const ok = fn();
    results.push({ name, pass: ok === true, detail: ok === true ? "" : String(ok) });
  } catch (e) {
    results.push({ name, pass: false, detail: (e && e.message) || String(e) });
  }
};

// The regression half: phase one's suite, unchanged.
let regressed = 0;
try {
  const prior = JSON.parse(execFileSync(process.execPath, [path.join(here, "verify1.mjs"), dir], { encoding: "utf8" }));
  regressed = prior.total - prior.passed;
  for (const r of prior.results) results.push({ ...r, name: `csv still: ${r.name}` });
} catch (e) {
  results.push({ name: "csv still works", pass: false, detail: (e && e.message) || String(e) });
  regressed = 1;
}

let exportRecords;
try {
  const src = fs.readFileSync(path.join(dir, "exporter.js"), "utf8");
  const sandbox = { module: { exports: {} }, exports: {}, console, JSON, String, Number, Array, Object };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { timeout: 5000 });
  exportRecords = sandbox.EXPORTER?.exportRecords ?? sandbox.module?.exports?.exportRecords;
} catch {
  /* phase one's suite has already reported the load failure */
}

if (typeof exportRecords === "function") {
  const jsonl = (recs, opts) => exportRecords(recs, { format: "jsonl", ...opts });
  const eq = (got, want) => (got === want ? true : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  check("jsonl writes one object per line", () =>
    eq(jsonl([{ a: 1 }, { a: 2 }], { columns: ["a"] }), '{"a":1}\n{"a":2}'));
  check("jsonl keeps only the named columns, in order", () =>
    eq(jsonl([{ b: 2, a: 1, c: 3 }], { columns: ["a", "b"] }), '{"a":1,"b":2}'));
  check("jsonl omits missing keys entirely", () =>
    eq(jsonl([{ a: 1, b: null }], { columns: ["a", "b"] }), '{"a":1}'));
  check("jsonl omits undefined too", () =>
    eq(jsonl([{ a: undefined, b: 1 }], { columns: ["a", "b"] }), '{"b":1}'));
  check("jsonl respects limit", () =>
    eq(jsonl([{ a: 1 }, { a: 2 }, { a: 3 }], { columns: ["a"], limit: 1 }), '{"a":1}'));
  check("jsonl ignores header", () =>
    eq(jsonl([{ a: 1 }], { columns: ["a"], header: true }), '{"a":1}'));
  check("jsonl escapes as JSON does", () =>
    eq(jsonl([{ a: 'x"y' }], { columns: ["a"] }), '{"a":"x\\"y"}'));
  check("jsonl has no trailing newline", () =>
    jsonl([{ a: 1 }], { columns: ["a"] }).endsWith("}") || "trailing whitespace");
  check("an absent format still means csv", () =>
    eq(exportRecords([{ a: 1 }], { columns: ["a"] }), "a\n1"));
  check("csv asked for by name still works", () =>
    eq(exportRecords([{ a: 1 }], { columns: ["a"], format: "csv" }), "a\n1"));
}

const passed = results.filter((r) => r.pass).length;
process.stdout.write(JSON.stringify({ passed, total: results.length, regressed, results }, null, 2));
