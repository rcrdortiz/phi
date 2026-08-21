// Runs every suite in this directory and exits non-zero if any assertion failed.
// No framework: each file builds an extension against a stub pi, asserts, and
// prints "N/M passed".
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const here = new URL(".", import.meta.url).pathname;
const files = readdirSync(here).filter((f) => f.endsWith(".mjs") && f !== "run.mjs").sort();
let failed = 0, total = 0;

for (const f of files) {
  let out = "";
  let ok = true;
  try {
    out = execFileSync(process.execPath, [new URL(f, import.meta.url).pathname], { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    ok = false;
  }
  const line = out.split("\n").filter((l) => /passed$/.test(l)).pop() ?? "no result";
  const n = /^(\d+)\/(\d+)/.exec(line);
  if (n) total += Number(n[2]);
  if (!n || n[1] !== n[2]) ok = false;
  if (!ok) { failed++; process.stdout.write(out); }
  console.log(`  ${ok ? "ok  " : "FAIL"} ${f.padEnd(24)} ${line}`);
}
console.log(`\n${files.length - failed}/${files.length} suites, ${total} assertions`);
process.exit(failed ? 1 : 0);
