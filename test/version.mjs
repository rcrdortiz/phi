// Version discipline is only worth anything if it cannot silently lapse.
import * as fs from "node:fs";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const changelog = fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

check("the version is semver", /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version);
check("the shipped version has a changelog entry",
  new RegExp(`^## ${pkg.version.replace(/\./g, "\\.")}( |$)`, "m").test(changelog),
  "a release nobody can read is not a release");
check("there is somewhere to write the next one",
  /^## Unreleased$/m.test(changelog));
check("release is a script, not a remembered sequence of commands",
  typeof pkg.scripts?.release === "string");

// The boot box reads the version from package.json rather than carrying its
// own copy, so there is exactly one number to bump.
const boot = fs.readFileSync(new URL("../extensions/boot-screen.ts", import.meta.url), "utf8");
check("the boot box reads the version from package.json",
  /package\.json/.test(boot) && !new RegExp(`["'\`]${pkg.version.replace(/\./g, "\\.")}["'\`]`).test(boot),
  "a second copy is a second thing to forget");

// Entries above Unreleased must be dated, so "when did this land" is answerable.
const released = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)(.*)$/gm)];
check("released entries carry a date",
  released.length > 0 && released.slice(0, -1).every(([, , rest]) => /\(\d{4}-\d{2}-\d{2}\)/.test(rest)),
  released.map(([, v, r]) => v + r).join(", "));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
