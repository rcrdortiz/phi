// Did the harness actually try to find and fix a bug?
//
// Small on purpose. This is not a quality benchmark, it is a canary: three of
// four phi runs on quill scored exactly the untouched-repo baseline, and one of
// them made zero edit calls in seventeen minutes. A task that takes an hour
// cannot answer why. This one takes a minute, so it can be run repeatedly with
// one customisation switched off at a time.
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

const src = () => fs.readFileSync(path.join(dir, "src/cart.js"), "utf8");

/** Import the repo's module fresh and call into it. */
const run = (code) =>
  execFileSync(process.execPath, ["--input-type=module", "-e",
    `import {subtotal, discount, format} from ${JSON.stringify(path.join(dir, "src/cart.js"))}; ${code}`,
  ], { encoding: "utf8", timeout: 15000 }).trim();

// The one that matters: the loop drops the last item.
check("subtotal counts every item", () => run("console.log(subtotal([{price:1},{price:2}]))") === "3" || "still drops the last item");
check("subtotal of one item is that item", () => run("console.log(subtotal([{price:5}]))") === "5" || "returns 0 for a single item");
check("subtotal of an empty cart is zero", () => run("console.log(subtotal([]))") === "0");

// The edit has to be a fix, not a rewrite of everything in sight.
check("discount was left alone", () => /amount - \(amount \* percent\) \/ 100/.test(src()) || "discount was changed and did not need to be");
check("format was left alone", () => /amount\.toFixed\(2\)/.test(src()) || "format was changed and did not need to be");

// The visible suite must still pass: a fix that breaks what worked is not a fix.
check("the visible suite still passes", () => {
  execFileSync(process.execPath, [path.join(dir, "test/run.mjs")], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
  return true;
});

// And the tests themselves must be untouched, or the fix is fiction.
check("the visible suite was not edited", () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const want = execFileSync("shasum", ["-a", "256", path.join(here, "repo/test/run.mjs")], { encoding: "utf8" }).split(" ")[0];
  const got = execFileSync("shasum", ["-a", "256", path.join(dir, "test/run.mjs")], { encoding: "utf8" }).split(" ")[0];
  return got === want || "test/run.mjs was edited";
});

const passed = results.filter((r) => r.pass).length;
process.stdout.write(JSON.stringify({ passed, total: results.length, results }, null, 2));
