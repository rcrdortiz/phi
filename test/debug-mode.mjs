// PHI_DEBUG=1 turns on the logs and turns off the hiding. A debug mode that
// makes you name each thing you wanted, or that collapses the output you asked
// to see, is not one.
import { execFileSync } from "node:child_process";

const results = [];
const check = (l, p, d = "") => { results.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${l}${d ? "\n        " + String(d).replace(/\n/g, "\n        ") : ""}`); };

// A fresh process per case: these are read once at module load, so toggling
// them in-process would test the first value forever.
const probe = (env) =>
  JSON.parse(
    execFileSync(process.execPath, ["-e", `
      Promise.all([import("${new URL("../lib/usage.ts", import.meta.url).pathname}"),
                   import("${new URL("../lib/collapse.ts", import.meta.url).pathname}"),
                   import("${new URL("../lib/debug.ts", import.meta.url).pathname}")])
        .then(([u, c, d]) => console.log(JSON.stringify({
          debug: d.DEBUG,
          usage: u.ENABLED,
          collapsed: c.collapsedLines("a\\nb\\nc\\nd", false).length === 2,
        })));
    `], { encoding: "utf8", env: { ...process.env, PHI_DEBUG: "", PHI_USAGE_LOG: "", PI_COLLAPSE_TOOLS: "", ...env } }),
  );

const off = probe({});
check("by default nothing is recorded", off.usage === false,
  "a project should not accumulate a log nobody asked for");
check("and output is collapsed", off.collapsed === true);

const on = probe({ PHI_DEBUG: "1" });
check("PHI_DEBUG turns the usage log on", on.usage === true);
check("PHI_DEBUG stops hiding tool output", on.collapsed === false,
  "collapsing output while being asked to explain it is the opposite of debugging");
check("and reports itself as on", on.debug === true);

// An explicit setting is a decision; a mode should not silently reverse it.
check("an explicit collapse setting beats debug mode",
  probe({ PHI_DEBUG: "1", PI_COLLAPSE_TOOLS: "1" }).collapsed === true);
check("the usage log can be turned on without the rest",
  probe({ PHI_USAGE_LOG: "1" }).usage === true);
check("and off inside debug mode",
  probe({ PHI_DEBUG: "1", PHI_USAGE_LOG: "0" }).usage === false);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
