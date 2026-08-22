// Phase one acceptance: does the CSV exporter behave?
//
// Run again unchanged after phase two, where it becomes the regression check.
// A design that needed the old behaviour broken to add the new one has failed
// at the thing the phase-two task is actually measuring.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const dir = process.argv[2] ?? ".";
const results = [];
const check = (name, fn) => {
  try {
    const ok = fn();
    results.push({ name, pass: ok === true, detail: ok === true ? "" : String(ok) });
  } catch (e) {
    results.push({ name, pass: false, detail: (e && e.message) || String(e) });
  }
};

let exportRecords;
try {
  const src = fs.readFileSync(path.join(dir, "exporter.js"), "utf8");
  const sandbox = { module: { exports: {} }, exports: {}, console, JSON, String, Number, Array, Object };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { timeout: 5000 });
  exportRecords = sandbox.EXPORTER?.exportRecords ?? sandbox.module?.exports?.exportRecords;
  results.push({ name: "exporter.js loads", pass: typeof exportRecords === "function", detail: typeof exportRecords });
} catch (e) {
  results.push({ name: "exporter.js loads", pass: false, detail: (e && e.message) || String(e) });
}

if (typeof exportRecords === "function") {
  const eq = (got, want) => (got === want ? true : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  check("header then rows", () =>
    eq(exportRecords([{ a: 1, b: 2 }], { columns: ["a", "b"] }), "a,b\n1,2"));
  check("column order is respected", () =>
    eq(exportRecords([{ a: 1, b: 2 }], { columns: ["b", "a"] }), "b,a\n2,1"));
  check("a missing key is empty", () =>
    eq(exportRecords([{ a: 1 }], { columns: ["a", "z"] }), "a,z\n1,"));
  check("null and undefined are empty", () =>
    eq(exportRecords([{ a: null, b: undefined }], { columns: ["a", "b"] }), "a,b\n,"));
  check("a comma forces quoting", () =>
    eq(exportRecords([{ a: "x,y" }], { columns: ["a"] }), 'a\n"x,y"'));
  check("a quote is doubled and forces quoting", () =>
    eq(exportRecords([{ a: 'he said "hi"' }], { columns: ["a"] }), 'a\n"he said ""hi"""'));
  check("a newline forces quoting", () =>
    eq(exportRecords([{ a: "x\ny" }], { columns: ["a"] }), 'a\n"x\ny"'));
  check("a plain value is not quoted", () =>
    eq(exportRecords([{ a: "plain" }], { columns: ["a"] }), "a\nplain"));
  check("header:false omits the header", () =>
    eq(exportRecords([{ a: 1 }], { columns: ["a"], header: false }), "1"));
  check("booleans and numbers stringify", () =>
    eq(exportRecords([{ a: true, b: 0 }], { columns: ["a", "b"] }), "a,b\ntrue,0"));
  check("limit truncates", () =>
    eq(exportRecords([{ a: 1 }, { a: 2 }, { a: 3 }], { columns: ["a"], limit: 2 }), "a\n1\n2"));
  check("no trailing newline", () =>
    exportRecords([{ a: 1 }], { columns: ["a"] }).endsWith("1") || "trailing whitespace");
  check("an empty record set is just the header", () =>
    eq(exportRecords([], { columns: ["a"] }), "a"));
}

const passed = results.filter((r) => r.pass).length;
process.stdout.write(JSON.stringify({ passed, total: results.length, results }, null, 2));
