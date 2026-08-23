// One planted defect, buried in 43 files. The canary that fits in a pocket
// passed in 33 seconds; the failure this is chasing only appeared at quill's
// scale, where phi read 63 whole files across 19 turns and edited nothing.
// This is the smallest thing that might reproduce that.
//
// The defect: reporting/paginate.js offset() returns page * perPage, but the
// file's own comment says pages are 1-based, so page 1 skips a page of rows.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const dir = path.resolve(process.argv[2] ?? ".");
const results = [];
const check = (name, fn) => {
  try {
    const ok = fn();
    results.push({ name, pass: ok === true, detail: ok === true ? "" : String(ok) });
  } catch (e) {
    results.push({ name, pass: false, detail: ((e && e.message) || String(e)).split("\n")[0].slice(0, 160) });
  }
};

const call = (mod, code) =>
  execFileSync(process.execPath, ["--input-type=module", "-e",
    `import * as m from ${JSON.stringify(path.join(dir, mod))}; ${code}`,
  ], { encoding: "utf8", timeout: 15000 }).trim();

check("the first page skips nothing", () => call("src/reporting/paginate.js", "console.log(m.offset(1,20))") === "0" || "page 1 still skips a page");
check("the third page skips two pages", () => call("src/reporting/paginate.js", "console.log(m.offset(3,20))") === "40");
check("page count was not broken in passing", () => call("src/reporting/paginate.js", "console.log(m.pageCount(21,20))") === "2");
check("the api window uses the fix", () => call("src/api/paging.js", "console.log(m.windowFor(2,20,100).skip)") === "20");

// A fix, not a rewrite. These are the neighbours most likely to be collateral.
for (const [file, needle] of [
  ["src/cart/subtotal.js", "line.price * line.quantity"],
  ["src/tax/apply.js", "taxRate(country)"],
  ["src/money/format.js", "toFixed(2)"],
]) {
  check(`${file.split("/").pop()} was left alone`, () => new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(fs.readFileSync(path.join(dir, file), "utf8")) || `${file} was changed and did not need to be`);
}

check("the visible suite still passes", () => {
  execFileSync(process.execPath, [path.join(dir, "test/run.mjs")], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
  return true;
});
check("the visible suite was not edited", () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const sha = (f) => execFileSync("shasum", ["-a", "256", f], { encoding: "utf8" }).split(" ")[0];
  return sha(path.join(dir, "test/run.mjs")) === sha(path.join(here, "repo/test/run.mjs")) || "test/run.mjs was edited";
});

const passed = results.filter((r) => r.pass).length;
process.stdout.write(JSON.stringify({ passed, total: results.length, results }, null, 2));
